import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
async function call(path: string, body?: unknown, db=env.DB, method="POST", token="internal") {
 return worker.fetch(new Request(`https://test.example/api/${path}`,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),
 {DB:db,ENRICHMENT_IMAGES:env.ENRICHMENT_IMAGES,CAIRN_API_TOKEN:"app",CAIRN_ENRICHER_TOKEN:"internal"});
}
async function setup(already=false) {
 const created=await call("links",{url:"https://x.com/fixture/status/600"},env.DB,"POST","app");
 const {id}=await created.json() as {id:number};
 const url="https://allowed.example/article";
 await env.DB.prepare("UPDATE links SET original_text='Primary objective source' WHERE id=?").bind(id).run();
 await env.DB.prepare("INSERT INTO enrichment_sources(link_id,url,original_text,payload,fetched_at) VALUES (?,?,?,?,?)")
 .bind(id,"https://x.com/fixture/status/600","Primary objective source",JSON.stringify({original_text:"Primary objective source",related_links:[url]}),"2026-09-22").run();
 const blocks=[{id:"custom-primary",role:"primary",text:"Primary objective source",relation:"authored",acquired:"fetch"},
 {id:"quote-custom",role:"quoted",text:"Quoted source, not primary",relation:"quoted author",acquired:"archive"}];
 if(already) blocks.push({id:"not-an-external-prefix",role:"external_article",text:"Fetched external material",relation:"linked article",acquired:"prior",...{url}});
 const snapshot={blocks,fetched_at:"2026-09-22T00:00:00Z",retrieval:"archive",truncation:{truncated:false}};
 expect((await call(`v2/links/${id}/evidence`,{snapshot})).status).toBe(200);
 await env.DB.prepare("UPDATE classification_jobs SET status='completed' WHERE link_id=?").bind(id).run();
 const source=await env.DB.prepare("SELECT id,content_revision,content_hash FROM evidence_snapshots WHERE link_id=?").bind(id).first<{id:number;content_revision:number;content_hash:string}>();
 const job=await env.DB.prepare("SELECT revision FROM classification_jobs WHERE link_id=?").bind(id).first<{revision:number}>();
 const body={protocol:1,scope:"external_link",dedupe_key:"evidence-fixture",url,budget:{max_bytes:200000,timeout_ms:15000},
 evidence_snapshot_id:source!.id,source_hash:source!.content_hash,content_revision:source!.content_revision,target_generation:0};
 const outcome={state:"completed",url,text:"Fetched external material",truncated:false};
 const archived=await (await call(`v2/links/${id}/evidence`,undefined,env.DB,"GET")).json() as {snapshot:typeof snapshot};
 return {id,body,outcome,snapshot:archived.snapshot,jobRevision:job!.revision};
}
async function ready() {
 const f=await setup();
 const created=await call(`v2/links/${f.id}/evidence-requests`,f.body);
 expect(created.status).toBe(200);
 const {id}=await created.json() as {id:string};
 expect((await call(`v2/evidence-requests/${id}/claim`,{owner_token:"owner"})).status).toBe(200);
 const saved=await call(`v2/evidence-requests/${id}/checkpoint`,{owner_token:"owner",outcome:f.outcome});
 expect(saved.status).toBe(200);
 const {checkpoint_hash}=await saved.json() as {checkpoint_hash:string};
 return {...f,requestID:id,checkpoint_hash};
}
function beforeBatch(action:()=>Promise<void>) {
 let once=false;
 return new Proxy(env.DB,{get(target,property){
  if(property==="batch")return async(statements:D1PreparedStatement[])=>{if(!once){once=true;await action();}return target.batch(statements);};
  const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
 }});
}
async function unchanged(id:number,revision:number,jobRevision:number) {
 expect(await env.DB.prepare("SELECT content_revision FROM links WHERE id=?").bind(id).first("content_revision")).toBe(revision);
 expect(await env.DB.prepare("SELECT revision FROM classification_jobs WHERE link_id=?").bind(id).first("revision")).toBe(jobRevision);
 expect(await env.DB.prepare("SELECT COUNT(*) FROM evidence_snapshots WHERE link_id=?").bind(id).first("COUNT(*)")).toBe(1);
}

