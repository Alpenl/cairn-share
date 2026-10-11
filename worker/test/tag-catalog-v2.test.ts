import {applyD1Migrations,env,reset} from "cloudflare:test";
import {beforeEach,expect,it} from "vitest";
import worker from "../src/index";
import {drainTagMerges} from "../src/tag-merges";
import {drainCollectionRules} from "../src/collection-rules";
const binding=()=>({DB:env.DB,ENRICHMENT_IMAGES:env.ENRICHMENT_IMAGES,CAIRN_API_TOKEN:"app",CAIRN_ENRICHER_TOKEN:"internal"});
const headers={Authorization:"Bearer app","X-Cairn-Collections":"2","X-Cairn-Tag-System":"1","X-Cairn-Topic-Granularity":"1","Content-Type":"application/json"};
const uuid=()=>crypto.randomUUID();
async function call(path:string,body?:unknown,method=body?'POST':'GET'){const r=await worker.fetch(new Request('https://v2.example/api/'+path,{method,headers,body:body?JSON.stringify(body):undefined}),binding());return {status:r.status,data:await r.json() as any};}
async function link(id:number,url=`https://example.com/${id}`){await env.DB.prepare("INSERT INTO links(id,url,note,created_at,url_identity) VALUES(?,?,?,?,?)").bind(id,url,'n'+id,`2026-10-0${id}`,url).run();}
async function tag(id:number,terms:string[]){await env.DB.prepare('UPDATE links SET classification=? WHERE id=?').bind(JSON.stringify({topics:terms,form:'',use:'',why_suggestion:'',entities:[],uncertainty:false,taxonomy_version:'2026-10-02.1',discarded_tags:[]}),id).run();}
const ids=(r:any)=>r.data.items.map((x:any)=>x.id).sort();
const catalogRev=async()=>(await call('tag-catalog')).data.revision as number;
const topic=async(id:string)=>(await call('tag-catalog')).data.catalog.topics.find((t:any)=>t.id===id);
async function customTag(label:string){const r=await call('custom-tags',{operation_key:uuid(),label});expect(r.status).toBe(200);return r.data.tag as {id:string;tag_ref:string};}
async function attach(id:number,ref:string){const s=(await call(`bookmarks/${id}/tags`)).data;const r=await call(`bookmarks/${id}/tags`,{operation_key:uuid(),expected_revision:s.revision,actions:[{action:'attach',tag_ref:ref}]});expect(r.status).toBe(200);}
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);for(const n of [1,2,3,4])await link(n);});

it('filters by mixed system and personal tags with ANY/ALL, and validates input',async()=>{
 await tag(1,['image_creation']);await tag(2,['image_creation','video_creation']);await tag(3,['video_creation']);
 const mine=await customTag('本周');await attach(3,mine.tag_ref);await attach(4,mine.tag_ref);
 const q=(s:string)=>call('links?include=enrichment&'+s);
 expect(ids(await q('tags=system/topics/image_creation'))).toEqual([1,2]);
 expect(ids(await q(`tags=system/topics/image_creation,${mine.tag_ref}`))).toEqual([1,2,3,4]);
 expect(ids(await q(`tags=system/topics/video_creation,${mine.tag_ref}&tags_mode=all`))).toEqual([3]);
 expect(ids(await q('tags=system/topics/image_creation,system/topics/video_creation&tags_mode=all'))).toEqual([2]);
 for(const bad of ['tags=system/topics/nope','tags=topics/image_creation','tags=system/topics/image_creation&tags_mode=some','tags_mode=all','tags=system/topics/image_creation&tags=system/topics/video_creation'])
  expect((await q(bad)).status,bad).toBe(400);
 // Different filters never share a cached page.
 expect(ids(await q('tags=system/topics/video_creation'))).toEqual([2,3]);
});

it('stores a parent topic, rejects cycles and lets a parent filter include its children',async()=>{
 const rev=await catalogRev();
 const set=(r:number,id:string,relations:unknown)=>call('tag-catalog/operations',{operation_key:uuid(),expected_revision:r,dimension:'topics',id,type:'edit',definition:{relations}});
 expect((await set(rev,'video_creation',[{id:'image_creation',kind:'broader'}])).status).toBe(200);
 expect((await topic('video_creation')).relations).toEqual([{id:'image_creation',kind:'broader'}]);
 const cycle=await set(rev+1,'image_creation',[{id:'video_creation',kind:'broader'}]);expect(cycle.status).toBe(400);expect(cycle.data.details).toEqual(['parent_cycle']);
 expect((await set(rev+1,'image_creation',[{id:'video_creation',kind:'synonym'}])).status).toBe(400);
 expect((await set(rev+1,'image_creation',[{id:'nope',kind:'related'}])).status).toBe(409);
 expect((await set(rev+1,'image_creation',[{id:'ui_design',kind:'broader'},{id:'ai_coding',kind:'broader'}])).status).toBe(400);
 await tag(1,['image_creation']);await tag(2,['video_creation']);
 expect(ids(await call('links?include=enrichment&tags=system/topics/image_creation'))).toEqual([1]);
 expect(ids(await call('links?include=enrichment&tags=system/topics/image_creation&tags_children=1'))).toEqual([1,2]);
});

