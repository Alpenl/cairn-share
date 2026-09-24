import {applyD1Migrations,env,reset} from "cloudflare:test";
import {beforeEach,expect,it} from "vitest";
import worker from "../src/index";
const bindings=()=>({...env,CAIRN_API_TOKEN:"app",CAIRN_ENRICHER_TOKEN:"internal"});
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
async function call(path:string,body?:unknown,token="internal"){
 return worker.fetch(new Request("https://test/api/"+path,{method:body===undefined?"GET":"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),bindings());
}
async function setup(){
 const created=await(await call("links",{url:"https://x.com/source/status/42"},"app")).json() as {id:number};
 const lease=await(await call(`enrichment/jobs/${created.id}/claim`,{})).json() as {lease_token:string};
 const source={original_text:"synthetic primary",original_language:"en",context_text:"first context",related_links:["https://example.com/first"],image_urls:[],model:"fixture"};
 const save=async(value=source)=>call(`enrichment/jobs/${created.id}/source`,{lease_token:lease.lease_token,source:value});
 const revision=()=>env.DB.prepare("SELECT content_revision FROM links WHERE id=?").bind(created.id).first<number>("content_revision");
 expect((await save()).status).toBe(200);
 return {id:created.id,lease:lease.lease_token,source,save,revision};
}
it("one actual source save changing context and links increments content revision exactly once",async()=>{
 const f=await setup(),before=await f.revision();
 const source={...f.source,context_text:"second context",related_links:["https://example.com/second"]};
 expect((await f.save(source)).status).toBe(200);expect(await f.revision()).toBe(Number(before)+1);
 expect((await f.save(source)).status).toBe(200);expect(await f.revision()).toBe(Number(before)+1);
});

it.each([1,2,3,4,5,6,7])("coalesces source field combination %i and keeps replay stable",async(mask)=>{
 const f=await setup(),before=await f.revision();
 const source={...f.source,...(mask&1?{original_text:"changed primary"}:{}),...(mask&2?{context_text:"changed context"}:{}),...(mask&4?{related_links:["https://example.com/changed"]}:{})};
 expect((await f.save(source)).status).toBe(200);expect(await f.revision()).toBe(Number(before)+1);
 expect((await f.save(source)).status).toBe(200);expect(await f.revision()).toBe(Number(before)+1);
 expect(await env.DB.prepare("SELECT source_context_text FROM links WHERE id=?").bind(f.id).first("source_context_text")).toBe(source.context_text);
 expect(await(await call(`enrichment/jobs/${f.id}/source`)).json()).toMatchObject(source);
});
it("keeps independent changes distinct even before a new snapshot is written",async()=>{
 const f=await setup(),before=await f.revision();
 for(let i=1;i<=3;i++){expect((await f.save({...f.source,context_text:`context ${i}`,related_links:[`https://example.com/${i}`]})).status).toBe(200);expect(await f.revision()).toBe(Number(before)+i);}
});
it("old direct context writes synchronize once, stale source rows cannot change current context",async()=>{
 const f=await setup(),before=await f.revision();
 await env.DB.prepare("UPDATE enrichment_sources SET payload=? WHERE link_id=?").bind(JSON.stringify({...f.source,context_text:"legacy changed"}),f.id).run();expect(await f.revision()).toBe(Number(before)+1);
 await env.DB.prepare("UPDATE enrichment_sources SET payload=payload WHERE link_id=?").bind(f.id).run();expect(await f.revision()).toBe(Number(before)+1);
 await env.DB.prepare("UPDATE enrichment_sources SET url='https://example.com/obsolete',payload=? WHERE link_id=?").bind(JSON.stringify({...f.source,context_text:"obsolete context"}),f.id).run();expect(await f.revision()).toBe(Number(before)+1);
 expect(await env.DB.prepare("SELECT source_context_text FROM links WHERE id=?").bind(f.id).first("source_context_text")).toBe("legacy changed");
});
it("direct source-links writes followed by a combined save still version the new context",async()=>{
 const f=await setup(),before=await f.revision(),links=["https://example.com/new"];
 await env.DB.prepare("UPDATE links SET related_links=? WHERE id=?").bind(JSON.stringify(links),f.id).run();expect(await f.revision()).toBe(Number(before)+1);
 expect((await f.save({...f.source,context_text:"new context",related_links:links})).status).toBe(200);expect(await f.revision()).toBe(Number(before)+2);
});
it("invalid leases cannot change either source representation and transaction failure rolls back both",async()=>{
 const f=await setup(),before=await f.revision();const changed={...f.source,context_text:"must not commit",related_links:[]};
 expect((await call(`enrichment/jobs/${f.id}/source`,{lease_token:"wrong",source:changed})).status).toBe(409);expect(await f.revision()).toBe(before);
 await env.DB.prepare("CREATE TRIGGER reject_source_write BEFORE UPDATE ON enrichment_sources BEGIN SELECT RAISE(ABORT,'injected_source_failure'); END").run();
 await expect(f.save(changed)).rejects.toThrow("injected_source_failure");expect(await f.revision()).toBe(before);
 expect(await env.DB.prepare("SELECT source_context_text FROM links WHERE id=?").bind(f.id).first("source_context_text")).toBe(f.source.context_text);
 expect(await(await call(`enrichment/jobs/${f.id}/source`)).json()).toMatchObject(f.source);
});
it("backfills only current source context without advancing existing content revisions",async()=>{
 await reset();const split=env.TEST_MIGRATIONS.findIndex(m=>m.name.startsWith("0029_"));expect(split).toBeGreaterThan(0);await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(0,split));
 for(const id of [1,2,3]){
  await env.DB.prepare("INSERT INTO links(id,url,note,created_at,original_text,content_revision) VALUES (?,?,'','t','primary',8)").bind(id,`https://example.com/${id}`).run();
  await env.DB.prepare("INSERT INTO enrichment_sources(link_id,url,original_text,payload,fetched_at) VALUES (?,?,'primary',?,'t')").bind(id,id===2?"https://example.com/stale":`https://example.com/${id}`,id===3?"invalid-json":JSON.stringify({context_text:"private migrated context"})).run();
 }
 await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(split));
 const rows=await env.DB.prepare("SELECT id,content_revision,source_context_text FROM links ORDER BY id").all();
 expect(rows.results).toEqual([{id:1,content_revision:8,source_context_text:"private migrated context"},{id:2,content_revision:8,source_context_text:""},{id:3,content_revision:8,source_context_text:""}]);
});
it("does not expose the context mirror in App representations; deletion removes it",async()=>{
 const f=await setup();
 for(const path of [`links/${f.id}`,`links/${f.id}?include=enrichment`,"links?include=enrichment"]){const response=await call(path,undefined,"app");expect(response.status).toBe(200);expect(await response.text()).not.toContain("source_context_text");}
 const deleted=await worker.fetch(new Request(`https://test/api/links/${f.id}`,{method:"DELETE",headers:{Authorization:"Bearer app"}}),bindings());expect(deleted.status).toBe(204);
 expect(await env.DB.prepare("SELECT source_context_text FROM links WHERE id=?").bind(f.id).first()).toBeNull();expect(await env.DB.prepare("SELECT payload FROM enrichment_sources WHERE link_id=?").bind(f.id).first()).toBeNull();
});