it("R3-06: concurrent creation and claims yield one durable owner, with exact replay",async()=>{
 const {id,body,outcome}=await setup();
 const created=await Promise.all([call(`v2/links/${id}/evidence-requests`,body),call(`v2/links/${id}/evidence-requests`,body)]);
 const a=await created[0].json() as {id:string};const b=await created[1].json() as {id:string};
 expect(created.map(r=>r.status)).toEqual([200,200]);expect(a.id).toBe(b.id);
 const claims=await Promise.all([call(`v2/evidence-requests/${a.id}/claim`,{owner_token:"a"}),call(`v2/evidence-requests/${a.id}/claim`,{owner_token:"b"})]);
 const views=await Promise.all(claims.map(r=>r.json())) as Array<{owned:boolean;owner_token:string|null;attempts:number}>;
 expect(views.filter(v=>v.owned)).toHaveLength(1);expect(views.every(v=>v.attempts===1)).toBe(true);
 expect(views.find(v=>!v.owned)!.owner_token).toBeNull();
 const owner=views.find(v=>v.owned)!.owner_token;
 const again=await (await call(`v2/evidence-requests/${a.id}/claim`,{owner_token:owner})).json();
 expect(again).toMatchObject({owned:true,attempts:1});
 expect((await call(`v2/evidence-requests/${a.id}`,{status:"completed"})).status).toBe(409);
 expect((await call(`v2/evidence-requests/${a.id}/checkpoint`,{owner_token:"intruder",outcome})).status).toBe(409);
 const saved=await call(`v2/evidence-requests/${a.id}/checkpoint`,{owner_token:owner,outcome});expect(saved.status).toBe(200);
 expect((await call(`v2/evidence-requests/${a.id}/checkpoint`,{owner_token:owner,outcome})).status).toBe(200);
 expect((await call(`v2/evidence-requests/${a.id}/checkpoint`,{owner_token:owner,outcome:{...outcome,text:"changed"}})).status).toBe(409);
});

it("R3-06: bound intent rejects changed scope, budget, URL and input under the same key",async()=>{
 const {id,body}=await setup();expect((await call(`v2/links/${id}/evidence-requests`,body)).status).toBe(200);
 for(const patch of [{url:"https://allowed.example/other"},{budget:{...body.budget,max_bytes:2}},{content_revision:body.content_revision+1},{target_generation:1}]) {
  expect((await call(`v2/links/${id}/evidence-requests`,{...body,...patch})).status).toBe(409);
 }
 expect((await call(`v2/links/${id}/evidence-requests`,{...body,dedupe_key:"unstored-url",url:"https://allowed.example/unlisted"})).status).toBe(409);
 expect((await call(`v2/links/${id}/evidence-requests`,{...body,budget:{max_bytes:999999999,timeout_ms:15000}})).status).toBe(400);
 expect((await call("v2/evidence-requests/recoverable?limit=21",undefined,env.DB,"GET")).status).toBe(400);
 expect((await call("v2/evidence-requests/recoverable",undefined,env.DB,"GET","app")).status).toBe(401);
});

