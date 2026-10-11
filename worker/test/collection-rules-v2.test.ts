import {applyD1Migrations,env,reset} from "cloudflare:test";
import {beforeEach,expect,it} from "vitest";
import worker from "../src/index";
import {drainCollectionRules} from "../src/collection-rules";
const binding=()=>({DB:env.DB,ENRICHMENT_IMAGES:env.ENRICHMENT_IMAGES,CAIRN_API_TOKEN:"app",CAIRN_ENRICHER_TOKEN:"internal"});
const base={Authorization:"Bearer app","X-Cairn-Tag-System":"1","X-Cairn-Topic-Granularity":"1","Content-Type":"application/json"};
const uuid=()=>crypto.randomUUID();
async function call(path:string,body?:unknown,version="2"){const r=await worker.fetch(new Request('https://rules.example/api/'+path,{method:body?'POST':'GET',headers:{...base,"X-Cairn-Collections":version},body:body?JSON.stringify(body):undefined}),binding());return {status:r.status,header:r.headers.get("X-Cairn-Collections"),data:await r.json() as any};}
const op=(id:string,revision:number,type:string,extra={},version="2")=>call(`collections/${id}/operations`,{operation_key:uuid(),expected_revision:revision,type,...extra},version);
async function link(id:number){await env.DB.prepare("INSERT INTO links(id,url,note,created_at) VALUES(?,?,?,'2026-10-05')").bind(id,'https://example.com/'+id,'n'+id).run();}
async function tag(id:number,terms:string[]){await env.DB.prepare('UPDATE links SET classification=? WHERE id=?').bind(JSON.stringify({topics:terms,form:'',use:'',why_suggestion:'',entities:[],uncertainty:false,taxonomy_version:'2026-10-02.1',discarded_tags:[]}),id).run();}
const items=async(c:string)=>(await call('collections/'+c)).data.items.map((i:any)=>i.link_id);
const rev=async(c:string)=>(await call('collections/'+c)).data.collection.revision as number;
const IMG='system/topics/image_creation',VID='system/topics/video_creation',UI='system/topics/ui_design';
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);await link(1);});

it('excludes items carrying any exclusion tag, in drain, preview and backfill',async()=>{
 const c=uuid();await op(c,0,'create',{name:'界面设计参考'});
 expect((await op(c,1,'rule',{enabled:true,mode:'any',tag_refs:[IMG,UI],exclude_tag_refs:[VID]})).status).toBe(200);
 const detail=(await call('collections/'+c)).data.collection;
 expect(JSON.parse(detail.rule_exclude_tags)).toEqual([VID]);expect(detail.rule_admission).toBe('direct');
 await link(2);await tag(2,['image_creation']);await link(3);await tag(3,['ui_design','video_creation']);await drainCollectionRules(binding());
 expect(await items(c)).toEqual([2]);
 await tag(1,['ui_design','video_creation']);
 const preview=(await call(`collections/${c}/rules/preview`)).data;
 expect(preview.items.map((i:any)=>i.id)).toEqual([]);expect(preview.counts.excluded_by_tag).toBe(2);
 await tag(1,['ui_design']);
 const p2=(await call(`collections/${c}/rules/preview`)).data;expect(p2.items.map((i:any)=>i.id)).toEqual([1]);expect(p2.items[0].matched_tags).toEqual([UI]);
 await op(c,p2.revision,'backfill');expect(await items(c)).toEqual([2,1]);
});

it('rejects overlapping or invalid exclusions and keeps v2 settings when a v1 client edits the rule',async()=>{
 const c=uuid();await op(c,0,'create',{name:'A'});
 expect((await op(c,1,'rule',{enabled:true,mode:'any',tag_refs:[IMG],exclude_tag_refs:[IMG]})).data.error).toBe('invalid_rule');
 expect((await op(c,1,'rule',{enabled:true,mode:'any',tag_refs:[IMG],admission:'later'})).data.error).toBe('invalid_rule');
 expect((await op(c,1,'rule',{enabled:true,mode:'any',tag_refs:[IMG],confirmed_only:1})).data.error).toBe('invalid_rule');
 expect((await op(c,1,'rule',{enabled:true,mode:'any',tag_refs:[IMG],exclude_tag_refs:['system/topics/nope']})).data.error).toBe('invalid_rule');
 expect((await op(c,1,'rule',{enabled:true,mode:'any',tag_refs:[IMG],exclude_tag_refs:[VID],admission:'review',confirmed_only:true})).status).toBe(200);
 // An old client may not send v2 fields, and its own rule edit leaves them untouched.
 expect((await op(c,2,'rule',{enabled:true,mode:'all',tag_refs:[IMG,UI],admission:'direct'},"1")).data.error).toBe('capability_mismatch');
 const v1=await op(c,2,'rule',{enabled:true,mode:'all',tag_refs:[IMG,UI]},"1");expect(v1.status).toBe(200);expect(v1.header).toBe("1");
 const col=(await call('collections/'+c)).data.collection;
 expect(col).toMatchObject({rule_mode:'all',rule_admission:'review',rule_confirmed_only:1});expect(JSON.parse(col.rule_exclude_tags)).toEqual([VID]);
 expect((await call('collections/review-summary',undefined,"1")).status).toBe(409);
 expect((await call('collections/review-summary')).header).toBe("2");
});

