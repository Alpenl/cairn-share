import {applyD1Migrations,env,reset} from "cloudflare:test";
import {beforeEach,expect,it} from "vitest";
import worker from "../src/index";
import {pruneEntityCache} from "../src/entity-cache";
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
const hex=(n:number)=>n.toString(16).padStart(64,"0");
const fixtureEnv=()=>({...env,CAIRN_API_TOKEN:"app",CAIRN_ENRICHER_TOKEN:"internal"});
async function call(path:string,body?:unknown,db=env.DB,token="internal"){
 return worker.fetch(new Request("https://test/api/v2/entity-cache/"+path,{method:body===undefined?"GET":"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),{...fixtureEnv(),DB:db});
}
async function setup(){
 await env.DB.prepare("INSERT INTO links(id,url,note,created_at,original_text,related_links) VALUES (1,'https://example.com/fixture','','t','ExampleEntity','[]')").run();
 const revision=await env.DB.prepare("SELECT content_revision FROM links WHERE id=1").first<number>("content_revision");
 const blocks=[{id:"source",text:"ExampleEntity",role:"primary"}];
 await env.DB.prepare("INSERT INTO evidence_snapshots(id,link_id,content_revision,content_hash,payload,created_at) VALUES (1,1,?,?,?,'t')").bind(revision,hex(9),JSON.stringify({blocks})).run();
 return {link_id:1,evidence_snapshot_id:1,content_revision:revision,content_hash:hex(9),owner_token:hex(1),spec_hash:hex(3),candidates:[{surface:"ExampleEntity",start:0,end:13,block_id:"source",kind:"surface"}],request_json:JSON.stringify({model:"jev-1.13.0",state:{material:[{ID:"source",Text:"ExampleEntity",role:"primary"}],stored_links:[]},questions:{entity_0:{type:"noul",instructions:"synthetic substantive entity"}}})};
}
const answers={entity_0:{type:"noul",noul:.9}};
it("grants only one concurrent owner, recovers complete answers and never charges budget by claiming",async()=>{
 const b=await setup(),rs=await Promise.all([call("claim",b),call("claim",{...b,owner_token:hex(2)})]);const receipts=await Promise.all(rs.map(r=>r.json() as Promise<{key:string;owned:boolean}>));
 expect(receipts.filter(r=>r.owned)).toHaveLength(1);expect(receipts[0].key).toBe(receipts[1].key);
 const key=receipts[0].key,owner=receipts[0].owned?hex(1):hex(2),done={owner_token:owner,status:"completed",answers};
 expect(await (await call("claim",{...b,owner_token:owner})).json()).toMatchObject({owned:false,status:"pending"});
 expect((await call(key+"/complete",{...done,owner_token:hex(4)})).status).toBe(409);
 expect((await call(key+"/complete",done)).status).toBe(200);expect((await call(key+"/complete",done)).status).toBe(200);
 expect(await (await call("claim",{...b,owner_token:hex(4)})).json()).toMatchObject({key,owned:false,status:"completed",answers});
 expect((await call(key+"/complete",{...done,answers:{entity_0:{type:"noul",noul:.1}}})).status).toBe(409);
 expect(await env.DB.prepare("SELECT request_json FROM entity_cache").first("request_json")).toBe(b.request_json);
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger").first("n")).toBe(0);
});
it("human/reading edits preserve objective cache while material, links and snapshot changes invalidate",async()=>{
 const b=await setup(),r=await(await call("claim",b)).json() as {key:string};await call(r.key+"/complete",{owner_token:b.owner_token,status:"completed",answers});
 await env.DB.prepare("UPDATE links SET why='human reason',note='private note',summary='changed reading aid' WHERE id=1").run();
 expect(await(await call("claim",{...b,owner_token:hex(5)})).json()).toMatchObject({key:r.key,status:"completed",owned:false});
 await env.DB.prepare("UPDATE links SET related_links='[\"https://example.com/new\"]' WHERE id=1").run();expect((await call(r.key)).status).toBe(409);
 await env.DB.prepare("UPDATE links SET related_links='[]',content_revision=content_revision+1 WHERE id=1").run();expect((await call("claim",b)).status).toBe(409);
});
it("includes exact request, candidate provenance and policy in identity and rejects aliases or fabricated spans",async()=>{
 const b=await setup(),first=await(await call("claim",b)).json() as {key:string};
 for(const patch of [{spec_hash:hex(6)},{request_json:b.request_json.replace('synthetic substantive entity','changed criterion')}])expect(await(await call("claim",{...b,...patch})).json()).toMatchObject({owned:true});
 expect((await call("claim",{...b,request_json:b.request_json.replace('jev-1.13.0','jev-latest')})).status).toBe(400);
 for(const end of [12,14])expect((await call("claim",{...b,candidates:[{...b.candidates[0],end}]})).status).toBe(400);
 expect((await call("claim",{...b,request_json:b.request_json.replace('"Text":"ExampleEntity"','"Text":"forged material"')})).status).toBe(409);
 for(const patch of [{link_id:2},{evidence_snapshot_id:2},{content_revision:999},{content_hash:hex(10)}])expect((await call("claim",{...b,...patch})).status).toBe(409);
 expect((await call(first.key)).status).toBe(200);
});
it("validates complete typed answer sets and persists explicit failures without granting again",async()=>{
 const b=await setup(),r=await(await call("claim",b)).json() as {key:string};
 for(const bad of [{},{entity_0:{type:"noul",noul:1.1}},{entity_0:{type:"choice",noul:.8}},{entity_0:{type:"noul",noul:.8,unknown:true}},{...answers,rogue:{type:"noul",noul:.8}}])expect((await call(r.key+"/complete",{owner_token:b.owner_token,status:"completed",answers:bad})).status).toBe(400);
 expect((await call(r.key+"/complete",{owner_token:b.owner_token,status:"failed",answers:{}})).status).toBe(200);
 expect(await(await call("claim",{...b,owner_token:hex(4)})).json()).toMatchObject({owned:false,status:"failed"});
});
it("checks input versions in the final SQL completion window",async()=>{
 const b=await setup(),r=await(await call("claim",b)).json() as {key:string};let changed=false;
 const db=new Proxy(env.DB,{get(target,property){if(property==="prepare")return(sql:string)=>{const statement=target.prepare(sql);if(!sql.startsWith("UPDATE entity_cache SET"))return statement;return {bind:(...args:unknown[])=>({run:async()=>{changed=true;await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=1").run();return statement.bind(...args).run();}})};};const v=Reflect.get(target,property);return typeof v==="function"?v.bind(target):v;}}) as D1Database;
 expect((await call(r.key+"/complete",{owner_token:b.owner_token,status:"completed",answers},db)).status).toBe(409);expect(changed).toBe(true);expect(await env.DB.prepare("SELECT status FROM entity_cache").first("status")).toBe("pending");
});
it("deletion removes the private request, candidates and raw judgments",async()=>{
 const b=await setup(),r=await(await call("claim",b)).json() as {key:string};await call(r.key+"/complete",{owner_token:b.owner_token,status:"completed",answers});
 const deleted=await worker.fetch(new Request("https://test/api/links/1",{method:"DELETE",headers:{Authorization:"Bearer app"}}),fixtureEnv());expect(deleted.status).toBe(204);
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM entity_cache").first("n")).toBe(0);expect((await call(r.key)).status).toBe(404);
});
it("enforces private access, bounded body and fixed expiry without extending a hit",async()=>{
 const b=await setup();expect((await call("claim",b,env.DB,"app")).status).toBe(401);expect((await call("claim",{...b,request_json:"x".repeat(270000)})).status).toBe(400);
 const r=await(await call("claim",b)).json() as {key:string;expires_at:number};expect(await(await call("claim",{...b,owner_token:hex(4)})).json()).toMatchObject({expires_at:r.expires_at});
 await env.DB.prepare("UPDATE entity_cache SET expires_at=1").run();expect((await call(r.key)).status).toBe(404);await pruneEntityCache(env);expect(await env.DB.prepare("SELECT COUNT(*) n FROM entity_cache").first("n")).toBe(0);
 expect(await(await call("claim",{...b,owner_token:hex(4)})).json()).toMatchObject({owned:true,status:"pending"});
});

it("caps private allocations and never revives an expired key missed by the bounded sweep",async()=>{
 const b=await setup(),r=await(await call("claim",b)).json() as {key:string};
 await call(r.key+"/complete",{owner_token:b.owner_token,status:"completed",answers});
 for(let start=0;start<199;start+=50)await env.DB.batch(Array.from({length:Math.min(50,199-start)},(_,i)=>env.DB.prepare(`INSERT INTO entity_cache(cache_key,link_id,evidence_snapshot_id,content_revision,content_hash,source_links,owner_token,status,request_json,candidates,spec_hash,created_at,expires_at)
 SELECT ?,link_id,evidence_snapshot_id,content_revision,content_hash,source_links,owner_token,'pending',request_json,candidates,spec_hash,created_at,expires_at FROM entity_cache WHERE cache_key=?`).bind(hex(100+start+i),r.key)));
 expect((await call("claim",{...b,spec_hash:hex(500)})).status).toBe(429);
 await env.DB.prepare("UPDATE entity_cache SET expires_at=CASE WHEN cache_key=? THEN 2 ELSE 1 END").bind(r.key).run();
 expect(await(await call("claim",{...b,owner_token:hex(7)})).json()).toMatchObject({key:r.key,owned:true,status:"pending",answers:{}});
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM entity_cache").first("n")).toBe(100);
});
it("claim also guards a material change at the final transaction window",async()=>{
 const b=await setup();let changed=false;
 const db=new Proxy(env.DB,{get(target,property){if(property==="batch")return async(statements:D1PreparedStatement[])=>{changed=true;await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=1").run();return target.batch(statements);};const v=Reflect.get(target,property);return typeof v==="function"?v.bind(target):v;}}) as D1Database;
 expect((await call("claim",b,db)).status).toBe(409);expect(changed).toBe(true);expect(await env.DB.prepare("SELECT COUNT(*) n FROM entity_cache").first("n")).toBe(0);
});

it("a source-links-only write invalidates both the existing entity state and late completion",async()=>{
 const b=await setup(),r=await(await call("claim",b)).json() as {key:string};
 const state={operation_key:"fixture-entity-state",state:"completed_nonempty",entities:["ExampleEntity"],content_revision:b.content_revision,content_hash:b.content_hash,evidence_snapshot_id:1};
 const response=await worker.fetch(new Request("https://test/api/v2/links/1/entity-state",{method:"POST",headers:{Authorization:"Bearer internal","Content-Type":"application/json"},body:JSON.stringify(state)}),fixtureEnv());expect(response.status).toBe(200);
 await env.DB.prepare("UPDATE links SET related_links='[\"https://example.com/changed\"]' WHERE id=1").run();
 expect(await env.DB.prepare("SELECT content_revision FROM links WHERE id=1").first("content_revision")).toBe(Number(b.content_revision)+1);
 const view=await worker.fetch(new Request("https://test/api/v2/links/1/entities",{headers:{Authorization:"Bearer internal"}}),fixtureEnv());expect(await view.json()).toMatchObject({stale:true,automatic:[],entities:[]});
 expect((await call(r.key+"/complete",{owner_token:b.owner_token,status:"completed",answers})).status).toBe(409);
 await env.DB.prepare("UPDATE links SET related_links='[\"https://example.com/changed\"]',note='human' WHERE id=1").run();
 expect(await env.DB.prepare("SELECT content_revision FROM links WHERE id=1").first("content_revision")).toBe(Number(b.content_revision)+1);
});