it('merges a topic: moves memberships through tag operations, rewrites rules, reports usage and undoes',async()=>{
 await tag(1,['video_creation']);await tag(2,['video_creation','image_creation']);await tag(3,['ui_design']);
 const c=uuid();await call(`collections/${c}/operations`,{operation_key:uuid(),expected_revision:0,type:'create',name:'视频'});
 await call(`collections/${c}/operations`,{operation_key:uuid(),expected_revision:1,type:'rule',enabled:true,mode:'any',tag_refs:['system/topics/video_creation'],exclude_tag_refs:['system/topics/ui_design']});
 const before=(await call('tag-catalog/usage')).data.items.find((x:any)=>x.tag_ref==='system/topics/video_creation');
 expect(before).toMatchObject({count:2,rules:[{collection_id:c,role:'include',enabled:true}]});
 const videoAliases=(await topic('video_creation')).aliases;
 const key=uuid(),body={operation_key:key,expected_revision:await catalogRev(),kind:'system',dimension:'topics',from:'video_creation',into:'image_creation'};
 const merged=await call('tag-catalog/merges',body);expect(merged.status).toBe(200);
 expect(merged.data).toMatchObject({status:'active',from:'video_creation',into:'image_creation',rules_rewritten:1});
 expect(merged.data.progress.apply).toMatchObject({pending:0,done:2});
 expect((await call('tag-catalog/merges',body)).data.replayed).toBe(true);
 expect((await call('tag-catalog/merges',{...body,into:'ui_design'})).status).toBe(409);
 const from=await topic('video_creation');expect(from).toMatchObject({active:false,deprecated:true});expect(from.relations).toContainEqual({id:'image_creation',kind:'synonym'});
 expect((await topic('image_creation')).aliases).toEqual(expect.arrayContaining(videoAliases));
 expect(ids(await call('links?include=enrichment&tags=system/topics/image_creation'))).toEqual([1,2]);
 expect(ids(await call('links?include=enrichment&tags=system/topics/video_creation'))).toEqual([]);
 const col=(await call('collections/'+c)).data.collection;expect(JSON.parse(col.rule_tags)).toEqual(['system/topics/image_creation']);
 // Each moved bookmark has its own reversible tag history entry.
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM tag_operations WHERE operation_key IN(SELECT operation_key FROM tag_merge_queue WHERE merge_key=?)").bind(key).first('n')).toBe(2);
 // A person edits bookmark 2 after the merge: undo leaves that bookmark alone.
 const s2=(await call('bookmarks/2/tags')).data;
 expect((await call('bookmarks/2/tags',{operation_key:uuid(),expected_revision:s2.revision,actions:[{action:'accept',tag_ref:'system/topics/ui_design'}]})).status).toBe(200);
 const undone=await call(`tag-catalog/merges/${key}/undo`,{operation_key:uuid(),expected_revision:await catalogRev()});
 expect(undone.status).toBe(200);expect(undone.data.status).toBe('undone');expect(undone.data.progress.undo).toMatchObject({pending:0,done:1,skipped:1});
 expect(await topic('video_creation')).toMatchObject({active:true,deprecated:false});
 expect((await topic('video_creation')).aliases).toEqual(videoAliases);
 expect(ids(await call('links?include=enrichment&tags=system/topics/video_creation'))).toEqual([1]);
 expect(JSON.parse((await call('collections/'+c)).data.collection.rule_tags)).toEqual(['system/topics/video_creation']);
 expect((await call('tag-catalog/usage')).data.merges[0]).toMatchObject({merge_key:key,status:'undone'});
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM classification_runs').first('n')).toBe(0);
});

