import assert from 'node:assert/strict';
import test from 'node:test';
import {createClient} from '../src/api.mjs';
import {createController,emptyState} from '../src/controller.mjs';
import {createTagSync,nextTagCache,shortLabel,tagSize,TAG_CACHE_KEY} from '../src/tags.mjs';

const token='cairn_c_'+'a'.repeat(64);
const go='https://cairn-go.alpenl.com/api/v1/collector';
const catalog=(version,refs=['system/topics/a'])=>({catalog_version:version,dimensions:[{id:'topics',label:'主题',color:0,selection_mode:'multiple',tags:refs.map(ref=>({tag_ref:ref,label:ref.split('/').pop(),count:1}))},{id:'forms',label:'形式',color:5,selection_mode:'single',tags:[]}]});
const ok=(data,headers={})=>new Response(JSON.stringify({code:'OK',data}),{headers});

test('tag catalog is read from the Go collector with a conditional version check',async()=>{
 const requests=[];let reply;
 const client=createClient({fetchImpl:async(url,options)=>{requests.push({url,options});return reply();}});
 assert.equal(await client.tags('legacy-token'),null);
 assert.equal(requests.length,0,'legacy libraries are never asked for tags');
 reply=()=>ok(catalog(18),{ETag:'W/"tags-18"'});
 const first=await client.tags(token);
 assert.equal(requests[0].url,`${go}/tags`);assert.equal(requests[0].options.headers['If-None-Match'],undefined);
 assert.deepEqual(first,{catalog:catalog(18),etag:'W/"tags-18"'});
 reply=()=>new Response(null,{status:304});
 assert.deepEqual(await client.tags(token,'W/"tags-18"'),{notModified:true});
 assert.equal(requests[1].options.headers['If-None-Match'],'W/"tags-18"');
 reply=()=>new Response('{}',{status:404});
 assert.equal(await client.tags(token),null,'older Go servers without the endpoint hide the section');
 reply=()=>ok({catalog_version:'18',dimensions:[]});
 await assert.rejects(client.tags(token),e=>e.kind==='response');
 reply=()=>{throw new TypeError('offline');};
 await assert.rejects(client.tags(token,'W/"tags-18"'),e=>e.kind==='network');
});

test('a newer library version is announced, not applied, until an explicit refresh',()=>{
 const binding='b1';
 const first=nextTagCache(null,{binding,result:{catalog:catalog(18),etag:'e18'},mode:'refresh',now:1});
 assert.equal(first.cache.version,18);assert.equal(first.cache.dimensions.length,1,'empty dimensions are dropped');assert.deepEqual(first.added,[]);
 const same=nextTagCache(first.cache,{binding,result:{notModified:true},mode:'check',now:2});
 assert.equal(same.cache.checkedAt,2);assert.equal(same.cache.update,null);assert.equal(same.cache.syncedAt,1);
 const newer=catalog(19,['system/topics/a','system/topics/b','system/topics/c']);
 const stale=nextTagCache(first.cache,{binding,result:{catalog:newer,etag:'e19'},mode:'check',now:3});
 assert.equal(stale.cache.version,18);assert.equal(stale.cache.etag,'e18');assert.deepEqual(stale.cache.dimensions,first.cache.dimensions);
 assert.deepEqual(stale.cache.update,{version:19,added:2});
 const refreshed=nextTagCache(stale.cache,{binding,result:{catalog:newer,etag:'e19'},mode:'refresh',now:4});
 assert.equal(refreshed.cache.version,19);assert.equal(refreshed.cache.update,null);assert.deepEqual(refreshed.added,['system/topics/b','system/topics/c']);
 const other=nextTagCache(refreshed.cache,{binding:'b2',result:{catalog:catalog(3),etag:'x'},mode:'refresh',now:5});
 assert.equal(other.cache.binding,'b2');assert.deepEqual(other.added,[],'another library is not compared with this one');
 assert.deepEqual(nextTagCache(first.cache,{binding,result:null,mode:'check',now:6}).cache,{binding,unsupported:true,checkedAt:6});
});

