import test from 'node:test';
import assert from 'node:assert/strict';
import {createBatch,BATCH_KEY} from '../src/batch.mjs';
import {createController,emptyState} from '../src/controller.mjs';
import {STATE_KEY,tokenIdentity} from '../src/config.mjs';

async function setup() {
  const binding=await tokenIdentity('token'),data={[STATE_KEY]:{...emptyState(),settings:{token:'token',keepFullUrl:false}}},session={};
  let time=1000,id=1;const tabs=new Map(),opened=[],closed=[],queued=[];
  const area=values=>({get:async key=>({[key]:structuredClone(values[key])}),set:async patch=>Object.assign(values,structuredClone(patch)),remove:async key=>{delete values[key];}});
  const ext={storage:{local:area(data),session:area(session)},permissions:{contains:async()=>true},alarms:{create:async()=>{},clear:async()=>{}},tabs:{
    create:async()=>{const tab={id:id++,active:false,url:'about:blank'};tabs.set(tab.id,tab);opened.push(tab.id);return {...tab};},
    update:async(id,patch)=>Object.assign(tabs.get(id),patch),get:async id=>{if(!tabs.has(id))throw Error();return {...tabs.get(id)};},remove:async id=>{closed.push(id);tabs.delete(id);}
  }};
  const tasks=[1,2].map(id=>({id,url:`https://example.org/${id}?keep=1#part`,title:`文章 ${id}`,content_revision:1,app_body_revision:1}));
  const client={pending:async(_token,query)=>query.startsWith('/')?{item:tasks.find(t=>t.id===Number(query.slice(1)))}:{items:tasks,upper:2,next_after:null},receipt:async()=>null};
  const controller={snapshot:async()=>({configured:true,binding,queue:queued,lastResult:null}),enqueue:async job=>queued.push(job),flush:async()=>{}};
  const deps={ext,client,controller,now:()=>time,schedule:()=>{},capture:async()=>({protocol:2,text:'正文',title:'标题',images:[],media:[]}),probe:async id=>({url:tabs.get(id).url,valid:true,ready:true,signature:'stable'})};
  let batch=createBatch(deps);
  const advance=async(n=1)=>{for(let i=0;i<n;i++){await new Promise(r=>setImmediate(r));time+=4000;await batch.tick();}};
  const restart=()=>{batch=createBatch(deps);return batch;};
  return {get batch(){return batch;},deps,data,session,tabs,opened,closed,queued,tasks,advance,restart};
}

test('serial background tabs persist capture progress; restart does not duplicate a queued bookmark',async()=>{
  const f=await setup();await f.batch.start();await f.advance(4);
  assert.equal(f.queued.length,1);assert.equal(f.queued[0].url,f.tasks[0].url);assert.equal(f.queued[0].target.id,1);
  // Recreate the interruption window after enqueue but before its progress write.
  f.data[BATCH_KEY].tasks[0].status='capturing';f.restart();await f.advance(8);
  assert.equal(f.data[BATCH_KEY].status,'done');assert.equal(f.queued.length,2);
  assert.deepEqual(f.closed,f.opened);assert.equal(f.tabs.size,0);
});

test('challenge page is skipped, later tasks proceed, failures can be retried',async()=>{
  const f=await setup();f.deps.probe=async id=>id===1?{error:'batch_blocked'}:{url:f.tabs.get(id).url,valid:true,ready:true,signature:'ready'};f.restart();
  await f.batch.start();await f.advance(12);
  assert.equal(f.data[BATCH_KEY].tasks[0].error,'batch_blocked');assert.equal(f.queued.length,1);
  await f.batch.start('retry');await f.advance(8);
  assert.equal(f.data[BATCH_KEY].tasks[0].status,'captured');assert.equal(f.queued.length,2);
});

