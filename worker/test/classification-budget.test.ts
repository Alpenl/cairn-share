import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { taxonomy } from "../src/curation";

beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
const limits={max_calls_total:20,max_calls_per_item:5,max_tokens:20*65536,max_tokens_per_item:5*65536};
const key=(n:number)=>n.toString(16).padStart(64,"0");
const fixtureEnv=()=>({...env,CAIRN_API_TOKEN:"app",CAIRN_ENRICHER_TOKEN:"internal"});
async function call(path:string,body:unknown,db=env.DB,token="internal"){
 return worker.fetch(new Request("https://test/api/"+path,{method:"POST",headers:{"X-Cairn-Classification-Budget":"1",Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body)}),{...fixtureEnv(),DB:db});
}
async function seed(id=1){
 await env.DB.prepare("INSERT INTO links(id,url,note,created_at,original_text) VALUES (?,?,'','2026-01-01','synthetic primary')").bind(id,`https://example.com/${id}`).run();
 await env.DB.prepare("INSERT OR IGNORE INTO classification_jobs(link_id) VALUES (?)").bind(id).run();
 const link=await env.DB.prepare("SELECT content_revision FROM links WHERE id=?").bind(id).first<{content_revision:number}>();
 await env.DB.prepare("INSERT INTO evidence_snapshots(id,link_id,content_revision,content_hash,payload,created_at) VALUES (?,?,?,'fixture-hash',?,'t')").bind(id,id,link!.content_revision,JSON.stringify({blocks:[{role:"primary",text:"synthetic primary"}]})).run();
 await env.DB.prepare("UPDATE classification_jobs SET status='processing',lease_token='lease',lease_until=?,spec_id='fixture',requested_model='jev-1.13.0',content_revision=?,evidence_snapshot_id=?,evidence_hash='fixture-hash' WHERE link_id=?").bind(new Date(Date.now()+60000).toISOString(),link!.content_revision,id,id).run();
 const job=await env.DB.prepare("SELECT revision,input_revision,target_generation,content_revision,evidence_snapshot_id,evidence_hash FROM classification_jobs WHERE link_id=?").bind(id).first();
 return {operation_key:key(id),link_id:id,lease_token:"lease",...job,spec_id:"fixture",model:"jev-1.13.0",request_hash:key(100),tokens:65536,limits};
}
const reserve=(body:unknown,db=env.DB,token="internal")=>call("v2/classification-budget/reserve",body,db,token);
const count=()=>env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE scope='classification_global'").first<number>("n");