test('tag sync stores the cache, sends the cached ETag only for checks and shares concurrent calls',async()=>{
 const data={};const storage={get:async k=>({[k]:structuredClone(data[k])}),set:async v=>Object.assign(data,structuredClone(v)),remove:async k=>{delete data[k];}};
 const asked=[];let answer={catalog:catalog(18),etag:'e18'};
 const controller={snapshot:async()=>({binding:'b1'}),tags:async etag=>{asked.push(etag);await new Promise(r=>setTimeout(r,5));return {binding:'b1',result:answer};}};
 const sync=createTagSync({storage,controller,now:()=>7});
 const [a,b]=await Promise.all([sync.sync('check'),sync.sync('check')]);
 assert.equal(a,b);assert.deepEqual(asked,[undefined],'no cache: one unconditional fetch');
 assert.equal(data[TAG_CACHE_KEY].version,18);
 answer={notModified:true};await sync.sync('check');assert.equal(asked[1],'e18');
 answer={catalog:catalog(18),etag:'e18'};await sync.sync('refresh');assert.equal(asked[2],undefined);
 await sync.clear();assert.equal(data[TAG_CACHE_KEY],undefined);
});

test('chosen tags travel with a Go capture and the receipt count reaches the result',async()=>{
 let stored=emptyState();const bodies=[];
 const http=createClient({fetchImpl:async(url,options)=>{
  if(!options.body)return ok({items:[]});
  const body=JSON.parse(options.body);bodies.push(body);
  return ok({id:5,url:body.url,note:body.note,completed:true,reuse_existing:true,capture_result:{action:'saved',images_saved:0,tags_saved:2}});
 }});
 const controller=createController({store:{read:async()=>structuredClone(stored),write:async s=>{stored=structuredClone(s)}},client:http});
 const {binding}=await controller.saveSettings({token,keepFullUrl:true});
 const refs=['system/topics/a','system/carriers/web'];
 await assert.rejects(controller.enqueue({client_id:crypto.randomUUID(),url:'https://example.test/a',tag_refs:['x','x'],binding}),e=>e.kind==='invalid_tags');
 await assert.rejects(controller.enqueue({client_id:crypto.randomUUID(),url:'https://example.test/a',tag_refs:refs,binding:'other'}),e=>e.kind==='queue_connection');
 await controller.enqueue({client_id:crypto.randomUUID(),url:'https://example.test/a',tag_refs:refs,binding,capture:{protocol:2,text:'正文',title:'t',images:[],media:[]}});
 await controller.enqueue({client_id:crypto.randomUUID(),url:'https://example.test/b',binding});
 await controller.flush();
 assert.deepEqual(bodies[0].tag_refs,refs);assert.equal('tag_refs' in bodies[1],false,'no tags: the field is omitted');
 const snap=await controller.snapshot();assert.equal(snap.queue.length,0);assert.equal(snap.lastResult.tagsSaved,2);

 let legacy=emptyState();
 const old=createController({store:{read:async()=>structuredClone(legacy),write:async s=>{legacy=structuredClone(s)}},client:{test:async()=>{}}});
 const connected=await old.saveSettings({token:'legacy-token',keepFullUrl:true});
 await assert.rejects(old.enqueue({client_id:crypto.randomUUID(),url:'https://example.test/a',tag_refs:refs,binding:connected.binding}),e=>e.kind==='invalid_tags');
});

test('chip sizes step with usage relative to the busiest tag; long dimension names shorten',()=>{
 assert.deepEqual([6,5,4,3,2,0].map(n=>tagSize(n,6)),['s3','s3','s2','s2','s1','s1']);
 assert.equal(tagSize(0,0),'s1');
 assert.deepEqual(['主题','资源类型','内容功能','载体','自定义'].map(shortLabel),['主题','类型','功能','载体','自定义']);
});
