import {applyD1Migrations,env,reset} from "cloudflare:test";
import {beforeEach,expect,it} from "vitest";
import worker from "../src/index";
import {drainCollectionRules} from "../src/collection-rules";
import {historicalCatalog,managedCatalog} from "../src/tag-catalog";
const binding=()=>({DB:env.DB,ENRICHMENT_IMAGES:env.ENRICHMENT_IMAGES,CAIRN_API_TOKEN:"app",CAIRN_ENRICHER_TOKEN:"internal"});
const headers={Authorization:"Bearer app","X-Cairn-Collections":"1","X-Cairn-Tag-System":"1","X-Cairn-Topic-Granularity":"1","Content-Type":"application/json"};
const uuid=()=>crypto.randomUUID();
async function call(path:string,body?:unknown,token="app"){const r=await worker.fetch(new Request('https://rules.example/api/'+path,{method:body?'POST':'GET',headers:{...headers,Authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined}),binding());return {status:r.status,data:await r.json() as any};}
const catalogOp=(revision:number,type:string,extra={},key=uuid())=>call('tag-catalog/operations',{operation_key:key,expected_revision:revision,dimension:'topics',type,...extra});
const collectionOp=(id:string,revision:number,type:string,extra={})=>call(`collections/${id}/operations`,{operation_key:uuid(),expected_revision:revision,type,...extra});
async function link(id:number){await env.DB.prepare("INSERT INTO links(id,url,note,created_at) VALUES(?,?,?,'2026-10-05')").bind(id,'https://example.com/'+id,'n'+id).run();}
async function tag(id:number,terms:string[]){await env.DB.prepare('UPDATE links SET classification=? WHERE id=?').bind(JSON.stringify({topics:terms,form:'',use:'',why_suggestion:'',entities:[],uncertainty:false,taxonomy_version:'2026-10-02.1',discarded_tags:[]}),id).run();}
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);await link(1)});
it('archives legacy human-only opposition and replays the same operation without changing historical tags',async()=>{
 const source=await managedCatalog(binding());
 expect(source.catalog.uses.find(t=>t.id==='contra')?.ai_enabled).toBeUndefined();
 const current=await call('tag-catalog');
 expect(current.data.catalog.uses.find((t:any)=>t.id==='contra').ai_enabled).toBe(false);
 const key=uuid(),operation={operation_key:key,expected_revision:0,dimension:'uses',id:'contra',type:'archive'};
 const archived=await call('tag-catalog/operations',operation);
 expect(archived.status).toBe(200);
 expect(archived.data.catalog.uses.find((t:any)=>t.id==='contra')).toMatchObject({active:false,deprecated:true,ai_enabled:false});
 const replay=await call('tag-catalog/operations',operation);
 expect(replay.status).toBe(200);expect(replay.data.replayed).toBe(true);expect(replay.data.revision).toBe(1);
 expect((await call('tag-catalog/history?dimension=uses&id=contra')).data.items).toHaveLength(1);
 const restored=await call('tag-catalog/operations',{...operation,operation_key:uuid(),expected_revision:1,type:'restore'});
 expect(restored.status).toBe(200);
 expect(restored.data.catalog.uses.find((t:any)=>t.id==='contra')).toMatchObject({active:true,deprecated:false,ai_enabled:false});
 const version=restored.data.catalog.version;
 const renamed=await call('tag-catalog/operations',{...operation,operation_key:uuid(),expected_revision:2,type:'edit',definition:{label:'反对意见'}});
 expect(renamed.status).toBe(200);expect(renamed.data.catalog.version).toBe(version);
 const forbidden=await call('tag-catalog/operations',{...operation,operation_key:uuid(),expected_revision:3,type:'edit',definition:{ai_enabled:true}});
 expect(forbidden.status).toBe(400);expect(forbidden.data.error).toBe('personal_use_human_only');
 expect((await historicalCatalog(binding(),source.catalog.version))?.uses).toEqual(source.catalog.uses);
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM classification_runs').first('n')).toBe(0);
});
it('normalizes a persisted legacy catalog without rewriting its snapshot on reads',async()=>{
 const source=await managedCatalog(binding());
 const snapshot=JSON.stringify(source.catalog);
 await env.DB.prepare("INSERT INTO tag_catalog_snapshots(revision,version,catalog,created_at) VALUES(1,?,?,'2026-10-07')").bind(source.catalog.version,snapshot).run();
 await env.DB.prepare('UPDATE tag_catalog_state SET revision=1 WHERE id=1').run();
 expect((await call('tag-catalog')).data.catalog.uses.find((t:any)=>t.id==='contra').ai_enabled).toBe(false);
 expect(await env.DB.prepare('SELECT catalog FROM tag_catalog_snapshots WHERE revision=1').first('catalog')).toBe(snapshot);
 const r=await call('tag-catalog/operations',{operation_key:uuid(),expected_revision:1,dimension:'uses',id:'contra',type:'archive'});
 expect(r.status).toBe(200);
});
it('creates stable AI-enabled tags, detects collisions and replays an uncertain response once',async()=>{
 const key=uuid(),body={definition:{label:'LoRA',aliases:['低秩适配'],description:'LoRA 适配器训练与使用'}};
 const r=await catalogOp(0,'create',body,key);expect(r.status).toBe(200);const term=r.data.catalog.topics.find((t:any)=>t.id===r.data.id);expect(term.ai_enabled).toBe(true);expect(term.granularity).toBe('specific');expect(term.includes).toEqual(['LoRA 适配器训练与使用']);expect(term.excludes).toHaveLength(1);expect(term.recall_terms).toEqual(['LoRA']);
 const again=await catalogOp(0,'create',body,key);expect(again.status).toBe(200);expect(again.data.id).toBe(r.data.id);expect(again.data.revision).toBe(1);
 expect((await catalogOp(1,'create',body)).status).toBe(409);expect((await catalogOp(0,'edit',{id:r.data.id,definition:{label:'Lora'}})).status).toBe(409);
 const oldVersion=r.data.catalog.version;
 const rename=await catalogOp(1,'edit',{id:r.data.id,definition:{label:'LoRA 微调'}});expect(rename.status).toBe(200);expect(rename.data.catalog.version).toBe(oldVersion);
 const off=await catalogOp(2,'edit',{id:r.data.id,definition:{ai_enabled:false}});expect(off.status).toBe(200);expect(off.data.catalog.version).not.toBe(oldVersion);
 expect((await historicalCatalog(binding(),oldVersion))?.topics.find(t=>t.id===r.data.id)?.ai_enabled).toBe(true);
 const on=await catalogOp(3,'edit',{id:r.data.id,definition:{ai_enabled:true}});expect(on.status).toBe(200);
 const archived=await catalogOp(4,'archive',{id:r.data.id});expect(archived.status).toBe(200);expect((await catalogOp(5,'restore',{id:r.data.id})).status).toBe(200);
 expect((await call('tag-catalog',undefined,'bad')).status).toBe(401);
});
it('new managed IDs work in manual tags and indexed filters',async()=>{
 const r=await catalogOp(0,'create',{definition:{label:'LoRA',description:'LoRA 适配器'}}),id=r.data.id;
 const action=await call('bookmarks/1/tags',{operation_key:uuid(),expected_revision:0,actions:[{action:'accept',tag_ref:'system/topics/'+id}]});expect(action.status).toBe(200);expect(action.data.selection.topics).toContain(id);
 const filtered=await call('links?include=enrichment&topics='+id);expect(filtered.status).toBe(200);expect(filtered.data.items.map((x:any)=>x.id)).toEqual([1]);
 expect((await call('links?include=enrichment&topics=tag_00000000000000000000000000000000')).status).toBe(400);
});
it('files only new items, remembers manual removals, preserves notes and shows provenance',async()=>{
 const c=uuid();await collectionOp(c,0,'create',{name:'AIGC'});await tag(1,['image_creation']);
 const rule=await collectionOp(c,1,'rule',{enabled:true,mode:'any',tag_refs:['system/topics/image_creation']});expect(rule.status).toBe(200);
 await drainCollectionRules(binding());expect((await call('collections/'+c)).data.items).toHaveLength(0);
 await link(2);await tag(2,['image_creation']);await link(3);await tag(3,['image_creation']);await drainCollectionRules(binding());
 let detail=(await call('collections/'+c)).data;expect(detail.items.map((i:any)=>i.link_id)).toEqual([2,3]);expect(detail.items[0].origin).toBe('rule');expect(JSON.parse(detail.items[0].matched_tags)).toEqual(['system/topics/image_creation']);
 await collectionOp(c,detail.collection.revision,'remove',{link_ids:[2]});await tag(2,[]);await tag(2,['image_creation']);await drainCollectionRules(binding());detail=(await call('collections/'+c)).data;expect(detail.items.map((i:any)=>i.link_id)).toEqual([3]);
 await collectionOp(c,detail.collection.revision,'note',{link_id:3,note:'keep'});await tag(3,[]);await drainCollectionRules(binding());detail=(await call('collections/'+c)).data;expect(detail.items[0].note).toBe('keep');
 const preview=(await call('collections/'+c+'/rules/preview')).data;expect(preview.items.map((i:any)=>i.id)).toEqual([1]);
 await collectionOp(c,preview.revision,'backfill');detail=(await call('collections/'+c)).data;expect(detail.items.map((i:any)=>i.link_id)).toEqual([3,1]);
 await collectionOp(c,detail.collection.revision,'add',{link_ids:[2]});expect(await env.DB.prepare('SELECT COUNT(*) n FROM collection_rule_exclusions WHERE link_id=2').first('n')).toBe(0);
});
it('ALL matches the final effective state and ANY stores only matched refs',async()=>{
 const c=uuid();await collectionOp(c,0,'create',{name:'AIGC'});await collectionOp(c,1,'rule',{enabled:true,mode:'all',tag_refs:['system/topics/image_creation','system/topics/video_creation']});
 await link(2);await tag(2,['image_creation']);await drainCollectionRules(binding());expect((await call('collections/'+c)).data.items).toEqual([]);
 await tag(2,['image_creation','video_creation']);await drainCollectionRules(binding());expect((await call('collections/'+c)).data.items).toHaveLength(1);
 const d=uuid();await collectionOp(d,0,'create',{name:'Any'});await collectionOp(d,1,'rule',{enabled:true,mode:'any',tag_refs:['system/topics/image_creation','system/topics/video_creation']});await link(3);await tag(3,['image_creation']);await drainCollectionRules(binding());
 expect(JSON.parse((await call('collections/'+d)).data.items[0].matched_tags)).toEqual(['system/topics/image_creation']);
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM classification_runs').first('n')).toBe(0);
});
it('edits other dimensions without adding invalid topic metadata and guards the last AI choice',async()=>{
 const r=await call('tag-catalog/operations',{operation_key:uuid(),expected_revision:0,type:'edit',dimension:'resource_kinds',id:'model',definition:{label:'模型权重',ai_enabled:false}});expect(r.status).toBe(200);
 const d=await call('tag-catalog/history?dimension=resource_kinds&id=model');expect(d.data.items).toHaveLength(1);
});
