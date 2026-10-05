import type { Env } from './index';
import { collectionID, collectionsRoute } from './collections';
import { readJSONObject } from './json-body';
import { canonicalJSON } from './domain';
const reply=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store','X-Cairn-Collections':'1'}});
const fail=(error:string,status=400)=>reply({error},status);
const ids=(v:unknown,max=1000):v is number[]=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(x=>Number.isSafeInteger(x)&&x>0)&&new Set(v).size===v.length;
async function hash(v:unknown){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJSON(v))))].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function operationID(v:unknown){const s=await hash(v);return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20,32)}`;}
type Definition={id:string;name:string;description:string;revision:number;archived:number;deleted:number};
type Run={id:string;mode:'review'|'apply';definitions:string;created_at:string;next_attempt_at:string|null;auto_finished:number;create_request_hash:string};
type Item={link_id:number;content_revision:number;status:string;probabilities:string;error:string};
type Payload={link_ids:number[];collection_ids:string[];expected_revisions:Record<string,number>};
type Receipt={revision:number;added:number[];undone?:boolean};
async function run(env:Env,id:string){return env.DB.prepare('SELECT * FROM collection_organizing_runs WHERE id=?').bind(id).first<Run>();}
async function detail(env:Env,id:string){const current=await run(env,id);if(!current)return fail('not_found',404);const items=await env.DB.prepare("SELECT i.*,COALESCE(NULLIF(l.ai_title,''),l.url) AS title,l.url FROM collection_organizing_items i JOIN links l ON l.id=i.link_id WHERE run_id=? ORDER BY i.link_id DESC").bind(id).all<Item>();const actions=await env.DB.prepare('SELECT id,status,actor,created_at,payload,receipts FROM collection_organizing_actions WHERE run_id=? ORDER BY created_at DESC LIMIT 100').bind(id).all();return reply({run:{...current,definitions:JSON.parse(current.definitions)},items:items.results.map(i=>({...i,probabilities:JSON.parse(i.probabilities)})),actions:actions.results.map(a=>({...a,payload:JSON.parse(a.payload as string),receipts:JSON.parse(a.receipts as string)}))});}
async function definitionsCurrent(env:Env,current:Run,selection:string[]){const saved=JSON.parse(current.definitions) as Definition[];const rows=await env.DB.prepare('SELECT id,name,description,revision,archived,deleted FROM collections WHERE id IN(SELECT value FROM json_each(?))').bind(JSON.stringify(selection)).all<Definition>();return rows.results.length===selection.length&&rows.results.every(c=>{const old=saved.find(d=>d.id===c.id);return old&&c.name===old.name&&c.description===old.description&&!c.deleted&&!c.archived;});}
async function apply(env:Env,current:Run,key:string,payload:Payload,actor:string){
 const requestHash=await hash([current.id,payload,actor]);let action=await env.DB.prepare('SELECT * FROM collection_organizing_actions WHERE id=?').bind(key).first<{request_hash:string;receipts:string;status:string}>();
 if(action&&(action.request_hash!==requestHash))return fail('operation_conflict',409);
 if(action?.status==='applied')return reply({action_id:key,status:'applied',receipts:JSON.parse(action.receipts),replayed:true});
 if(action?.status==='undone'||action?.status==='undoing')return fail('action_undone',409);
 if(!await definitionsCurrent(env,current,payload.collection_ids))return fail('preselection_stale',409);
 const input=await env.DB.prepare('SELECT i.link_id FROM collection_organizing_items i JOIN links l ON l.id=i.link_id WHERE run_id=? AND i.link_id IN(SELECT value FROM json_each(?)) AND i.content_revision=l.content_revision AND i.status IN(\'ready\',\'applied\')').bind(current.id,JSON.stringify(payload.link_ids)).all();
 if(input.results.length!==payload.link_ids.length)return fail('preselection_stale',409);
 if(!action){await env.DB.prepare('INSERT OR IGNORE INTO collection_organizing_actions(id,run_id,request_hash,payload,actor,created_at) VALUES(?,?,?,?,?,?)').bind(key,current.id,requestHash,JSON.stringify(payload),actor,new Date().toISOString()).run();action=await env.DB.prepare('SELECT request_hash,receipts,status FROM collection_organizing_actions WHERE id=?').bind(key).first();if(!action||action.request_hash!==requestHash)return fail('operation_conflict',409);}
 const receipts=JSON.parse(action.receipts) as Record<string,Receipt>;
 for(const cid of payload.collection_ids){
  if(receipts[cid])continue;
  // Record the exact newly-added set before the membership transaction, so a
  // lost response does not turn pre-existing manual memberships into undo targets.
  const before=await env.DB.prepare('SELECT link_id FROM collection_items WHERE collection_id=? AND link_id IN(SELECT value FROM json_each(?))').bind(cid,JSON.stringify(payload.link_ids)).all<{link_id:number}>();
  const exists=new Set(before.results.map(r=>r.link_id));
  const planKey='plan:'+cid;
  if(!receipts[planKey]){
   receipts[planKey]={revision:payload.expected_revisions[cid],added:payload.link_ids.filter(id=>!exists.has(id))};
   await env.DB.prepare("UPDATE collection_organizing_actions SET receipts=json_set(receipts,?,json(?)) WHERE id=? AND json_type(receipts,?) IS NULL").bind('$.'+JSON.stringify(planKey),JSON.stringify(receipts[planKey]),key,'$.'+JSON.stringify(planKey)).run();
  }
  const refreshed=await env.DB.prepare('SELECT receipts FROM collection_organizing_actions WHERE id=?').bind(key).first<{receipts:string}>();Object.assign(receipts,JSON.parse(refreshed!.receipts));if(receipts[cid])continue;
  const response=await collectionsRoute(new Request('https://internal/api',{method:'POST',headers:{'Content-Type':'application/json','X-Cairn-Collections':'1'},body:JSON.stringify({operation_key:await operationID([key,cid]),expected_revision:payload.expected_revisions[cid],type:'add',link_ids:payload.link_ids})}),env,`/api/collections/${cid}/operations`,{runID:current.id,linkIDs:payload.link_ids,actionID:key});
  if(!response.ok)return reply({...(await response.json() as object),action_id:key,partial:Object.keys(receipts).some(k=>!k.startsWith('plan:'))},response.status);
  const result=await response.json() as {revision:number};receipts[cid]={revision:result.revision,added:receipts[planKey].added};
  await env.DB.prepare('UPDATE collection_organizing_actions SET receipts=json_set(receipts,?,json(?)) WHERE id=?').bind('$.'+JSON.stringify(cid),JSON.stringify(receipts[cid]),key).run();
 }
 await env.DB.batch([env.DB.prepare("UPDATE collection_organizing_actions SET status='applied' WHERE id=? AND status='pending'").bind(key),env.DB.prepare("UPDATE collection_organizing_items SET status='applied',error='' WHERE run_id=? AND link_id IN(SELECT value FROM json_each(?))").bind(current.id,JSON.stringify(payload.link_ids))]);
 const final=await env.DB.prepare('SELECT status FROM collection_organizing_actions WHERE id=?').bind(key).first<string>('status');if(final!=='applied')return fail('action_undone',409);
 return reply({action_id:key,status:'applied',receipts});
}
async function autoApply(env:Env,current:Run){
 if(current.mode!=='apply'||current.auto_finished)return;
 const waiting=await env.DB.prepare("SELECT COUNT(*) AS n FROM collection_organizing_items WHERE run_id=? AND status IN('queued','processing')").bind(current.id).first<number>('n');if(waiting)return;
 const items=(await env.DB.prepare("SELECT * FROM collection_organizing_items WHERE run_id=? AND status IN('ready','applied') ORDER BY link_id").bind(current.id).all<Item>()).results;
 for(const c of JSON.parse(current.definitions) as Definition[]){
  const matching=items.filter(i=>Number(JSON.parse(i.probabilities)[c.id])>=0.8).map(i=>i.link_id);
  for(let offset=0;offset<matching.length;offset+=100){
   const key=await operationID(['automatic',current.id,c.id,offset]);
   const outcome=await apply(env,current,key,{link_ids:matching.slice(offset,offset+100),collection_ids:[c.id],expected_revisions:{[c.id]:c.revision+offset/100}},'direct');
   if(!outcome.ok){await env.DB.prepare("UPDATE collection_organizing_items SET error='自动应用遇到变更，请核对后审核',status='ready' WHERE run_id=? AND link_id IN(SELECT value FROM json_each(?))").bind(current.id,JSON.stringify(matching.slice(offset))).run();break;}
  }
 }
 await env.DB.prepare("UPDATE collection_organizing_items SET status='dismissed' WHERE run_id=? AND status='ready' AND error='' AND NOT EXISTS(SELECT 1 FROM json_each(probabilities) WHERE value>=0.8)").bind(current.id).run();
 await env.DB.prepare('UPDATE collection_organizing_runs SET auto_finished=1 WHERE id=?').bind(current.id).run();
}
export async function collectionOrganizingRoute(request:Request,env:Env,path:string,internal:boolean):Promise<Response>{
 if(request.headers.get('X-Cairn-Collections')!=='1')return fail('capability_mismatch',409);
 const root='/api/collections/organizing';const suffix=path.slice(root.length);
 if(request.method==='GET'&&suffix===''){
  const rows=await env.DB.prepare("SELECT r.*,(SELECT COUNT(*) FROM collection_organizing_items WHERE run_id=r.id) AS total,(SELECT COUNT(*) FROM collection_organizing_items WHERE run_id=r.id AND status IN('queued','processing')) AS pending,(SELECT COUNT(*) FROM collection_organizing_items WHERE run_id=r.id AND status='ready') AS review_count,(SELECT COUNT(*) FROM collection_organizing_items WHERE run_id=r.id AND status='failed') AS failed FROM collection_organizing_runs r ORDER BY created_at DESC LIMIT 30").all();return reply({items:rows.results.map(r=>({...r,definitions:JSON.parse(r.definitions as string)}))});
 }
 if(request.method==='GET'&&/^\/[a-f0-9-]{36}$/.test(suffix))return detail(env,suffix.slice(1));
 if(request.method!=='POST')return fail('method_not_allowed',405);
 const b=await readJSONObject(request,128*1024);if(!b)return fail('invalid_operation');
 if(suffix===''){
  if(!collectionID(b.operation_key)||!Array.isArray(b.collection_ids)||b.collection_ids.length<1||b.collection_ids.length>32||!b.collection_ids.every(collectionID)||new Set(b.collection_ids).size!==b.collection_ids.length||!['review','apply'].includes(String(b.mode??'review'))||b.link_ids!==undefined&&!ids(b.link_ids))return fail('invalid_operation');
  const createHash=await hash({mode:b.mode??'review',collection_ids:[...b.collection_ids].sort(),link_ids:b.link_ids??null});
  const prior=await run(env,b.operation_key);if(prior){if(prior.create_request_hash!==createHash)return fail('operation_conflict',409);return detail(env,prior.id);}
  const active=await env.DB.prepare("SELECT run_id FROM collection_organizing_items WHERE status IN('queued','processing') LIMIT 1").first();if(active)return reply({error:'organizing_active',run_id:active.run_id},409);
  const definitions=(await env.DB.prepare('SELECT id,name,description,revision,archived,deleted FROM collections WHERE deleted=0 AND archived=0 AND id IN(SELECT value FROM json_each(?)) ORDER BY id').bind(JSON.stringify(b.collection_ids)).all<Definition>()).results;
  if(definitions.length!==b.collection_ids.length)return fail('invalid_collection');
  const links=(await env.DB.prepare('SELECT id,content_revision FROM links WHERE (? IS NULL OR id IN(SELECT value FROM json_each(?))) ORDER BY id LIMIT 1001').bind(b.link_ids?JSON.stringify(b.link_ids):null,b.link_ids?JSON.stringify(b.link_ids):'[]').all<{id:number;content_revision:number}>()).results;
  if(!links.length||links.length>1000||b.link_ids&&links.length!==b.link_ids.length)return fail('invalid_scope');
  const stamp=new Date().toISOString();await env.DB.batch([env.DB.prepare('INSERT INTO collection_organizing_runs(id,mode,definitions,created_at,create_request_hash) VALUES(?,?,?,?,?)').bind(b.operation_key,b.mode??'review',JSON.stringify(definitions),stamp,createHash),env.DB.prepare('INSERT INTO collection_organizing_items(run_id,link_id,content_revision) SELECT ?,json_extract(value,\'$.id\'),json_extract(value,\'$.content_revision\') FROM json_each(?)').bind(b.operation_key,JSON.stringify(links))]);return detail(env,b.operation_key);
 }
 if(suffix==='/claim'){
  if(!internal)return fail('forbidden',403);
  // Unknown model outcome is never automatically re-issued after lease expiry.
  await env.DB.prepare("UPDATE collection_organizing_items SET status='failed',error='处理被中断，调用结果未知；可另行发起整理' WHERE status='processing' AND batch_id IN(SELECT id FROM collection_organizing_batches WHERE lease_until<? AND status='processing')").bind(new Date().toISOString()).run();
  const autos=(await env.DB.prepare("SELECT * FROM collection_organizing_runs WHERE mode='apply' AND auto_finished=0 AND NOT EXISTS(SELECT 1 FROM collection_organizing_items WHERE run_id=collection_organizing_runs.id AND status IN('queued','processing')) LIMIT 3").all<Run>()).results;for(const r of autos)await autoApply(env,r);
  const current=await env.DB.prepare("SELECT * FROM collection_organizing_runs WHERE (next_attempt_at IS NULL OR next_attempt_at<=?) AND EXISTS(SELECT 1 FROM collection_organizing_items WHERE run_id=collection_organizing_runs.id AND status='queued') ORDER BY created_at LIMIT 1").bind(new Date().toISOString()).first<Run>();if(!current)return reply({job:null});
  const definitions=JSON.parse(current.definitions) as Definition[];const size=Math.max(1,Math.min(8,Math.floor(32/definitions.length)));
  const candidates=(await env.DB.prepare("SELECT i.*,l.url,l.ai_title AS title,l.note,substr(COALESCE(l.original_text,l.summary,''),1,6000) AS text,l.content_revision AS actual_revision FROM collection_organizing_items i JOIN links l ON l.id=i.link_id WHERE run_id=? AND status='queued' ORDER BY link_id LIMIT ?").bind(current.id,size).all<Item&{actual_revision:number;text:string}>()).results;
  const eligible=candidates.filter(i=>i.content_revision===i.actual_revision&&i.text.trim());
  const batch=crypto.randomUUID(),lease=new Date(Date.now()+15*60*1000).toISOString();
  const statements=candidates.filter(i=>!eligible.includes(i)).map(i=>env.DB.prepare("UPDATE collection_organizing_items SET status='failed',error=? WHERE run_id=? AND link_id=? AND status='queued'").bind(i.content_revision!==i.actual_revision?'正文已更新，请重新整理':'正文尚未采集',current.id,i.link_id));
  if(eligible.length)statements.push(env.DB.prepare('INSERT INTO collection_organizing_batches(id,run_id,lease_until) VALUES(?,?,?)').bind(batch,current.id,lease),env.DB.prepare("UPDATE collection_organizing_items SET status='processing',batch_id=? WHERE run_id=? AND status='queued' AND link_id IN(SELECT value FROM json_each(?))").bind(batch,current.id,JSON.stringify(eligible.map(i=>i.link_id))));
  statements.push(env.DB.prepare('UPDATE collection_organizing_runs SET next_attempt_at=NULL WHERE id=?').bind(current.id));
  if(statements.length)await env.DB.batch(statements);
  const owned=(await env.DB.prepare('SELECT link_id FROM collection_organizing_items WHERE batch_id=?').bind(batch).all<{link_id:number}>()).results.map(i=>i.link_id);
  return reply({job:owned.length?{batch_id:batch,run_id:current.id,definitions,items:eligible.filter(i=>owned.includes(i.link_id)),question_version:'collection-fit-v1'}:null});
 }
 const completed=suffix.match(/^\/batch\/([a-f0-9-]{36})\/complete$/);
 if(completed){
  if(!internal)return fail('forbidden',403);const batch=await env.DB.prepare('SELECT * FROM collection_organizing_batches WHERE id=?').bind(completed[1]).first<{run_id:string;status:string;lease_until:string}>();if(!batch)return fail('not_found',404);if(batch.status!=='processing')return reply({completed:true,replayed:true});if(batch.lease_until<new Date().toISOString())return fail('lease_expired',409);
  const current=await run(env,batch.run_id);if(!current)return fail('not_found',404);
  if(b.error){if(typeof b.error!=='string'||b.error.length>300)return fail('invalid_result');const deferred=b.error==='budget_exhausted';const next=new Date((Math.floor(Date.now()/86400000)+1)*86400000).toISOString();await env.DB.batch([env.DB.prepare('UPDATE collection_organizing_batches SET status=?,error=? WHERE id=?').bind(deferred?'deferred':'failed',b.error,completed[1]),env.DB.prepare('UPDATE collection_organizing_items SET status=?,batch_id=NULL,error=? WHERE batch_id=?').bind(deferred?'queued':'failed',deferred?'当日调用预算已用完，次日继续':b.error,completed[1]),env.DB.prepare('UPDATE collection_organizing_runs SET next_attempt_at=? WHERE id=?').bind(deferred?next:null,current.id)]);return reply({completed:true});}
  const definitions=JSON.parse(current.definitions) as Definition[];const items=(await env.DB.prepare('SELECT * FROM collection_organizing_items WHERE batch_id=?').bind(completed[1]).all<Item>()).results;
  if(b.model!=='jev-1.13.0'||typeof b.request_hash!=='string'||!/^[a-f0-9]{64}$/.test(b.request_hash)||!b.usage||typeof b.usage!=='object'||!Array.isArray(b.results)||b.results.length!==items.length)return fail('invalid_result');
  const usage=b.usage as Record<string,unknown>;if(!Number.isSafeInteger(usage.input_tokens)||Number(usage.input_tokens)<0||Number(usage.input_tokens)>65536||!Number.isSafeInteger(usage.output_tokens)||Number(usage.output_tokens)<0)return fail('invalid_result');
  const results=b.results as {link_id:number;probabilities:Record<string,number>}[];if(new Set(results.map(r=>r.link_id)).size!==items.length||results.some(r=>!items.some(i=>i.link_id===r.link_id)||!r.probabilities||Object.keys(r.probabilities).length!==definitions.length||definitions.some(c=>typeof r.probabilities[c.id]!=='number'||!Number.isFinite(r.probabilities[c.id])||r.probabilities[c.id]<0||r.probabilities[c.id]>1)))return fail('invalid_result');
  await env.DB.batch([env.DB.prepare("UPDATE collection_organizing_batches SET status='completed',request_hash=?,model=?,usage=? WHERE id=?").bind(b.request_hash,b.model,JSON.stringify(usage),completed[1]),...results.map(r=>env.DB.prepare("UPDATE collection_organizing_items SET status='ready',probabilities=?,error='' WHERE batch_id=? AND link_id=? AND status='processing'").bind(JSON.stringify(r.probabilities),completed[1],r.link_id))]);await autoApply(env,current);return reply({completed:true});
 }
 const decision=suffix.match(/^\/([a-f0-9-]{36})\/(apply|dismiss|undo)$/);if(!decision)return fail('not_found',404);
 const current=await run(env,decision[1]);if(!current)return fail('not_found',404);
 if(decision[2]==='dismiss'){if(!ids(b.link_ids))return fail('invalid_scope');await env.DB.prepare("UPDATE collection_organizing_items SET status='dismissed' WHERE run_id=? AND link_id IN(SELECT value FROM json_each(?)) AND status='ready'").bind(current.id,JSON.stringify(b.link_ids)).run();return reply({dismissed:true});}
 if(decision[2]==='apply'){
  if(!collectionID(b.operation_key)||!ids(b.link_ids,100)||!Array.isArray(b.collection_ids)||!b.collection_ids.length||b.collection_ids.length>32||b.collection_ids.some(id=>!collectionID(id))||new Set(b.collection_ids).size!==b.collection_ids.length||!b.expected_revisions||typeof b.expected_revisions!=='object')return fail('invalid_operation');const expected=b.expected_revisions as Record<string,number>;if(b.collection_ids.some(id=>!Number.isSafeInteger(expected[id])||expected[id]<1))return fail('invalid_operation');
  return apply(env,current,b.operation_key,{link_ids:b.link_ids,collection_ids:b.collection_ids as string[],expected_revisions:expected},'review');
 }
 if(!collectionID(b.action_id))return fail('invalid_operation');const action=await env.DB.prepare('SELECT * FROM collection_organizing_actions WHERE id=? AND run_id=?').bind(b.action_id,current.id).first<{receipts:string;status:string;payload:string}>();if(!action)return fail('not_found',404);if(action.status==='undone')return reply({undone:true});
 await env.DB.prepare("UPDATE collection_organizing_actions SET status='undoing' WHERE id=? AND status IN('pending','applied')").bind(b.action_id).run();
 const receipts=JSON.parse(action.receipts) as Record<string,Receipt>;
 for(const [k,plan] of Object.entries(receipts)){if(!k.startsWith('plan:'))continue;const cid=k.slice(5);if(receipts[cid])continue;const operation=await env.DB.prepare('SELECT revision FROM collection_operations WHERE operation_key=?').bind(await operationID([b.action_id,cid])).first<{revision:number}>();if(operation)receipts[cid]={revision:operation.revision,added:plan.added};}
 for(const [cid,r] of Object.entries(receipts)){if(cid.startsWith('plan:')||r.undone||!r.added.length)continue;const response=await collectionsRoute(new Request('https://internal/api',{method:'POST',headers:{'Content-Type':'application/json','X-Cairn-Collections':'1'},body:JSON.stringify({operation_key:await operationID(['undo',b.action_id,cid]),expected_revision:r.revision,type:'remove',link_ids:r.added})}),env,`/api/collections/${cid}/operations`);if(!response.ok)return response;r.undone=true;await env.DB.prepare('UPDATE collection_organizing_actions SET receipts=json_set(receipts,?,json(?)) WHERE id=?').bind('$.'+JSON.stringify(cid),JSON.stringify(r),b.action_id).run();}
 await env.DB.prepare("UPDATE collection_organizing_actions SET status='undone' WHERE id=?").bind(b.action_id).run();return reply({undone:true});
}
