import {applyD1Migrations,env,reset} from 'cloudflare:test';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import worker from '../src/index';
import {drainCustomTagClassification,readCustomJudgments} from '../src/custom-tag-classification';
const binding=()=>({DB:env.DB,ENRICHMENT_IMAGES:env.ENRICHMENT_IMAGES,CAIRN_API_TOKEN:'app',CAIRN_ENRICHER_TOKEN:'internal',TYPESAFE_API_KEY:'test-only',CAIRN_CUSTOM_TAG_AI_ENABLED:'1'});
const headers={Authorization:'Bearer app','X-Cairn-Tag-System':'1','X-Cairn-Collections':'2','Content-Type':'application/json'};
async function call(path:string,body?:unknown,method=body?'POST':'GET'){
 const r=await worker.fetch(new Request('https://dimensions.example/api/'+path,{method,headers,body:body?JSON.stringify(body):undefined}),binding());
 return {status:r.status,data:await r.json() as any};
}
const key=()=>crypto.randomUUID();
async function dimension(){const id=key();expect((await call('tag-catalog/operations',{id,type:'dimension_create',operation_key:key(),expected_revision:0,definition:{label:'难度',description:'所需的前置知识',ai_enabled:true}})).status).toBe(200);return id;}
async function tag(d:string){const r=await call('custom-tags',{operation_key:key(),label:'适合初学者',dimension_id:d,description:'不要求预备知识，解释基本概念并给出完整的入门步骤',ai_enabled:true});expect(r.status).toBe(200);return r.data.tag;}
const provider=(p=.96)=>vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({model:'jev-1.13.0',answers:{tag_0:{type:'noul',noul:p}}})));
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);await env.DB.prepare("INSERT INTO links(id,url,note,created_at,original_text) VALUES(1,'https://example.com/1','','2026-10-12','这是一篇零基础入门教程，先解释变量，再演示第一段程序。')").run();});
afterEach(()=>vi.restoreAllMocks());
it('creates, edits, archives and restores a type with stable identity, CAS and replay',async()=>{
 const id=await dimension(),body={id,type:'dimension_edit',operation_key:key(),expected_revision:1,definition:{label:'适用水平',color:3,ai_enabled:false}};
 expect((await call('tag-catalog/operations',body)).data.dimension).toMatchObject({id,label:'适用水平',revision:2,ai_enabled:0});
 expect((await call('tag-catalog/operations',body)).data.replayed).toBe(true);
 expect((await call('tag-catalog/operations',{...body,operation_key:key()})).data.error).toBe('revision_conflict');
 expect((await call('tag-catalog/operations',{...body,definition:{label:'changed'}})).data.error).toBe('operation_conflict');
 for(const [type,revision,archived] of [['dimension_archive',2,1],['dimension_restore',3,0]] as const){
  expect((await call('tag-catalog/operations',{id,type,operation_key:key(),expected_revision:revision})).data.dimension.archived).toBe(archived);
 }
 expect((await call('tag-catalog')).data.dimensions[0].id).toBe(id);
});
it('preserves definition metadata when an old client renames or archives a tag',async()=>{
 const d=await dimension(),t=await tag(d);
 const renamed=await call('custom-tags/'+t.id,{operation_key:key(),expected_revision:1,label:'入门'},'PATCH');
 expect(renamed.data.tag).toMatchObject({id:t.id,dimension_id:d,ai_enabled:true,label:'入门'});
 expect((await call('custom-tags/'+t.id,{operation_key:key(),expected_revision:2,detach_all:true},'DELETE')).data.tag.status).toBe('deprecated');
 expect((await call('custom-tags/'+t.id,{operation_key:key(),expected_revision:3,label:'入门',archived:false},'PATCH')).data.tag.status).toBe('active');
});
it('uses typed judgments, charges once, and skips fresh results',async()=>{
 await tag(await dimension());const fetcher=provider();await drainCustomTagClassification(binding());await drainCustomTagClassification(binding());
 expect(fetcher).toHaveBeenCalledTimes(1);
 const body=JSON.parse(String(fetcher.mock.calls[0][1]?.body));expect(body.questions.tag_0.instructions.dimension).toBe('难度');
 expect(await env.DB.prepare('SELECT origin FROM custom_tag_links WHERE link_id=1').first('origin')).toBe('ai');
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE scope='extension_global'").first('n')).toBe(1);
});
it('honors manual exclusions even when AI completes after the edit',async()=>{
 const t=await tag(await dimension());
 vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{
  const state=(await call('bookmarks/1/tags')).data;
  expect((await call('bookmarks/1/tags',{operation_key:key(),expected_revision:state.revision,actions:[{action:'detach',tag_ref:t.tag_ref}]})).status).toBe(200);
  return new Response(JSON.stringify({answers:{tag_0:{type:'noul',noul:.99}}}));
 });
 await drainCustomTagClassification(binding());
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM custom_tag_links').first('n')).toBe(0);
 expect(await env.DB.prepare('SELECT action FROM custom_tag_overrides').first('action')).toBe('detach');
});
it('manual mode prevents new calls and rejects an in-flight result after a switch',async()=>{
 const d=await dimension();await tag(d);
 const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{
  await call('tag-catalog/operations',{id:d,type:'dimension_edit',operation_key:key(),expected_revision:1,definition:{ai_enabled:false}});
  return new Response(JSON.stringify({answers:{tag_0:{type:'noul',noul:.99}}}));
 });
 await drainCustomTagClassification(binding());await drainCustomTagClassification(binding());
 expect(fetcher).toHaveBeenCalledTimes(1);expect(await env.DB.prepare('SELECT COUNT(*) n FROM custom_tag_links').first('n')).toBe(0);
});
it('does not repeat an ambiguous provider failure and never invents probabilities',async()=>{
 await tag(await dimension());const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('timeout'));
 await drainCustomTagClassification(binding());await drainCustomTagClassification(binding());expect(fetcher).toHaveBeenCalledTimes(1);
 expect(await env.DB.prepare('SELECT state FROM custom_tag_judgments').first('state')).toBe('failed');
 expect(()=>readCustomJudgments({answers:{tag_0:{type:'noul',noul:2}}},1)).toThrow();
 expect(()=>readCustomJudgments({answers:{}},1)).toThrow();
});
it('manual accepts remain human and undo restores an earlier AI origin',async()=>{
 const t=await tag(await dimension());provider();await drainCustomTagClassification(binding());
 let state=(await call('bookmarks/1/tags')).data;const operation=key();
 expect((await call('bookmarks/1/tags',{operation_key:operation,expected_revision:state.revision,actions:[{action:'attach',tag_ref:t.tag_ref}]})).status).toBe(200);
 expect(await env.DB.prepare('SELECT origin FROM custom_tag_links').first('origin')).toBe('human');
 state=(await call('bookmarks/1/tags')).data;
 expect((await call('bookmarks/1/tags',{operation_key:key(),expected_revision:state.revision,actions:[{action:'undo',operation_id:operation}]})).status).toBe(200);
 expect(await env.DB.prepare('SELECT origin FROM custom_tag_links').first('origin')).toBe('ai');
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM custom_tag_overrides').first('n')).toBe(0);
});
it('budget exhaustion prevents provider calls and queued classification respects tag manual mode',async()=>{
 const d=await dimension(),t=await tag(d);
 await call('custom-tags/'+t.id,{operation_key:key(),expected_revision:1,label:t.label,ai_enabled:false},'PATCH');
 const fetcher=provider();await drainCustomTagClassification(binding());expect(fetcher).not.toHaveBeenCalled();
 await call('custom-tags/'+t.id,{operation_key:key(),expected_revision:2,label:t.label,ai_enabled:true},'PATCH');
 for(let i=0;i<20;i++)await env.DB.prepare("INSERT INTO budget_ledger(scope,units,operation_key,created_at) VALUES('extension_global',?, ?, ?)").bind(JSON.stringify({tokens:65536,calls:1}),`spent-${i}`,new Date().toISOString()).run();
 await drainCustomTagClassification(binding());expect(fetcher).not.toHaveBeenCalled();
});
