import {applyD1Migrations,env,reset} from 'cloudflare:test';
import {beforeEach,it,expect} from 'vitest';
import worker from '../src/index';
const cid=()=>crypto.randomUUID();let collection:string;
const binding=()=>({DB:env.DB,ENRICHMENT_IMAGES:env.ENRICHMENT_IMAGES,CAIRN_API_TOKEN:'app',CAIRN_ENRICHER_TOKEN:'internal'});
async function call(path:string,body?:unknown,internal=false){return worker.fetch(new Request('https://example/api/'+(internal?'enrichment/':'')+'collections'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+(internal?'internal':'app'),'X-Cairn-Collections':'1','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),binding());}
async function json(r:Response){return await r.json() as any;}
async function start(mode='review',key=cid()){const r=await call('/organizing',{operation_key:key,collection_ids:[collection],mode});expect(r.status).toBe(200);return (await json(r)).run.id;}
async function finish(p=0.95){const claim=await json(await call('/organizing/claim',{},true));expect(claim.job).not.toBeNull();const body={request_hash:'a'.repeat(64),model:'jev-1.13.0',usage:{input_tokens:20,output_tokens:4},results:claim.job.items.map((i:any)=>({link_id:i.link_id,probabilities:{[collection]:i.link_id===1?p:0.2}}))};const r=await call('/organizing/batch/'+claim.job.batch_id+'/complete',body,true);expect(r.status).toBe(200);return {claim,body};}
async function members(){return (await json(await call('/'+collection))).items.map((i:any)=>i.link_id);}
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);for(let n=1;n<=2;n++)await env.DB.prepare("INSERT INTO links(id,url,note,created_at,original_text) VALUES(?,?,?,'2026-10-05',?)").bind(n,'https://example/'+n,'note '+n,'设计方法 '+n).run();collection=cid();await call('/'+collection+'/operations',{operation_key:cid(),expected_revision:0,type:'create',name:'网站设计',description:'网站改版参考'});});
it('defaults to review, stores each probability and only adds after explicit approval',async()=>{
 const run=await start();await finish();expect(await members()).toEqual([]);const d=await json(await call('/organizing/'+run));expect(d.run.mode).toBe('review');expect(d.items.every((i:any)=>i.status==='ready')).toBe(true);
 const key=cid(),body={operation_key:key,link_ids:[1],collection_ids:[collection],expected_revisions:{[collection]:1}};const a=await call('/organizing/'+run+'/apply',body);expect(a.status).toBe(200);expect(await members()).toEqual([1]);expect((await call('/organizing/'+run+'/apply',body)).status).toBe(200);expect((await json(await call('/'+collection))).collection.revision).toBe(2);
 expect((await call('/organizing/'+run+'/undo',{action_id:key})).status).toBe(200);expect(await members()).toEqual([]);expect((await call('/organizing/'+run+'/undo',{action_id:key})).status).toBe(200);
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM classification_jobs').first('n')).toBe(0);
});
it('direct mode uses only preselected matches and never changes collection definitions',async()=>{
 const run=await start('apply');await finish();expect(await members()).toEqual([1]);const d=await json(await call('/organizing/'+run));expect(d.run.auto_finished).toBe(1);expect(d.actions[0].actor).toBe('direct');const c=(await json(await call('/'+collection))).collection;expect(c.name).toBe('网站设计');expect(c.description).toBe('网站改版参考');expect(c.deleted).toBe(0);
 const before=c.revision;await call('/organizing/claim',{},true);expect((await json(await call('/'+collection))).collection.revision).toBe(before);
});
it('stale content or collection definitions reject both automatic and reviewed old selections',async()=>{
 const run=await start('apply');await env.DB.prepare('UPDATE collections SET name=?,revision=revision+1 WHERE id=?').bind('手动新名称',collection).run();await finish();expect(await members()).toEqual([]);let d=await json(await call('/organizing/'+run));expect(d.items.find((i:any)=>i.link_id===1).error).toContain('审核');
 expect((await call('/organizing/'+run+'/apply',{operation_key:cid(),link_ids:[1],collection_ids:[collection],expected_revisions:{[collection]:2}})).status).toBe(409);
 const next=await start();await finish();await env.DB.prepare('UPDATE links SET original_text=? WHERE id=1').bind('重新采集的新内容').run();expect((await call('/organizing/'+next+'/apply',{operation_key:cid(),link_ids:[1],collection_ids:[collection],expected_revisions:{[collection]:2}})).status).toBe(409);expect(await members()).toEqual([]);
});
it('undo retains existing memberships and refuses to erase later human changes',async()=>{
 await call('/'+collection+'/operations',{operation_key:cid(),expected_revision:1,type:'add',link_ids:[1]});const run=await start();await finish();const key=cid();expect((await call('/organizing/'+run+'/apply',{operation_key:key,link_ids:[1,2],collection_ids:[collection],expected_revisions:{[collection]:2}})).status).toBe(200);
 expect((await call('/organizing/'+run+'/undo',{action_id:key})).status).toBe(200);expect(await members()).toEqual([1]);
 const key2=cid();await call('/organizing/'+run+'/apply',{operation_key:key2,link_ids:[2],collection_ids:[collection],expected_revisions:{[collection]:4}});await call('/'+collection+'/operations',{operation_key:cid(),expected_revision:5,type:'note',link_id:2,note:'用户补写'});expect((await call('/organizing/'+run+'/undo',{action_id:key2})).status).toBe(409);expect(await members()).toEqual([1,2]);
});
it('model jobs require the private credential, validate complete coverage and survive budget deferral',async()=>{
 const run=await start();expect((await call('/organizing/claim',{})).status).toBe(403);const j=(await json(await call('/organizing/claim',{},true))).job;
 expect((await call('/organizing/batch/'+j.batch_id+'/complete',{results:[]},true)).status).toBe(400);expect((await call('/organizing/batch/'+j.batch_id+'/complete',{error:'budget_exhausted'},true)).status).toBe(200);
 const d=await json(await call('/organizing/'+run));expect(d.run.next_attempt_at).toBeTruthy();expect(d.items.every((i:any)=>i.status==='queued')).toBe(true);expect((await json(await call('/organizing/claim',{},true))).job).toBeNull();
 await env.DB.prepare("UPDATE collection_organizing_runs SET next_attempt_at=NULL WHERE id=?").bind(run).run();const j2=(await json(await call('/organizing/claim',{},true))).job;expect(j2.batch_id).not.toBe(j.batch_id);await env.DB.prepare("UPDATE collection_organizing_batches SET lease_until='2000-01-01' WHERE id=?").bind(j2.batch_id).run();await call('/organizing/claim',{},true);expect((await json(await call('/organizing/'+run))).items.every((i:any)=>i.status==='failed')).toBe(true);
});
it('concurrent approval retries reuse one receipt and privacy deletion removes identifying actions',async()=>{
 const run=await start();await finish();const key=cid();const body={operation_key:key,link_ids:[1],collection_ids:[collection],expected_revisions:{[collection]:1}};const r=await Promise.all(Array.from({length:4},()=>call('/organizing/'+run+'/apply',body)));expect(r.every(x=>x.status===200)).toBe(true);expect((await json(await call('/'+collection))).collection.revision).toBe(2);expect((await json(await call('/organizing/'+run))).actions).toHaveLength(1);
 await env.DB.prepare('DELETE FROM links WHERE id=1').run();const d=await json(await call('/organizing/'+run));expect(d.items.map((i:any)=>i.link_id)).toEqual([2]);expect(d.actions).toEqual([]);
});