it("reserves each actual request once and enforces persistent per-item/global ceilings",async()=>{
 const body=await seed();const tight={...limits,max_calls_per_item:2};
 expect(await (await reserve({...body,limits:tight})).json()).toMatchObject({granted:true});
 expect(await (await reserve({...body,limits:tight})).json()).toMatchObject({granted:false,reason:"already_reserved"});
 expect(await (await reserve({...body,operation_key:key(2),limits:tight})).json()).toMatchObject({granted:true});
 expect(await (await reserve({...body,operation_key:key(3),limits:tight})).json()).toMatchObject({granted:false,reason:"budget_exhausted"});
 expect(await count()).toBe(2);
 expect((await reserve({...body,request_hash:key(101),limits:tight})).status).toBe(409);
});
it("concurrent consumers cannot exceed the shared call or token allowance",async()=>{
 const bodies=await Promise.all([1,2,3].map(id=>seed(id)));
 const responses=await Promise.all(bodies.map(b=>reserve({...b,limits:{...limits,max_tokens:65536}})));
 const receipts=await Promise.all(responses.map(r=>r.json() as Promise<{granted:boolean}>));
 expect(receipts.filter(r=>r.granted)).toHaveLength(1);expect(await count()).toBe(1);
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE scope='classification_item'").first("n")).toBe(1);
});
it("binds every lease, target and evidence field before any budget charge",async()=>{
 const body=await seed();
 for(const patch of [{lease_token:"wrong"},{revision:99},{input_revision:99},{target_generation:99},{spec_id:"wrong"},{content_revision:99},{evidence_snapshot_id:99},{evidence_hash:"wrong"}]){
  expect((await reserve({...body,...patch})).status).toBe(409);
 }
 await env.DB.prepare("UPDATE classification_jobs SET lease_until='2000-01-01' WHERE link_id=1").run();
 expect((await reserve(body)).status).toBe(409);expect(await count()).toBe(0);
});
it("checks the final SQL transaction window rather than only a preflight",async()=>{
 const body=await seed();let changed=false;
 const db=new Proxy(env.DB,{get(target,property){if(property==="batch")return async(statements:D1PreparedStatement[])=>{
  changed=true;await env.DB.prepare("UPDATE classification_jobs SET input_revision=input_revision+1 WHERE link_id=1").run();return target.batch(statements);
 };const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;}}) as D1Database;
 expect((await reserve(body,db)).status).toBe(409);expect(changed).toBe(true);expect(await count()).toBe(0);
});
it("keeps the charge after a discarded grant response or bookmark deletion",async()=>{
 const body=await seed();await reserve({...body,limits:{...limits,max_calls_total:1}});
 expect(await (await reserve({...body,limits:{...limits,max_calls_total:1}})).json()).toMatchObject({granted:false});
 await env.DB.prepare("DELETE FROM links WHERE id=1").run();
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE link_id=1").first("n")).toBe(0);expect(await count()).toBe(1);
 const next=await seed(2);expect(await (await reserve({...next,limits:{...limits,max_calls_total:1}})).json()).toMatchObject({granted:false,reason:"budget_exhausted"});
 const global=await env.DB.prepare("SELECT link_id,units FROM budget_ledger WHERE scope='classification_global'").first<{link_id:number|null;units:string}>();
 expect(global!.link_id).toBeNull();expect(Object.keys(JSON.parse(global!.units)).sort()).toEqual(["calls","payload_hash","tokens"]);
});
it("refuses new claims before consuming an attempt when global admission is exhausted",async()=>{
 const body=await seed();await reserve(body);
 await env.DB.prepare("UPDATE classification_jobs SET status='pending',attempts=0,lease_token=NULL,lease_until=NULL WHERE link_id=1").run();
 const caps={taxonomy_version:taxonomy.version,policy_version:"fixture",model:"jev-1.13.0",budget_limits:{...limits,max_calls_total:1}};
 expect((await call("enrichment/classifications/claim",caps)).status).toBe(429);
 expect(await env.DB.prepare("SELECT attempts FROM classification_jobs WHERE link_id=1").first("attempts")).toBe(0);
 await env.DB.prepare("UPDATE budget_ledger SET created_at='2000-01-01T00:00:00.000Z'").run();
 expect((await call("enrichment/classifications/claim",caps)).status).toBe(200);
});
it("skips a per-item exhausted candidate while admitting another without resetting usage",async()=>{
 const body=await seed();await reserve({...body,limits:{...limits,max_calls_per_item:1}});await seed(2);
 await env.DB.prepare("UPDATE classification_jobs SET status='pending',attempts=0,lease_token=NULL,lease_until=NULL").run();
 const result=await call("enrichment/classifications/claim",{taxonomy_version:taxonomy.version,policy_version:"fixture",model:"jev-1.13.0",budget_limits:{...limits,max_calls_per_item:1}});
 expect(await result.json()).toMatchObject({id:2,attempt:1});
 expect(await env.DB.prepare("SELECT attempts FROM classification_jobs WHERE link_id=1").first("attempts")).toBe(0);
});
it("rejects unpinned models, widened limits, bad units, oversized requests and App credentials",async()=>{
 const body=await seed();
 expect((await reserve(body,env.DB,"app")).status).toBe(401);
 for(const patch of [{model:"jev-latest"},{tokens:0},{tokens:65535},{limits:{...limits,max_calls_total:21}},{limits:{...limits,max_calls_per_item:6}},{day:"2000-01-01"},{link_id:0}])expect((await reserve({...body,...patch})).status).toBe(400);
 expect((await reserve({...body,request_hash:"a".repeat(9000)})).status).toBe(413);
 expect(await count()).toBe(0);
});


it("rejects a pre-budget consumer before any new lease or attempt",async()=>{
 await seed();await env.DB.prepare("UPDATE classification_jobs SET status='pending',attempts=0,lease_token=NULL,lease_until=NULL").run();
 const response=await worker.fetch(new Request("https://test/api/enrichment/classifications/claim",{method:"POST",headers:{Authorization:"Bearer internal","Content-Type":"application/json"},body:JSON.stringify({taxonomy_version:taxonomy.version,policy_version:"fixture",model:"jev-1.13.0"})}),fixtureEnv());
 expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:"capability_mismatch"});
 expect(await env.DB.prepare("SELECT attempts FROM classification_jobs WHERE link_id=1").first("attempts")).toBe(0);expect(await count()).toBe(0);
});
