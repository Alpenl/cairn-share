import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
async function request(path: string, body?: unknown, db=env.DB, method="POST", token="internal") {
  return worker.fetch(new Request(`https://test.example/api/${path}`, {
    method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:body===undefined ? undefined : JSON.stringify(body)
  }),{DB:db,ENRICHMENT_IMAGES:env.ENRICHMENT_IMAGES,CAIRN_API_TOKEN:"app",CAIRN_ENRICHER_TOKEN:"internal"});
}
async function setup() {
  const created = await request("links",{url:"https://x.com/synthetic/status/123"},env.DB,"POST","app");
  const {id} = await created.json() as {id:number};
  await env.DB.prepare("UPDATE links SET original_text='synthetic body' WHERE id=?").bind(id).run();
  const identity = await append(id);
  return {id,body:{...identity,operation_key:`entity-${id}`,state:"completed_nonempty",entities:["AcmeEntity"]}};
}
async function append(id:number, text="context") {
  expect((await request(`v2/links/${id}/evidence`,{snapshot:{
    blocks:[{id:"real-primary",role:"primary",text:"synthetic body"},{id:"quoted-9",role:"quoted",text}],
    retrieval:"manual",fetched_at:"2026-09-22T00:00:00Z",truncation:{truncated:false}
  }})).status).toBe(200);
  const snapshot = await (await request(`v2/links/${id}/evidence`,undefined,env.DB,"GET")).json() as {id:number;content_revision:number;content_hash:string};
  return {evidence_snapshot_id:snapshot.id,content_revision:snapshot.content_revision,content_hash:snapshot.content_hash};
}
function beforeBatch(action:()=>Promise<void>) {
  let called=false;
  return new Proxy(env.DB,{get(target,property){
    if(property==="batch") return async (statements:D1PreparedStatement[])=>{
      if(!called){called=true;await action();} return target.batch(statements);
    };
    const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
  }});
}
async function entities(id:number) {
  return (await request(`v2/links/${id}/entities`,undefined,env.DB,"GET")).json() as Promise<{state:string;stale:boolean;entities:string[];automatic:string[]}>;
}
it("R3-09 rejects snapshot/hash mismatches and content changed after preflight without a receipt",async()=>{
  const {id,body}=await setup();
  expect((await request(`v2/links/${id}/entity-state`,{...body,content_hash:"0".repeat(64)})).status).toBe(409);
  const db=beforeBatch(async()=>{await append(id,"new revision");});
  expect((await request(`v2/links/${id}/entity-state`,body,db)).status).toBe(409);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM entity_operations").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM entity_states").first("n")).toBe(0);
});
it("R3-09 preserves same-revision successes including empty; a new revision may report failure",async()=>{
  const {id,body}=await setup();
  for(const [index,state] of ["completed_nonempty","completed_empty"].entries()) {
    expect((await request(`v2/links/${id}/entity-state`,{...body,operation_key:`success-${index}`,state,entities:index?[]:body.entities})).status).toBe(200);
    for(const failState of ["failed","not_run"]) {
      const response=await request(`v2/links/${id}/entity-state`,{...body,operation_key:`failure-${index}-${failState}`,state:failState,entities:[]});
      expect((await response.json() as {status:string}).status).toBe("ignored_stale");
      expect((await entities(id)).state).toBe(state);
    }
  }
  const newer=await append(id,"newer source");
  expect((await request(`v2/links/${id}/entity-state`,{...body,...newer,operation_key:"new-failure",state:"failed",entities:[]})).status).toBe(200);
  expect((await entities(id)).state).toBe("failed");
});
it("R3-09 exact lost-response replay survives newer results and never reapplies an old state",async()=>{
  const {id,body}=await setup();
  const db=beforeBatch(async()=>{
    expect((await request(`v2/links/${id}/entity-state`,body)).status).toBe(200);
    expect((await request(`v2/links/${id}/entity-state`,{...body,operation_key:"newer",entities:["LaterEntity"]})).status).toBe(200);
  });
  expect((await request(`v2/links/${id}/entity-state`,body,db)).status).toBe(200);
  expect((await entities(id)).entities).toEqual(["LaterEntity"]);
  expect((await request(`v2/links/${id}/entity-state`,{...body,entities:["changed"]})).status).toBe(409);
  await append(id,"changed material");
  const replay=await request(`v2/links/${id}/entity-state`,body);
  expect((await replay.json() as {replayed:boolean}).replayed).toBe(true);
  const stale=await entities(id);
  expect(stale.stale).toBe(true);expect(stale.entities).toEqual([]);expect(stale.automatic).toEqual([]);
});
it("R3-09 search and cached projection follow entity accept/reject/reset/set-empty and source staleness",async()=>{
  const {id,body}=await setup();
  expect((await request(`v2/links/${id}/entity-state`,body)).status).toBe(200);
  const actions=[null,["reject","AcmeEntity"],["reset","AcmeEntity"],["set_empty",""],
    ["reset","AcmeEntity"],["accept","HumanEntity"],["reject","HumanEntity"],["reset",""],
    ["accept","HumanEntity"]];
  for(const [index,action] of actions.entries()) {
    if(action) expect((await request(`v2/links/${id}/entities`,{operation_key:`human-${index}`,action:action[0],term:action[1]})).status).toBe(200);
    const effective=(await entities(id)).entities;
    const cached=await env.DB.prepare("SELECT effective FROM current_projections WHERE link_id=?").bind(id).first<string>("effective");
    expect(JSON.parse(cached!).entities.sort()).toEqual([...effective].sort());
    const sql=await env.DB.prepare("SELECT term FROM effective_entity_terms WHERE link_id=? ORDER BY term").bind(id).all<{term:string}>();
    expect(sql.results.map(row=>row.term)).toEqual([...effective].sort());
    for(const term of ["AcmeEntity","HumanEntity"]) {
      const response=await request(`enrichment/jobs?q=${term}`,undefined,env.DB,"GET");
      const result=await response.json() as {items:Array<{id:number}>};
      expect(result.items.some(row=>row.id===id)).toBe(effective.includes(term));
    }
  }
  await append(id,"changed material");
  expect((await entities(id)).entities).toEqual(["HumanEntity"]);
  const rows=await env.DB.prepare("SELECT term FROM effective_entity_terms WHERE link_id=?").bind(id).all<{term:string}>();
  expect(rows.results.map(row=>row.term)).toEqual(["HumanEntity"]);
});

it("R3-09 deletion removes entity receipts and bound snapshots together",async()=>{
  const {id,body}=await setup();
  expect((await request(`v2/links/${id}/entity-state`,body)).status).toBe(200);
  expect((await request(`links/${id}`,undefined,env.DB,"DELETE","app")).status).toBe(204);
  for(const table of ["entity_operations","entity_states","evidence_snapshots"]) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE link_id=?`).bind(id).first("n")).toBe(0);
  }
});
