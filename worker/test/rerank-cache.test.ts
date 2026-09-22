import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { pruneRerankCache } from "../src/rerank-cache";

const owner=(n:number)=>n.toString(16).padStart(64,"0");
const scope="a".repeat(64), spec="b".repeat(64);
const fixtureEnv=()=>({...env,CAIRN_API_TOKEN:"app",CAIRN_ENRICHER_TOKEN:"internal"});
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
async function call(path:string,body?:unknown,token="internal",db=env.DB){
 return worker.fetch(new Request("https://test/api/"+path,{method:body===undefined?"GET":"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),{...fixtureEnv(),DB:db});
}
async function setup(){
 for(const id of [1,2])await env.DB.prepare("INSERT INTO links(id,url,note,created_at,ai_title,summary) VALUES (?,?,'','2026-01-01','synthetic title','synthetic material')").bind(id,`https://x.com/fixture/status/${99000+id}`).run();
 return requestFor();
}
async function requestFor(ownerID=1){
 const page=await (await call("enrichment/jobs?view=summary&include_cache_identity=1&q=synthetic&filter_contract_version=1")).json() as {items:Array<{id:number;cache_identity:Record<string,number>}>};
 const items=page.items.map(i=>{const {schema_version,...versions}=i.cache_identity;expect(schema_version).toBe(1);return {id:i.id,...versions};});
 const questions=Object.fromEntries(items.map(i=>[`rerank_${i.id}`,{type:"score",instructions:"synthetic shared relevance",criteria:["none","weak","relevant","strong"]}]));
 return {owner_token:owner(ownerID),scope_hash:scope,spec_hash:spec,items,request_json:JSON.stringify({model:"jev-1.13.0",state:{query:"private synthetic query"},questions})};
}
const answers={rerank_1:{type:"score",score:1,legend:{0:"none",1:"weak",2:"relevant",3:"strong"},probabilities:{0:0,1:1,2:0,3:0},confidence:1},rerank_2:{type:"score",score:3,legend:{0:"none",1:"weak",2:"relevant",3:"strong"},probabilities:{0:0,1:0,2:0,3:1},confidence:1}};

it("grants a single concurrent owner and replays a committed result without granting again",async()=>{
 const body=await setup();
 const rs=await Promise.all([call("v2/rerank-cache/claim",body),call("v2/rerank-cache/claim",{...body,owner_token:owner(2)})]);
 const receipts=await Promise.all(rs.map(r=>r.json() as Promise<{key:string;owned:boolean}>));
 expect(receipts.filter(r=>r.owned)).toHaveLength(1);expect(receipts[0].key).toBe(receipts[1].key);
 const win=receipts[0].owned?body.owner_token:owner(2),key=receipts[0].key;
 expect(await (await call("v2/rerank-cache/claim",{...body,owner_token:win})).json()).toMatchObject({owned:false,status:"pending"});
 expect((await call(`v2/rerank-cache/${key}/complete`,{owner_token:owner(3),status:"completed",answers})).status).toBe(409);
 const completion={owner_token:win,status:"completed",answers};
 await call(`v2/rerank-cache/${key}/complete`,completion); // Discard committed response.
 expect(await (await call("v2/rerank-cache/claim",{...body,owner_token:owner(4)})).json()).toMatchObject({owned:false,status:"completed",answers});
 expect((await call(`v2/rerank-cache/${key}/complete`,completion)).status).toBe(200);
 expect((await call(`v2/rerank-cache/${key}/complete`,{...completion,answers:{...answers,rerank_1:{type:"score",score:2}}})).status).toBe(409);
 expect(await env.DB.prepare("SELECT request_json FROM rerank_cache WHERE cache_key=?").bind(key).first("request_json")).toBe(body.request_json);
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger").first("n")).toBe(0); // Cache alone never authorizes a paid call.
});

it("does not add version fields to legacy list responses",async()=>{
 await setup();
 const old=await (await call("enrichment/jobs?view=summary")).json() as {items:Record<string,unknown>[]};
 expect(old.items[0]).not.toHaveProperty("cache_identity");
 expect((await requestFor()).items).toHaveLength(2);
});

it("keys include actual query/material/model, scope, spec, ordered candidates and every version",async()=>{
 const body=await setup();const first=await (await call("v2/rerank-cache/claim",body)).json() as {key:string};
 const wire=JSON.parse(body.request_json);
 for(const patch of [{scope_hash:"c".repeat(64)},{spec_hash:"d".repeat(64)},{items:[...body.items].reverse()},{request_json:JSON.stringify({...wire,state:{query:"changed"}})},
  {request_json:JSON.stringify({...wire,questions:{...wire.questions,rerank_1:{...wire.questions.rerank_1,instructions:"different material"}}})}]){
  const next=await (await call("v2/rerank-cache/claim",{...body,...patch,owner_token:owner(2)})).json() as {key:string;owned:boolean};expect(next.owned).toBe(true);expect(next.key).not.toBe(first.key);
 }
 expect((await call("v2/rerank-cache/claim",{...body,request_json:JSON.stringify({...wire,model:"jev-latest"})})).status).toBe(400);
 for(const field of ["content_revision","body_revision","personal_revision","latest_decision_id","latest_entity_revision"]){
  const items:Record<string,number>[]=body.items.map(i=>({...i}));items[0][field]=Number(items[0][field])+1;
  expect((await call("v2/rerank-cache/claim",{...body,items})).status).toBe(409);
 }
});

it("source, reading and human changes invalidate reads and completion at the transaction boundary",async()=>{
 for(const field of ["content_revision","app_body_revision","personal_revision"]){
  if(field==="content_revision")await setup();
  const body=await requestFor();const receipt=await (await call("v2/rerank-cache/claim",body)).json() as {key:string};
  await env.DB.prepare(`UPDATE links SET ${field}=${field}+1 WHERE id=1`).run();
  expect((await call(`v2/rerank-cache/${receipt.key}/complete`,{owner_token:body.owner_token,status:"completed",answers})).status).toBe(409);
  expect((await call(`v2/rerank-cache/${receipt.key}`)).status).toBe(409);
 }
});

it("rejects a last-window version change inside completion UPDATE",async()=>{
 const body=await setup();const {key}=await (await call("v2/rerank-cache/claim",body)).json() as {key:string};
 let changed=false;
 const db=new Proxy(env.DB,{get(target,property){if(property==="prepare")return (sql:string)=>{
  const statement=target.prepare(sql);
  if(!sql.startsWith("UPDATE rerank_cache SET"))return statement;
  return {bind:(...args:unknown[])=>({run:async()=>{changed=true;await env.DB.prepare("UPDATE links SET personal_revision=personal_revision+1 WHERE id=1").run();return statement.bind(...args).run();}})};
 };const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;}}) as D1Database;
 expect((await call(`v2/rerank-cache/${key}/complete`,{owner_token:body.owner_token,status:"completed",answers},"internal",db)).status).toBe(409);
 expect(changed).toBe(true);expect(await env.DB.prepare("SELECT status FROM rerank_cache WHERE cache_key=?").bind(key).first("status")).toBe("pending");
});

it("deleting any candidate removes the whole private request and answers",async()=>{
 const body=await setup();const {key}=await (await call("v2/rerank-cache/claim",body)).json() as {key:string};
 await call(`v2/rerank-cache/${key}/complete`,{owner_token:body.owner_token,status:"completed",answers});
 const deleted=await worker.fetch(new Request("https://test/api/links/1",{method:"DELETE",headers:{Authorization:"Bearer app"}}),fixtureEnv());expect(deleted.status).toBe(204);
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM rerank_cache").first("n")).toBe(0);
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM rerank_cache_links").first("n")).toBe(0);
 expect((await call(`v2/rerank-cache/${key}`)).status).toBe(404);
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM links WHERE id=2").first("n")).toBe(1);
});

it("validates access and complete answer sets without converting failures to cached success",async()=>{
 const body=await setup();expect((await call("v2/rerank-cache/claim",body,"app")).status).toBe(401);
 const {key}=await (await call("v2/rerank-cache/claim",body)).json() as {key:string};
 expect((await call(`v2/rerank-cache/${key}/complete`,{owner_token:body.owner_token,status:["completed"],answers})).status).toBe(409);
 for(const bad of [{},{...answers,rerank_1:{type:"score",score:4}},{...answers,rerank_1:{type:"noul",noul:1}},{...answers,rogue:{type:"score",score:2}}]){
  expect((await call(`v2/rerank-cache/${key}/complete`,{owner_token:body.owner_token,status:"completed",answers:bad})).status).toBe(400);
 }
 expect((await call(`v2/rerank-cache/${key}/complete`,{owner_token:body.owner_token,status:"failed",answers:{}})).status).toBe(200);
 expect(await (await call("v2/rerank-cache/claim",{...body,owner_token:owner(5)})).json()).toMatchObject({status:"failed",owned:false});
});

it("expires private rows, prunes a bounded batch and caps pending allocations",async()=>{
 const body=await setup();
 for(let start=0;start<200;start+=50)await env.DB.batch(Array.from({length:50},(_,i)=>env.DB.prepare("INSERT INTO rerank_cache(cache_key,owner_token,status,request_json,scope_hash,spec_hash,model,items,created_at,expires_at) VALUES (?,?,'pending','private synthetic',?,?,'jev-1.13.0','[]',?,?)").bind(owner(start+i+100),owner(1),scope,spec,Date.now(),Date.now()+86400000)));
 expect((await call("v2/rerank-cache/claim",body)).status).toBe(429);
 await env.DB.prepare("UPDATE rerank_cache SET expires_at=1").run();
 await pruneRerankCache(env);expect(await env.DB.prepare("SELECT COUNT(*) n FROM rerank_cache").first("n")).toBe(100);
 await pruneRerankCache(env);expect(await env.DB.prepare("SELECT COUNT(*) n FROM rerank_cache").first("n")).toBe(0);
 expect(await (await call("v2/rerank-cache/claim",body)).json()).toMatchObject({owned:true});
});


it("actual human and reading field updates invalidate ownership without requiring consumer-side revision writes",async()=>{
 await setup();
 for(const [field,value] of [["note","changed note"],["why","changed reason"],["curation_status","kept"],["ai_title","synthetic changed title"],["summary","synthetic changed summary"],["enrichment_status","completed"],["url","https://example.com/changed"]]){
  const body=await requestFor();const {key}=await (await call("v2/rerank-cache/claim",body)).json() as {key:string};
  await env.DB.prepare(`UPDATE links SET ${field}=? WHERE id=1`).bind(value).run();
  expect((await call(`v2/rerank-cache/${key}`)).status).toBe(409);
  expect((await call(`v2/rerank-cache/${key}/complete`,{owner_token:body.owner_token,status:"completed",answers})).status).toBe(409);
 }
});

it("never serves an expired target left behind by the bounded sweep",async()=>{
 const body=await setup();const {key,expires_at}=await (await call("v2/rerank-cache/claim",body)).json() as {key:string;expires_at:number};
 await call(`v2/rerank-cache/${key}/complete`,{owner_token:body.owner_token,status:"completed",answers});
 const hit=await (await call("v2/rerank-cache/claim",{...body,owner_token:owner(2)})).json() as {expires_at:number};expect(hit.expires_at).toBe(expires_at);
 await env.DB.prepare("UPDATE rerank_cache SET expires_at=2 WHERE cache_key=?").bind(key).run();
 for(let start=0;start<150;start+=50)await env.DB.batch(Array.from({length:50},(_,i)=>env.DB.prepare("INSERT INTO rerank_cache(cache_key,owner_token,status,request_json,scope_hash,spec_hash,model,items,created_at,expires_at) VALUES (?,?,'pending','private synthetic',?,?,'jev-1.13.0','[]',0,1)").bind(owner(start+i+100),owner(1),scope,spec)));
 expect(await (await call("v2/rerank-cache/claim",{...body,owner_token:owner(2)})).json()).toMatchObject({key,owned:true,status:"pending",answers:{}});
});