it('review admission queues candidates, accepts into the collection and never re-proposes ignored items',async()=>{
 const c=uuid();await op(c,0,'create',{name:'AIGC'});await op(c,1,'rule',{enabled:true,mode:'any',tag_refs:[IMG],admission:'review'});
 await link(2);await tag(2,['image_creation']);await link(3);await tag(3,['image_creation']);await link(4);await tag(4,['ui_design']);await drainCollectionRules(binding());
 expect(await items(c)).toEqual([]);
 let queue=(await call(`collections/${c}/rules/candidates`)).data;expect(queue.items.map((i:any)=>i.link_id)).toEqual([3,2]);expect(queue.items[0].matched_tags).toEqual([IMG]);
 const summary=(await call('collections/review-summary')).data;expect(summary).toMatchObject({total:2,items:[{collection_id:c,pending:2}]});
 expect((await call('collections')).data.items[0].pending_review_count).toBe(2);
 const accepted=await op(c,await rev(c),'review_accept',{link_ids:[2]});expect(accepted.status).toBe(200);
 expect(await items(c)).toEqual([2]);
 const detail=(await call('collections/'+c)).data;expect(detail.items[0].origin).toBe('rule');
 expect((await op(c,detail.collection.revision,'review_ignore',{link_ids:[3]})).status).toBe(200);
 expect((await call(`collections/${c}/rules/candidates`)).data.items).toEqual([]);
 expect((await call(`collections/${c}/rules/candidates?status=ignored`)).data.items.map((i:any)=>i.link_id)).toEqual([3]);
 // A later tag change re-queues the bookmark but its decision stands.
 await tag(3,[]);await tag(3,['image_creation']);await drainCollectionRules(binding());
 expect((await call(`collections/${c}/rules/candidates`)).data.items).toEqual([]);
 // Ignoring an already-decided candidate is a conflict; accepting an ignored one is allowed.
 expect((await op(c,await rev(c),'review_ignore',{link_ids:[3]})).data.error).toBe('candidate_not_found');
 expect((await op(c,await rev(c),'review_accept',{link_ids:[3]})).status).toBe(200);
 expect(await items(c)).toEqual([2,3]);
 expect((await op(c,await rev(c),'review_accept',{link_ids:[4]})).data.error).toBe('candidate_not_found');
 // A pending match that stops matching is withdrawn rather than ignored.
 await link(5);await tag(5,['image_creation']);await drainCollectionRules(binding());
 queue=(await call(`collections/${c}/rules/candidates`)).data;expect(queue.items.map((i:any)=>i.link_id)).toEqual([5]);
 await tag(5,['ui_design']);await drainCollectionRules(binding());
 expect((await call(`collections/${c}/rules/candidates`)).data.items).toEqual([]);
 expect((await call(`collections/${c}/rules/candidates?status=ignored`)).data.items).toEqual([]);
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM classification_runs').first('n')).toBe(0);
});

it('backfill in review mode proposes existing matches instead of adding them',async()=>{
 const c=uuid();await op(c,0,'create',{name:'AIGC'});await tag(1,['image_creation']);
 await op(c,1,'rule',{enabled:true,mode:'any',tag_refs:[IMG],admission:'review'});
 const preview=(await call(`collections/${c}/rules/preview`)).data;expect(preview.items.map((i:any)=>i.id)).toEqual([1]);
 expect((await op(c,preview.revision,'backfill')).status).toBe(200);
 expect(await items(c)).toEqual([]);
 expect((await call(`collections/${c}/rules/candidates`)).data.items.map((i:any)=>i.link_id)).toEqual([1]);
 expect((await call(`collections/${c}/rules/preview`)).data.counts.pending).toBe(1);
});

it('confirmed-only rules ignore automatic tags until a person confirms them',async()=>{
 const c=uuid();await op(c,0,'create',{name:'确认后'});await op(c,1,'rule',{enabled:true,mode:'any',tag_refs:[IMG],confirmed_only:true});
 await link(2);await tag(2,['image_creation']);await drainCollectionRules(binding());expect(await items(c)).toEqual([]);
 const tags=(await call('bookmarks/2/tags')).data;
 const confirm=await call('bookmarks/2/tags',{operation_key:uuid(),expected_revision:0,expected_decision_id:tags.decision_id,expected_content_revision:tags.content_revision,actions:[{action:'confirm',tag_ref:IMG}]});
 expect(confirm.status).toBe(200);
 await drainCollectionRules(binding());expect(await items(c)).toEqual([2]);
});
