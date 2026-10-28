import assert from 'node:assert/strict';
import test from 'node:test';
import {createClient} from '../src/api.mjs';
import {createController,emptyState} from '../src/controller.mjs';

const token='cairn_c_'+'a'.repeat(64);
const go='https://cairn-go.alpenl.com/api/v1/collector';
const ok=(data)=>new Response(JSON.stringify({code:'OK',data}),{headers:{'X-Cairn-Collections':'1'}});

test('capture token uses the scoped Go API; legacy credentials keep the original backend',async()=>{
 const requests=[];
 const client=createClient({fetchImpl:async(url,options)=>{requests.push({url,options});return url.includes('/lookup?')?ok({saved:false}):ok({items:[]});}});
 await client.test(token);await client.collections(token);await client.lookup(token,'https://example.test/a');
 assert.ok(requests.every(r=>r.url.startsWith(go+'/')));
 assert.ok(requests.every(r=>r.options.headers.Authorization===`Bearer ${token}` && r.options.credentials==='omit' && r.options.redirect==='error'));
 const legacy=createClient({fetchImpl:async(url)=>{requests.push({url});return new Response(JSON.stringify({items:[]}));}});
 await legacy.test('old-token');assert.equal(requests.at(-1).url,'https://share.alpenl.com/api/links?limit=1');
});

test('lost text response is recovered from receipt before posting or uploading again',async()=>{
 const job={client_id:crypto.randomUUID(),url:'https://example.test/a#fragment',note:'note',attempts:1,capture:{protocol:2,text:'clean Markdown',title:'title',images:[],media:[]}};
 const receipt={id:7,url:job.url,note:job.note,completed:true,reuse_existing:true,capture_result:{images_saved:0}};
 const calls=[];const client=createClient({fetchImpl:async(url,options)=>{calls.push({url,options});return ok(receipt)}});
 const result=await client.upload(token,job);
 assert.equal(result.id,7);assert.equal(calls.length,1);assert.equal(calls[0].options.method,'GET');
 assert.equal(calls[0].url,`${go}/captures/v2/${job.client_id}`);
});

test('capture sends personal/content guards, and scoped API conflicts remain actionable',async()=>{
 const job={client_id:crypto.randomUUID(),url:'https://example.test/a',note:'',attempts:0,expected:{id:7,content_revision:3,personal_revision:9},capture:{protocol:2,text:'clean text',title:'title',images:[],media:[]}};
 let sent;
 const client=createClient({fetchImpl:async(url,options)=>{sent=JSON.parse(options.body);return new Response(JSON.stringify({code:'capture_not_pending'}),{status:409})}});
 await assert.rejects(client.upload(token,job),e=>e.kind==='capture_not_pending');
 assert.deepEqual(sent.expected,job.expected);assert.equal(sent.capture.text,'clean text');
});

test('old queued content cannot silently move to the Go library and tokens stay out of snapshots',async()=>{
 let state=emptyState();state.settings.token='legacy-token';
 const controller=createController({store:{read:async()=>structuredClone(state),write:async s=>{state=structuredClone(s)}},client:{test:async()=>{}}});
 await controller.enqueue({client_id:crypto.randomUUID(),url:'https://example.test/a',capture:{protocol:2,text:'original',images:[],media:[]}});
 await assert.rejects(controller.saveSettings({token,keepFullUrl:true}),e=>e.kind==='queue_connection');
 assert.equal(state.settings.token,'legacy-token');assert.equal(state.queue.length,1);
 await controller.saveSettings({token,keepFullUrl:true,movePending:true});
 const snapshot=await controller.snapshot();assert.equal(snapshot.server,'cairn-go.alpenl.com');assert.ok(!JSON.stringify(snapshot).includes(token));assert.equal(state.queue.length,1);
});

test('deletion uses the scoped endpoint and rechecks before each batch page',async()=>{
 const calls=[];const client=createClient({collectorBase:'https://cairn.alpenl.com/api/v1/collector',fetchImpl:async(url,options)=>{
  calls.push({url,options});return ok(options.method==='DELETE'?{id:9,deleted:true,revision:3}:{batch_version:1,item:null});
 }});
 assert.deepEqual(await client.pending(token,'/9'),{batch_version:1,item:null});
 await client.deleteSaved(token,9,{operation_key:'delete',expected_revision:2});
 assert.equal(calls[0].url,'https://cairn.alpenl.com/api/v1/collector/captures/v2/pending/9');
 assert.equal(calls[1].url,'https://cairn.alpenl.com/api/v1/collector/links/9');
 assert.equal(calls[1].options.method,'DELETE');
});

test('delete response loss survives restart, blocks stale uploads and retries the same intent',async()=>{
 let state=emptyState();state.settings={token,server:'https://cairn.alpenl.com',keepFullUrl:true};
 const calls=[];let lost=true,uploads=0;
 const client={upload:async()=>{uploads++;throw Error('unexpected upload')},deleteSaved:async(_token,id,body)=>{calls.push({id,body});if(lost){lost=false;throw Object.assign(Error(),{kind:'network'})}return {id,deleted:true}}};
 const create=()=>createController({store:{read:async()=>structuredClone(state),write:async s=>{state=structuredClone(s)}},client});
 let c=create();const binding=(await c.snapshot()).binding,url='https://example.test/deleted';
 await c.enqueue({client_id:crypto.randomUUID(),url,binding,expected:{id:7,personal_revision:2}});
 await assert.rejects(c.deleteSaved({id:7,revision:2,url,binding}),e=>e.kind==='network');
 c=create();await c.flush({force:true});assert.equal(uploads,0);
 await assert.rejects(c.enqueue({client_id:crypto.randomUUID(),url,binding}),e=>e.kind==='delete_pending');
 await assert.rejects(c.deleteSaved({id:7,revision:2,url,binding:'different'}),e=>e.kind==='queue_connection');
 await c.deleteSaved({id:7,revision:2,url,binding});
 assert.deepEqual(calls[0],calls[1]);assert.equal(state.queue.length,0);assert.equal(state.deletion,undefined);
 assert.ok(!JSON.stringify(await c.snapshot()).includes(token));
});

test('delete waits for an active upload and conflicts require a new confirmation',async()=>{
 let state=emptyState();state.settings={token,keepFullUrl:true};let release,started;
 const uploading=new Promise(r=>{started=r}),waiting=new Promise(r=>{release=r});const calls=[];
 const c=createController({store:{read:async()=>structuredClone(state),write:async s=>{state=structuredClone(s)}},client:{upload:async(_token,job)=>{started();await waiting;calls.push('upload');return {id:7,url:job.url,note:''}},deleteSaved:async()=>{calls.push('delete');throw Object.assign(Error(),{kind:'revision_conflict'})}}});
 const binding=(await c.snapshot()).binding,url='https://example.test/delete';
 await c.enqueue({client_id:crypto.randomUUID(),url});const flush=c.flush();await uploading;
 const deletion=c.deleteSaved({id:7,revision:1,url,binding});release();await flush;
 await assert.rejects(deletion,e=>e.kind==='revision_conflict');assert.deepEqual(calls,['upload','delete']);assert.equal(state.deletion,undefined);
});
