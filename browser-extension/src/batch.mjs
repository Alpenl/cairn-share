import { CaptureError, STATE_KEY, MAX_QUEUE, tokenIdentity } from './config.mjs';
import { captureTab } from './capture.mjs';

export const BATCH_KEY = 'cairn_batch_v1';
export const BATCH_ALARM = 'cairn-batch';
const OWNER_KEY = 'cairn_batch_tab';
export const BATCH_ORIGINS = ['http://*/*','https://*/*'];

// Runs in the isolated world. Inspect the selected article, not a site's
// recommendations. Do not treat a login/challenge shell as an empty article.
export function probePage() {
  const visible = e => e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const u = new URL(location.href);
  const isX = /(^|\.)(x|twitter)\.com$/.test(u.hostname);
  const id = isX && u.pathname.match(/\/status\/(\d+)/)?.[1];
  let root;
  if (isX) root = id && [...document.querySelectorAll('article')].find(a => [...a.querySelectorAll('a[href]')].some(l => l.querySelector('time') && new URL(l.href).pathname.match(/\/status\/(\d+)/)?.[1] === id));
  else if (u.hostname === 'mp.weixin.qq.com') root = document.querySelector('#js_content');
  else root = document.querySelector('article,main,[role="main"]');
  const text = (root?.innerText || '').trim();
  const blockedTitle = /^(just a moment|access denied|attention required|登录|安全验证|访问受限|环境异常|验证|login|sign in|page not found|404)/i.test(document.title.trim());
  const blocked = blockedTitle || [...document.querySelectorAll('input[type=password],iframe[src*="captcha"],#captcha,.verify_area')].some(visible) && text.length < 200;
  if (blocked) return {error:'batch_blocked',url:location.href};
  if (/\/(login|signin|i\/flow\/login)(\/|$)/i.test(u.pathname)) return {error:'batch_blocked',url:location.href};
  // Generic sites without semantic markup may still be extracted, but require
  // substantial text to avoid saving an error or a navigation-only shell.
  if (!root && !isX && u.hostname !== 'mp.weixin.qq.com') root = document.body;
  const content = (root?.innerText || '').trim();
  const valid = !!root && (content.length >= (isX ? 1 : root === document.body ? 200 : 40) || !!root.querySelector('video,img[src],img[data-src]'));
  let hash=0;for(const c of content.slice(0,50000))hash=(Math.imul(hash,31)+c.charCodeAt(0))|0;
  return {url:location.href,valid,signature:`${content.length}:${hash}`,ready:document.readyState !== 'loading'};
}