it("R3-06: finalize appends exact archival blocks and requeues once; repeat confirms receipt",async()=>{
 const f=await ready();const endpoint=`v2/evidence-requests/${f.requestID}/finalize`;const body={checkpoint_hash:f.checkpoint_hash};
 const first=await call(endpoint,body);expect(first.status).toBe(200);const receipt=await first.json();expect(receipt).toMatchObject({changed:true,requeued:true});
 expect(await (await call(endpoint,body)).json()).toEqual(receipt);
 const source=await (await call(`v2/links/${f.id}/evidence`,undefined,env.DB,"GET")).json() as {snapshot:typeof f.snapshot;content_revision:number};
 expect(source.snapshot.blocks.slice(0,2)).toEqual(f.snapshot.blocks);
 expect(source.snapshot.blocks[2]).toMatchObject({role:"external_article",text:f.outcome.text,url:f.outcome.url});
 expect(source.content_revision).toBe(f.body.content_revision+1);
 expect(await env.DB.prepare("SELECT revision FROM classification_jobs WHERE link_id=?").bind(f.id).first("revision")).toBe(f.jobRevision+1);
 expect(await env.DB.prepare("SELECT status FROM classification_jobs WHERE link_id=?").bind(f.id).first("status")).toBe("pending");
 const list=await (await call("v2/evidence-requests/recoverable",undefined,env.DB,"GET")).json();expect(list).toEqual({requests:[]});
 expect((await call(`links/${f.id}`,undefined,env.DB,"DELETE","app")).status).toBe(204);
 expect(await env.DB.prepare("SELECT COUNT(*) FROM evidence_requests").first("COUNT(*)")).toBe(0);
});

it.each(["content","target","busy"])("R3-06: %s changes after final preflight cannot append or requeue",async change=>{
 const f=await ready();const db=beforeBatch(async()=>{
  if(change==="content")await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=?").bind(f.id).run();
  else if(change==="target")await env.DB.prepare("UPDATE classification_target_state SET generation=generation+1 WHERE id=1").run();
  else await env.DB.prepare("UPDATE classification_jobs SET status='processing',lease_until='2099-01-01' WHERE link_id=?").bind(f.id).run();
 });
 const response=await call(`v2/evidence-requests/${f.requestID}/finalize`,{checkpoint_hash:f.checkpoint_hash},db);
 expect(response.status).toBe(change==="busy"?409:200);
 if(change!=="busy")expect(await response.json()).toMatchObject({status:"rejected",changed:false,requeued:false});
 await unchanged(f.id,f.body.content_revision+(change==="content"?1:0),f.jobRevision);
 if(change==="busy") {
  await env.DB.prepare("UPDATE classification_jobs SET status='completed',lease_until=NULL WHERE link_id=?").bind(f.id).run();
  expect((await call(`v2/evidence-requests/${f.requestID}/finalize`,{checkpoint_hash:f.checkpoint_hash})).status).toBe(200);
 }
});

it("R3-06: an SQL failure rolls back source and queue; checkpoint recovers without another claim",async()=>{
 const f=await ready();
 await env.DB.prepare(`CREATE TRIGGER reject_evidence_finish BEFORE UPDATE ON evidence_requests WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'fixture finalize failure'); END`).run();
 await expect(call(`v2/evidence-requests/${f.requestID}/finalize`,{checkpoint_hash:f.checkpoint_hash})).rejects.toThrow("fixture finalize failure");
 await unchanged(f.id,f.body.content_revision,f.jobRevision);
 expect(await env.DB.prepare("SELECT status FROM evidence_requests WHERE id=?").bind(f.requestID).first("status")).toBe("checkpointed");
 await env.DB.prepare("DROP TRIGGER reject_evidence_finish").run();
 expect((await call(`v2/evidence-requests/${f.requestID}/finalize`,{checkpoint_hash:f.checkpoint_hash})).status).toBe(200);
 expect(await env.DB.prepare("SELECT attempts FROM evidence_requests WHERE id=?").bind(f.requestID).first("attempts")).toBe(1);
});

it("R3-06: interrupted ownership has a finite attempt budget, and late owners cannot checkpoint",async()=>{
 const {id,body,outcome}=await setup();const req=await (await call(`v2/links/${id}/evidence-requests`,body)).json() as {id:string};
 for(const owner of ["first","second"]) {
  expect(await (await call(`v2/evidence-requests/${req.id}/claim`,{owner_token:owner})).json()).toMatchObject({owned:true});
  await env.DB.prepare("UPDATE evidence_requests SET lease_until='2000-01-01' WHERE id=?").bind(req.id).run();
 }
 expect((await call(`v2/evidence-requests/${req.id}/checkpoint`,{owner_token:"first",outcome})).status).toBe(409);
 expect(await (await call(`v2/evidence-requests/${req.id}/claim`,{owner_token:"third"})).json()).toMatchObject({owned:false,status:"failed",attempts:2});
 expect(await (await call("v2/evidence-requests/recoverable",undefined,env.DB,"GET")).json()).toEqual({requests:[]});
});