test('pause during extraction never enqueues; taking over a tab leaves it open',{timeout:5000},async()=>{
  const f=await setup();let resolve,started;
  const entered=new Promise(r=>{started=r;});
  f.deps.capture=()=>{started();return new Promise(r=>{resolve=r;});};f.restart();
  await f.batch.start();await f.advance(2);
  const work=f.advance(10);await entered;
  await f.batch.pause();resolve({text:'原文',images:[]});await work;
  assert.equal(f.queued.length,0);assert.equal(f.data[BATCH_KEY].status,'paused');
  await f.batch.start('resume');for(let i=0;i<5&&!f.data[BATCH_KEY].tabId;i++)await f.advance();
  const tab=f.tabs.get(f.data[BATCH_KEY].tabId);tab.active=true;await f.advance();
  assert.equal(f.data[BATCH_KEY].reason,'batch_active');assert.ok(f.tabs.has(tab.id));
});

test('a browser restart pauses without touching unowned tabs; changed targets are skipped',async()=>{
  const f=await setup();await f.batch.start();for(let i=0;i<5&&!f.data[BATCH_KEY].tabId;i++)await f.advance();
  const id=f.data[BATCH_KEY].tabId;delete f.session.cairn_batch_session;delete f.session.cairn_batch_tab;
  f.restart();await f.advance();assert.equal(f.data[BATCH_KEY].reason,'batch_restart');assert.ok(f.tabs.has(id));
  f.deps.client.pending=async()=>({item:null});await f.batch.start('resume');await f.advance(5);
  assert.equal(f.data[BATCH_KEY].status,'done');assert.equal(f.queued.length,0);assert.equal(f.opened.length,1);
});

test('targeted queue preserves full URLs and cannot be captured or transferred across accounts',async()=>{
  let state=emptyState();state.settings={token:'one',keepFullUrl:false};
  const controller=createController({store:{read:async()=>structuredClone(state),write:async s=>{state=structuredClone(s);}},client:{test:async()=>{}}});
  const item={url:'https://example.org/?article=2#body',client_id:crypto.randomUUID(),target:{id:1,content_revision:1,app_body_revision:1}};
  await assert.rejects(controller.enqueue({...item,binding:await tokenIdentity('two')}),{kind:'queue_connection'});
  await controller.enqueue({...item,binding:await tokenIdentity('one')});assert.equal(state.queue[0].url,item.url);
  await assert.rejects(controller.saveSettings({token:'two',keepFullUrl:true,movePending:true}),{kind:'batch_account'});
  assert.equal(state.settings.token,'one');
});

test('rescanning reuses existing queued captures and follows every listing page',async()=>{
  const f=await setup();f.queued.push({client_id:crypto.randomUUID(),target:{id:1},url:f.tasks[0].url});
  const queries=[];const original=f.deps.client.pending;
  f.deps.client.pending=async(token,query)=>{
    queries.push(query);
    if(query.startsWith('/'))return original(token,query);
    return query.includes('upper=2')?{items:[f.tasks[1]],upper:2,next_after:null}:{items:[f.tasks[0]],upper:2,next_after:1};
  };
  await f.batch.start();await f.advance(15);
  assert.equal(f.queued.length,2);assert.equal(f.opened.length,1);assert.ok(queries.includes('?after=1&upper=2'));assert.equal(f.data[BATCH_KEY].status,'done');
});

test('missing site permission never opens a tab; full upload queue pauses capture',async()=>{
  const f=await setup();f.deps.ext.permissions.contains=async()=>false;
  await assert.rejects(f.batch.start(),{kind:'batch_permission'});assert.equal(f.opened.length,0);
  f.deps.ext.permissions.contains=async()=>true;
  f.queued.push(...Array.from({length:100},()=>({client_id:crypto.randomUUID()})));
  await f.batch.start();await f.advance(5);
  assert.equal(f.data[BATCH_KEY].status,'paused');assert.equal(f.data[BATCH_KEY].reason,'queue_full');assert.equal(f.opened.length,0);
});
