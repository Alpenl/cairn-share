import { applyD1Migrations,env,reset } from "cloudflare:test";
import { beforeEach,expect,it } from "vitest";
import worker from "../src/index";
const binding=()=>({DB:env.DB,ENRICHMENT_IMAGES:env.ENRICHMENT_IMAGES,CAIRN_API_TOKEN:"app",CAIRN_ENRICHER_TOKEN:"internal"});
const headers={Authorization:"Bearer app","X-Cairn-Collections":"1","Content-Type":"application/json"};
const id=()=>crypto.randomUUID();
async function call(path:string,body?:unknown,token="app") {return worker.fetch(new Request("https://collections.example/api/"+path,{method:body?"POST":"GET",headers:{...headers,Authorization:`Bearer ${token}`},body:body?JSON.stringify(body):undefined}),binding());}
async function op(c:string,revision:number,type:string,extra={},operation_key=id()) {const body={operation_key,expected_revision:revision,type,...extra};const r=await call(`collections/${c}/operations`,body);return {r,body,data:await r.json() as any};}
async function read(c:string){return (await (await call("collections/"+c)).json()) as any;}
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);for(let n=1;n<=4;n++)await env.DB.prepare("INSERT INTO links(id,url,note,created_at) VALUES(?,?,?,'2026-10-05')").bind(n,`https://example.com/${n}`,"设计 "+n).run();});
it("shares articles across collections, reorders and retains contextual notes without altering sources",async()=>{
 const c=id(),d=id();expect((await op(c,0,"create",{name:"网站改版"})).r.status).toBe(200);await op(d,0,"create",{name:"文章参考"});
 await op(c,1,"add",{link_ids:[3,1,2]});await op(d,1,"add",{link_ids:[1]});await op(c,2,"note",{link_id:1,note:"导航参考"});
 await op(c,3,"move",{link_id:2,before_id:3});let data=await read(c);expect(data.items.map((i:any)=>i.link_id)).toEqual([2,3,1]);expect(data.items[2].note).toBe("导航参考");
 await op(c,4,"move",{link_id:2,before_id:null});data=await read(c);expect(data.items.map((i:any)=>i.link_id)).toEqual([3,1,2]);
 await op(c,5,"remove",{link_ids:[1]});expect((await read(d)).items).toHaveLength(1);
 expect(await env.DB.prepare("SELECT note FROM links WHERE id=1").first("note")).toBe("设计 1");
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_jobs").first("n")).toBe(0);
});
it("CAS and operation receipts protect concurrent and retried writes",async()=>{
 const c=id();await op(c,0,"create",{name:"A"});const results=await Promise.all([op(c,1,"edit",{name:"B"}),op(c,1,"edit",{name:"C"})]);
 expect(results.map(x=>x.r.status).sort()).toEqual([200,409]);const winner=results.find(x=>x.r.status===200)!;
 const replay=await call(`collections/${c}/operations`,winner.body);expect(replay.status).toBe(200);expect((await read(c)).collection.revision).toBe(2);
 expect((await call(`collections/${c}/operations`,{...winner.body,name:"different"})).status).toBe(409);
 const before=await env.DB.prepare("SELECT MAX(seq) seq FROM collection_changes").first("seq");
 expect((await op(c,2,"add",{link_ids:[1,999]})).r.status).toBe(400);expect((await read(c)).items).toEqual([]);expect(await env.DB.prepare("SELECT MAX(seq) seq FROM collection_changes").first("seq")).toBe(before);
});
it("archive and reversible deletion keep articles, reject stale edits and follow permanent article deletion",async()=>{
 const c=id();await op(c,0,"create",{name:"A"});await op(c,1,"add",{link_ids:[1,2]});await op(c,2,"edit",{archived:true,pinned:true});
 await op(c,3,"delete");expect((await read(c)).items).toHaveLength(2);expect((await op(c,4,"note",{link_id:1,note:"stale"})).data.error).toBe("collection_deleted");
 await env.DB.prepare("DELETE FROM links WHERE id=1").run();const current=await read(c);expect(current.items.map((i:any)=>i.link_id)).toEqual([2]);expect(current.collection.revision).toBeGreaterThan(4);
 await op(c,current.collection.revision,"restore");expect((await read(c)).collection.deleted).toBe(0);expect(await env.DB.prepare("SELECT COUNT(*) n FROM links").first("n")).toBe(3);
});
it("paginates identity-only sync without losing writes or deletions and rejects foreign epoch",async()=>{
 const c=id();await op(c,0,"create",{name:"A"});await op(c,1,"add",{link_ids:[1,2]});
 let page=await (await call("collections/sync?limit=1")).json() as any;const epoch=page.epoch;let cursor=page.cursor;const events=[...page.changes];
 await op(c,2,"note",{link_id:2,note:"later"});await env.DB.prepare("DELETE FROM links WHERE id=1").run();
 for(let n=0;n<30;n++){page=await (await call(`collections/sync?after=${cursor}&epoch=${epoch}&limit=1`)).json() as any;events.push(...page.changes);cursor=page.cursor;if(!page.has_more)break;}
 const map=new Map();for(const e of events)map.set(e.link_id,e.value);expect(map.get(1)).toBeNull();expect(map.get(2).note).toBe("later");
 expect((await call(`collections/sync?after=${cursor}&epoch=foreign`)).status).toBe(409);
 expect((await call("collections/sync?after=999999&epoch="+epoch)).status).toBe(409);
 expect((await call("collections/sync?limit=999")).status).toBe(400);
});
it("filters, orders and caches collection pages independently",async()=>{
 const c=id(),d=id();await op(c,0,"create",{name:"A"});await op(d,0,"create",{name:"B"});await op(c,1,"add",{link_ids:[2,1,3]});await op(d,1,"add",{link_ids:[4]});
 const page=async(cid:string,before="")=>(await (await call(`links?collection_id=${cid}&include=enrichment&limit=2${before}`)).json()) as any;
 let p=await page(c);expect(p.items.map((i:any)=>i.id)).toEqual([2,1]);expect((await page(c,"&before_id="+p.next_before_id)).items.map((i:any)=>i.id)).toEqual([3]);
 expect((await page(d)).items.map((i:any)=>i.id)).toEqual([4]);await op(c,2,"move",{link_id:3,before_id:2});expect((await page(c)).items.map((i:any)=>i.id)).toEqual([3,2]);
 expect((await call(`links?collection_id=${c}&q=${encodeURIComponent("设计 1")}&include=enrichment`)).status).toBe(200);
 await op(c,3,"delete");expect((await page(c)).items).toEqual([]);
});
it("enforces app/internal authentication and request limits",async()=>{
 const c=id();expect((await call("collections",undefined,"bad")).status).toBe(401);expect((await call("enrichment/collections",undefined,"app")).status).toBe(401);
 expect((await call("enrichment/collections",undefined,"internal")).status).toBe(200);
 expect((await op(c,0,"create",{name:" ".repeat(81)})).r.status).toBe(400);expect((await op(c,0,"create",{name:"A",unknown:true})).r.status).toBe(400);
 await op(c,0,"create",{name:"A"});expect((await op(c,1,"add",{link_ids:[1,1]})).r.status).toBe(400);expect((await op(c,1,"move",{link_id:1,before_id:1})).r.status).toBe(400);
});

it("concurrent retries of the same receipt apply member edits exactly once",async()=>{
 const c=id();await op(c,0,"create",{name:"A"});await op(c,1,"add",{link_ids:[1,2]});
 const before=await env.DB.prepare("SELECT MAX(seq) n FROM collection_changes").first<number>("n");
 const key=id();const results=await Promise.all(Array.from({length:6},()=>op(c,2,"note",{link_id:1,note:"once"},key)));
 expect(results.every(r=>r.r.status===200)).toBe(true);
 expect((await read(c)).collection.revision).toBe(3);
 expect(await env.DB.prepare("SELECT MAX(seq) n FROM collection_changes").first<number>("n")).toBe(before!+2);
 expect((await op(c,3,"note",{link_id:4,note:"absent"})).data.error).toBe("member_not_found");
 expect((await read(c)).collection.revision).toBe(3);
});
