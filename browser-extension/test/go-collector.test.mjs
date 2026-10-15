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