export function createBatch({ext,controller,client,capture=captureTab,now=Date.now,schedule=fn=>setTimeout(fn,1500),probe=async id => {
  const [{result}] = await ext.scripting.executeScript({target:{tabId:id},func:probePage});
  return result;
}}) {
  let mutations = Promise.resolve(), running = null, timer;
  const read = async () => (await ext.storage.local.get(BATCH_KEY))[BATCH_KEY] ?? {status:'idle',tasks:[]};
  const edit = fn => {
    const op = mutations.then(async () => {const s=await read(); const result=await fn(s); await ext.storage.local.set({[BATCH_KEY]:s});return result;});
    mutations=op.catch(()=>{});return op;
  };
  const snapshot = async () => {await mutations;const {binding,...s}=await read();return s;};
  const live = async id => {const s=await read();return s.run===id && s.status==='running';};
  const commit = (run,fn) => edit(s => {if(s.run===run && s.status==='running')return fn(s);});
  async function credentials(binding) {
    const settings=(await ext.storage.local.get(STATE_KEY))[STATE_KEY]?.settings;
    if(!settings?.token)throw new CaptureError('not_configured');
    if(await tokenIdentity(settings.token)!==binding)throw new CaptureError('batch_connection');
    return settings.token;
  }
  async function closeOwned(id) {
    if(!id)return;
    const owned=(await ext.storage.session.get(OWNER_KEY))[OWNER_KEY];
    if(owned?.id!==id)return;
    await ext.storage.session.remove(OWNER_KEY);
    const tab=await ext.tabs.get(id).catch(()=>null);
    // If the user takes over this tab, leave it open for manual work.
    if(tab && !tab.active)await ext.tabs.remove(id).catch(()=>{});
  }
  async function pause(reason='') {
    let id;
    await edit(s=>{if(s.status!=='running')return; s.status='paused';s.reason=reason;s.run=crypto.randomUUID();id=s.tabId;delete s.tabId;});
    clearTimeout(timer);await closeOwned(id);return snapshot();
  }
  async function start(mode='new') {
    if(!(await ext.permissions.contains({origins:BATCH_ORIGINS})))throw new CaptureError('batch_permission');
    const state=await controller.snapshot();
    if(!state.configured)throw new CaptureError('not_configured');
    await edit(s=>{
      if(s.status==='running')return;
      if(mode!=='new' && s.binding!==state.binding)throw new CaptureError('batch_connection');
      if(mode==='new')Object.assign(s,{tasks:[],after:0,upper:null,listed:false,binding:state.binding,startedAt:now()});
      if(mode==='retry')s.tasks.forEach(t=>{if(t.status==='failed'){t.status='waiting';t.error='';t.client_id=crypto.randomUUID();}});
      s.status='running';s.reason='';s.run=crypto.randomUUID();delete s.tabId;
    });
    await ext.storage.session.set({cairn_batch_session:true});
    await ext.alarms.create(BATCH_ALARM,{periodInMinutes:1});
    void tick().catch(()=>{});return snapshot();
  }
  async function finish(s,task,status,error='') {
    await commit(s.run,current=>{const t=current.tasks.find(t=>t.client_id===task.client_id);if(t)Object.assign(t,{status,error});delete current.tabId;delete current.sample;delete current.stableAt;});
    await closeOwned(s.tabId);
  }
  async function step() {
    const s=await read();if(s.status!=='running')return;
    if(!(await ext.storage.session.get('cairn_batch_session')).cairn_batch_session){await pause('batch_restart');return;}
    const token=await credentials(s.binding);
    if(!(await ext.permissions.contains({origins:BATCH_ORIGINS})))throw new CaptureError('batch_permission');
    if(!s.listed){
      const page=await client.pending(token,`?after=${s.after}${s.upper===null?'':`&upper=${s.upper}`}`);
      if(!Array.isArray(page.items) || !Number.isSafeInteger(page.upper) || page.items.some(t=>!Number.isSafeInteger(t.id) || t.id<=s.after || t.id>page.upper || typeof t.url!=='string') || (page.next_after!==null && (!Number.isSafeInteger(page.next_after)||page.next_after<=s.after)))throw new CaptureError('response');
      const queued=(await controller.snapshot()).queue;
      await commit(s.run,current=>{current.tasks.push(...page.items.map(t=>{
        const existing=queued.find(job=>job.target?.id===t.id && job.url===t.url);
        return {...t,client_id:existing?.client_id || crypto.randomUUID(),status:existing?'captured':'waiting'};
      }));current.upper=page.upper;current.after=page.next_after;current.listed=page.next_after===null;});return;
    }
    const task=s.tasks.find(t=>t.status==='waiting' || t.status==='opening' || t.status==='capturing');
    if(!task){await commit(s.run,current=>{current.status='done';current.finishedAt=now();});return;}
    const queue=await controller.snapshot();
    if(queue.queue.some(j=>j.client_id===task.client_id) || queue.lastResult?.client_id===task.client_id){await finish(s,task,'captured');return;}
    // Covers a worker death after enqueue/upload but before batch progress was
    // committed; the receipt prevents re-extracting into a different manifest.
    if(task.status==='capturing'){
      let receipt;
      try {receipt=await client.receipt(token,task.client_id);} catch(error) {
        if(['capture_deleted','media_stale'].includes(error.kind)){await finish(s,task,'skipped','capture_not_pending');return;}
        throw error;
      }
      if(receipt?.completed){await finish(s,task,'captured');return;}
    }
    if(queue.queue.length>=MAX_QUEUE){await pause('queue_full');return;}
    if(!s.tabId){
      const {item}=await client.pending(token,`/${task.id}`);
      if(!item || ['url','content_revision','app_body_revision'].some(key=>item[key]!==task[key])){await finish(s,task,'skipped','capture_not_pending');return;}
      if(!await live(s.run))return;
      // Persist ownership before navigating. A crash during creation can at
      // most leave an inert blank tab, never an untracked article task.
      const tab=await ext.tabs.create({url:'about:blank',active:false});
      await ext.storage.session.set({[OWNER_KEY]:{id:tab.id,run:s.run}});
      await commit(s.run,current=>{current.tabId=tab.id;current.openedAt=now();delete current.sample;delete current.stableAt;current.tasks.find(t=>t.client_id===task.client_id).status='opening';});
      if(!await live(s.run)){await closeOwned(tab.id);return;}
      await ext.tabs.update(tab.id,{url:task.url});return;
    }
    const owned=(await ext.storage.session.get(OWNER_KEY))[OWNER_KEY];
    if(owned?.id!==s.tabId){await pause('batch_restart');return;}
    const tab=await ext.tabs.get(s.tabId).catch(()=>null);
    if(!tab){await finish(s,task,'failed','batch_closed');return;}
    if(tab.active){await pause('batch_active');return;}
    if(now()-s.openedAt>45000){await finish(s,task,'failed','batch_timeout');return;}
    if(tab.url==='about:blank'){await ext.tabs.update(s.tabId,{url:task.url});return;}
    if(!tab.url)return;
    let page;
    try {page=await probe(s.tabId);} catch {return;} // Navigation may be between documents.
    if(page?.error){await finish(s,task,'failed',page.error);return;}
    if(!page?.valid || !page.ready)return;
    if(page.signature!==s.sample || page.url!==s.documentURL){await commit(s.run,current=>{current.sample=page.signature;current.documentURL=page.url;current.stableAt=now();});return;}
    if(now()-s.stableAt<3000)return;
    await commit(s.run,current=>{current.tasks.find(t=>t.client_id===task.client_id).status='capturing';});
    try {
      const content=await capture(ext,s.tabId,page.url,task.client_id);
      if(!content.text?.trim())throw new CaptureError('batch_empty');
      if(!await live(s.run))return;
      await controller.enqueue({url:task.url,title:content.title,client_id:task.client_id,capture:content,binding:s.binding,
        target:{id:task.id,content_revision:task.content_revision,app_body_revision:task.app_body_revision}});
      await finish(s,task,'captured');
      void controller.flush().catch(()=>{});
    } catch(error) {
      if(['queue_full','storage','queue_connection'].includes(error.kind))throw error;
      await finish(s,task,'failed',error.kind || 'capture_unavailable');
    }
  }
  function tick() {
    if(running)return running;
    clearTimeout(timer);
    running=(async()=>{
      try {await step();} catch(e){await pause(e.kind || 'unexpected');}
      finally {
        if((await read()).status==='running')timer=schedule(()=>void tick().catch(()=>{}));
        else await ext.alarms.clear(BATCH_ALARM);
      }
    })().finally(()=>{running=null;});
    return running;
  }
  return {snapshot,start,pause,tick};
}