it('merges personal tags and archives the source once its bookmarks moved',async()=>{
 const a=await customTag('稍后看'),b=await customTag('待读');await attach(1,a.tag_ref);await attach(2,a.tag_ref);await attach(2,b.tag_ref);
 const merged=await call('tag-catalog/merges',{operation_key:uuid(),kind:'custom',from:a.id,into:b.id});
 expect(merged.status).toBe(200);expect(merged.data.progress.apply.done).toBe(2);
 expect(ids(await call(`links?include=enrichment&tags=${b.tag_ref}`))).toEqual([1,2]);
 expect(await env.DB.prepare('SELECT status FROM custom_tags WHERE id=?').bind(a.id).first('status')).toBe('deprecated');
 const undo=await call(`tag-catalog/merges/${merged.data.merge_key}/undo`,{operation_key:uuid()});expect(undo.status).toBe(200);
 expect(await env.DB.prepare('SELECT status FROM custom_tags WHERE id=?').bind(a.id).first('status')).toBe('active');
 expect(ids(await call(`links?include=enrichment&tags=${a.tag_ref}`))).toEqual([1,2]);
 expect((await call('tag-catalog/merges',{operation_key:uuid(),kind:'custom',from:a.id,into:a.id})).status).toBe(400);
});

it('merge queue drains in bounded passes and leaves nothing pending',async()=>{
 for(const n of [1,2,3,4])await tag(n,['video_creation']);
 const r=await call('tag-catalog/merges',{operation_key:uuid(),expected_revision:await catalogRev(),kind:'system',dimension:'topics',from:'video_creation',into:'image_creation'});
 expect(r.data.progress.apply.done).toBe(4);
 expect(await drainTagMerges(binding() as never)).toBe(0);
 await drainCollectionRules(binding() as never);
});

it('looks up a saved page by URL identity without writing',async()=>{
 await link(9,'https://x.com/i/web/status/123');await tag(9,['ui_design']);
 await env.DB.prepare("UPDATE links SET ai_title='标题',why='想读',images='[\"a\",\"b\"]' WHERE id=9").run();
 const c=uuid();await call(`collections/${c}/operations`,{operation_key:uuid(),expected_revision:0,type:'create',name:'参考'});await call(`collections/${c}/operations`,{operation_key:uuid(),expected_revision:1,type:'add',link_ids:[9]});
 const hit=await call('links/lookup?url='+encodeURIComponent('https://twitter.com/someone/status/123?utm_source=x'));
 expect(hit.status).toBe(200);expect(hit.data).toMatchObject({saved:true,link:{id:9,title:'标题',why:'想读',image_count:2,collections:[{id:c,name:'参考'}]}});
 expect((await call('links/lookup?url='+encodeURIComponent('https://example.com/none'))).data).toEqual({saved:false});
 for(const bad of ['','url=notaurl','url=ftp%3A%2F%2Fa','url=https%3A%2F%2Fa&x=1'])expect((await call('links/lookup?'+bad)).status,bad).toBe(400);
 expect((await worker.fetch(new Request('https://v2.example/api/links/lookup?url=https%3A%2F%2Fa'),binding())).status).toBe(401);
});

it('keeps AI tagging preferences with CAS and idempotent receipts',async()=>{
 const p=await call('preferences');expect(p.data).toEqual({value:{ai_suggestion_limit:3,ai_confirm_before_apply:false,ai_low_confidence_review:true},revision:0});
 const op={operation_key:uuid(),expected_revision:0,patch:{ai_suggestion_limit:5,ai_confirm_before_apply:true}};
 const w=await call('preferences/operations',op);expect(w.status).toBe(200);expect(w.data).toMatchObject({revision:1,value:{ai_suggestion_limit:5,ai_confirm_before_apply:true,ai_low_confidence_review:true}});
 expect((await call('preferences/operations',op)).data.replayed).toBe(true);
 expect((await call('preferences/operations',{...op,patch:{ai_suggestion_limit:6}})).status).toBe(409);
 expect((await call('preferences/operations',{operation_key:uuid(),expected_revision:0,patch:{ai_suggestion_limit:2}})).data.error).toBe('revision_conflict');
 for(const patch of [{ai_suggestion_limit:0},{ai_suggestion_limit:9},{ai_suggestion_limit:2.5},{ai_confirm_before_apply:'yes'},{theme:'dark'},{}])
  expect((await call('preferences/operations',{operation_key:uuid(),expected_revision:1,patch})).status,JSON.stringify(patch)).toBe(400);
});

it('counts legacy dropped bookmarks for the read-only settings notice',async()=>{
 await env.DB.prepare("UPDATE links SET curation_status='drop' WHERE id IN(1,3)").run();
 expect((await call('links/legacy-dropped')).data).toEqual({count:2});
});