it("R3-06: already archived exact external material is a no-op even with a custom block ID",async()=>{
 const f=await setup(true);const {id}=await (await call(`v2/links/${f.id}/evidence-requests`,f.body)).json() as {id:string};
 await call(`v2/evidence-requests/${id}/claim`,{owner_token:"owner"});
 const {checkpoint_hash}=await (await call(`v2/evidence-requests/${id}/checkpoint`,{owner_token:"owner",outcome:f.outcome})).json() as {checkpoint_hash:string};
 expect(await (await call(`v2/evidence-requests/${id}/finalize`,{checkpoint_hash})).json()).toMatchObject({status:"completed",changed:false,requeued:false});
 await unchanged(f.id,f.body.content_revision,f.jobRevision);
});


it("R3-06: migration never auto-executes legacy pending requests",async()=>{
 await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(0,env.TEST_MIGRATIONS.findIndex(m=>m.name.startsWith("0022_"))));
 const {id}=await setup();
 await env.DB.prepare("INSERT INTO evidence_requests(id,link_id,content_revision,scope,status,budget,dedupe_key,created_at) VALUES ('legacy',?,1,'external_link','pending','{}','legacy','2026-09-22')").bind(id).run();
 await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);
 expect(await (await call("v2/evidence-requests/recoverable",undefined,env.DB,"GET")).json()).toEqual({requests:[]});
 expect((await call("v2/evidence-requests/legacy/claim",{owner_token:"new-owner"})).status).toBe(409);
 expect((await call("v2/evidence-requests/legacy",{status:"blocked",result:{reason:"legacy metadata only"}})).status).toBe(200);
});


it("R3-06: an archive at its block limit keeps old material and closes the request as blocked",async()=>{
 const f=await setup();
 const blocks=[...f.snapshot.blocks,...Array.from({length:62},(_,i)=>({id:`extra-${i}`,role:"quoted",text:"Archived source"}))];
 expect((await call(`v2/links/${f.id}/evidence`,{snapshot:{...f.snapshot,blocks,fetched_at:"2026-09-22"}})).status).toBe(200);
 const source=await env.DB.prepare("SELECT id,content_revision,content_hash FROM evidence_snapshots WHERE link_id=? ORDER BY id DESC LIMIT 1").bind(f.id).first<{id:number;content_revision:number;content_hash:string}>();
 const body={...f.body,evidence_snapshot_id:source!.id,content_revision:source!.content_revision,source_hash:source!.content_hash};
 const {id}=await (await call(`v2/links/${f.id}/evidence-requests`,body)).json() as {id:string};
 await call(`v2/evidence-requests/${id}/claim`,{owner_token:"owner"});
 const {checkpoint_hash}=await (await call(`v2/evidence-requests/${id}/checkpoint`,{owner_token:"owner",outcome:f.outcome})).json() as {checkpoint_hash:string};
 const finalized=await call(`v2/evidence-requests/${id}/finalize`,{checkpoint_hash});expect(finalized.status).toBe(200);
 expect(await finalized.json()).toMatchObject({status:"blocked",changed:false,requeued:false});
 expect(await env.DB.prepare("SELECT content_revision FROM links WHERE id=?").bind(f.id).first("content_revision")).toBe(source!.content_revision);
 expect(await env.DB.prepare("SELECT revision FROM classification_jobs WHERE link_id=?").bind(f.id).first("revision")).toBe(f.jobRevision);
 expect(await (await call("v2/evidence-requests/recoverable",undefined,env.DB,"GET")).json()).toEqual({requests:[]});
});
