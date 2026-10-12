import { currentRuleRefsSQL } from "./tag-deletion";
import type { Env } from "./index";
import { displayedCatalog, catalogTerm } from "./tag-catalog";
import { tagSystemRoute } from "./tag-system";
import { readJSONObject } from "./json-body";
import { canonicalJSON } from "./domain";
import type { TermDefinition } from "./taxonomy-v2";

// Tag merge and usage. A merge is two steps:
// 1. Catalog (one CAS write): the source topic is archived and points at the
//    target with a synonym relation; its aliases move to the target. Collection
//    rules that reference the source are rewritten to the target.
// 2. Memberships: every bookmark that carried the source is queued and moved
//    by the ordinary per-bookmark tag operation (replace / detach+attach), so
//    revisions, history, undo receipts and projections stay exact. The queue
//    is drained by the cron and right after the merge request.
// Undo restores the catalog and reverts each moved bookmark with that
// bookmark's own undo receipt, unless a person has edited it since.
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json","Cache-Control":"private, no-store","X-Cairn-Tag-System":"1"}});
const fail=(error:string,status=400,extra={})=>reply({error,...extra},status);
type Merge={merge_key:string;kind:"system"|"custom";dimension:string;from_id:string;into_id:string;catalog_revision:number;added_aliases:string;rule_rewrites:string;status:string;created_at:string;undone_at:string|null};
const ref=(m:Pick<Merge,"kind"|"dimension">,id:string)=>m.kind==="system"?`system/${m.dimension}/${id}`:`custom/default/${id}`;
type Rewrite={id:string;field:"rule_tags"|"rule_exclude_tags";before:string;after:string;rule_revision:number};

async function progress(env:Env,key:string){
 const rows=await env.DB.prepare("SELECT phase,state,COUNT(*) AS n FROM tag_merge_queue WHERE merge_key=? GROUP BY phase,state").bind(key).all<{phase:string;state:string;n:number}>();
 const out:Record<string,Record<string,number>>={apply:{pending:0,done:0,skipped:0},undo:{pending:0,done:0,skipped:0}};
 for(const r of rows.results)out[r.phase][r.state]=r.n;return out;
}
async function view(env:Env,key:string){
 const m=await env.DB.prepare("SELECT * FROM tag_merges WHERE merge_key=?").bind(key).first<Merge>();
 return m?{merge_key:m.merge_key,kind:m.kind,dimension:m.dimension,from:m.from_id,into:m.into_id,status:m.status,created_at:m.created_at,undone_at:m.undone_at,
  added_aliases:JSON.parse(m.added_aliases),rules_rewritten:(JSON.parse(m.rule_rewrites) as Rewrite[]).length,progress:await progress(env,key)}:null;
}
/** Rewrites rule references; returns statements and the record needed to undo. */
async function rewriteRules(env:Env,from:string,into:string,stamp:string){
 const rows=await env.DB.prepare("SELECT id,rule_tags,rule_exclude_tags,rule_revision FROM collections WHERE deleted=0 AND (instr(rule_tags,?)>0 OR instr(rule_exclude_tags,?)>0)").bind(`"${from}"`,`"${from}"`).all<{id:string;rule_tags:string;rule_exclude_tags:string;rule_revision:number}>();
 const rewrites:Rewrite[]=[],updates:Array<{id:string;tags:string;exclude:string;revision:number}>=[];
 for(const row of rows.results){
  const swap=(list:string[])=>[...new Set(list.map(x=>x===from?into:x))];
  const nextTags=swap(JSON.parse(row.rule_tags));
  // A tag cannot be both required and excluded; the requirement wins.
  const nextExclude=swap(JSON.parse(row.rule_exclude_tags)).filter(x=>!nextTags.includes(x));
  if(JSON.stringify(nextTags)!==row.rule_tags) rewrites.push({id:row.id,field:"rule_tags",before:row.rule_tags,after:JSON.stringify(nextTags),rule_revision:row.rule_revision+1});
  if(JSON.stringify(nextExclude)!==row.rule_exclude_tags) rewrites.push({id:row.id,field:"rule_exclude_tags",before:row.rule_exclude_tags,after:JSON.stringify(nextExclude),rule_revision:row.rule_revision+1});
  updates.push({id:row.id,tags:JSON.stringify(nextTags),exclude:JSON.stringify(nextExclude),revision:row.rule_revision});
 }
 const statements=(guard:string,g:unknown[])=>updates.map(u=>env.DB.prepare(`UPDATE collections SET rule_tags=?,rule_exclude_tags=?,rule_revision=rule_revision+1,revision=revision+1,updated_at=? WHERE id=? AND rule_revision=? AND ${guard}`)
  .bind(u.tags,u.exclude,stamp,u.id,u.revision,...g));
 return {rewrites,statements};
}
type Extra=(guard:string,g:unknown[])=>D1PreparedStatement[];
/** One CAS write of a new catalog snapshot plus guarded side effects. Returns true when this request's write landed. */
async function catalogWrite(env:Env,current:{revision:number;catalog:Record<string,unknown>},operationKey:string,hash:string,dimension:string,termID:string,action:string,before:unknown,after:unknown,extra:Extra):Promise<boolean>{
 const next=current.revision+1,stamp=new Date().toISOString(),admission=crypto.randomUUID(),catalog=current.catalog as {version:string};
 const guard='EXISTS(SELECT 1 FROM tag_catalog_state WHERE id=1 AND revision=? AND last_operation=?)';
 await env.DB.batch([
  env.DB.prepare('UPDATE tag_catalog_state SET revision=?,version=?,last_operation=? WHERE id=1 AND revision=? AND NOT EXISTS(SELECT 1 FROM tag_catalog_operations WHERE operation_key=?)').bind(next,catalog.version,admission,current.revision,operationKey),
  env.DB.prepare(`INSERT INTO tag_catalog_snapshots(revision,version,catalog,created_at) SELECT ?,?,?,? WHERE ${guard}`).bind(next,catalog.version,JSON.stringify(catalog),stamp,next,admission),
  env.DB.prepare(`INSERT INTO tag_catalog_operations(operation_key,request_hash,revision,dimension,term_id,action,before_value,after_value,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard}`).bind(operationKey,hash,next,dimension,termID,action,JSON.stringify(before),JSON.stringify(after),stamp,next,admission),
  env.DB.prepare(`INSERT INTO cache_metadata(key,value,updated_at) SELECT 'links_generation',1,? WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value=cache_metadata.value+1,updated_at=excluded.updated_at`).bind(stamp,next,admission),
  ...extra(guard,[next,admission]),
 ]);
 const saved=await env.DB.prepare("SELECT request_hash FROM tag_catalog_operations WHERE operation_key=? AND revision=?").bind(operationKey,next).first<{request_hash:string}>();
 return saved?.request_hash===hash;
}
async function requestHash(b:unknown){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJSON(b)));return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');}

async function createMerge(request:Request,env:Env){
 const b=await readJSONObject(request,8*1024);
 if(!b||typeof b.operation_key!=="string"||!uuid.test(b.operation_key)||!["system","custom"].includes(String(b.kind))||typeof b.from!=="string"||typeof b.into!=="string"||b.from===b.into
  ||Object.keys(b).some(k=>!["operation_key","expected_revision","kind","dimension","from","into"].includes(k)))return fail("invalid_merge");
 const hash=await requestHash(b),key=b.operation_key;
 const existing=await env.DB.prepare("SELECT merge_key FROM tag_merges WHERE merge_key=?").bind(key).first();
 if(existing){const prior=await env.DB.prepare("SELECT request_hash FROM tag_catalog_operations WHERE operation_key=?").bind(key).first<{request_hash:string}>();
  if(prior&&prior.request_hash!==hash)return fail("operation_conflict",409);return reply({...await view(env,key),replayed:true});}
 const stamp=new Date().toISOString();
 if(b.kind==="system"){
  // Topic merges only: other dimensions are small closed sets the classifier depends on.
  if(b.dimension!=="topics"||!Number.isSafeInteger(b.expected_revision))return fail("invalid_merge");
  const current=await displayedCatalog(env);
  if(current.revision!==b.expected_revision)return fail("revision_conflict",409,{revision:current.revision});
  const topics=current.catalog.topics as TermDefinition[],from=catalogTerm(current.catalog,"topics",b.from),into=catalogTerm(current.catalog,"topics",b.into);
  if(!from||!into)return fail("tag_not_found",404);
  if(!into.active||into.deprecated||!from.active||from.deprecated)return fail("tag_deprecated",409);
  const added=(from.aliases??[]).filter(a=>a!==into.label&&!(into.aliases??[]).includes(a)).slice(0,Math.max(0,20-(into.aliases??[]).length));
  const fromAfter:TermDefinition={...from,active:false,deprecated:true,status:"deprecated",aliases:(from.aliases??[]).filter(a=>!added.includes(a)),
   relations:[...(from.relations??[]).filter(r=>r.kind!=="synonym"&&r.kind!=="broader"),{id:into.id,kind:"synonym"}],display_revision:(from.display_revision??0)+1};
  const intoAfter:TermDefinition={...into,aliases:[...(into.aliases??[]),...added],display_revision:(into.display_revision??0)+1};
  // Children of the source move under the target.
  current.catalog.topics=topics.map(t=>t.id===from.id?fromAfter:t.id===into.id?intoAfter:
   t.relations?.some(r=>r.kind==="broader"&&r.id===from.id)?{...t,relations:t.relations.map(r=>r.kind==="broader"&&r.id===from.id?{...r,id:into.id}:r).filter(r=>r.id!==t.id)}:t);
  if(!current.catalog.topics.some(t=>t.active&&!t.deprecated&&t.ai_enabled!==false))return fail("last_ai_tag",409);
  fromAfter.definition_version=(from.definition_version??0)+1;current.catalog.version=`managed-${crypto.randomUUID()}`;current.catalog.definition_version++;
  const {rewrites,statements}=await rewriteRules(env,ref(b as never,from.id),ref(b as never,into.id),stamp);
  const write=await catalogWrite(env,current as never,key,hash,"topics",from.id,"merge",{from,into},{from:fromAfter,into:intoAfter},(guard,g)=>[
   env.DB.prepare(`INSERT INTO tag_merges(merge_key,kind,dimension,from_id,into_id,catalog_revision,added_aliases,rule_rewrites,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard}`)
    .bind(key,"system","topics",from.id,into.id,current.revision+1,JSON.stringify(added),JSON.stringify(rewrites),stamp,...g),
   env.DB.prepare(`INSERT INTO tag_merge_queue(merge_key,link_id,operation_key) SELECT ?,link_id,lower(hex(randomblob(16))) FROM effective_tag_memberships WHERE field='topics' AND term=? AND ${guard} ON CONFLICT DO NOTHING`).bind(key,from.id,...g),
   ...statements(guard,g)]);
  if(!write)return fail("revision_conflict",409,{revision:(await displayedCatalog(env)).revision});
 } else {
  if(b.dimension!==undefined&&b.dimension!=="custom")return fail("invalid_merge");
  const tags=await env.DB.prepare("SELECT id,label,status,revision FROM custom_tags WHERE owner_id='default' AND id IN(?,?)").bind(b.from,b.into).all<{id:string;label:string;status:string;revision:number}>();
  const from=tags.results.find(t=>t.id===b.from),into=tags.results.find(t=>t.id===b.into);
  if(!from||!into)return fail("tag_not_found",404);
  if(from.status!=="active"||into.status!=="active")return fail("tag_deprecated",409);
  const m={kind:"custom" as const,dimension:"custom"};
  const {rewrites,statements}=await rewriteRules(env,ref(m,from.id),ref(m,into.id),stamp);
  const guard="EXISTS(SELECT 1 FROM custom_tags WHERE id=? AND revision=? AND status='active')";
  await env.DB.batch([
   env.DB.prepare(`INSERT INTO tag_merges(merge_key,kind,dimension,from_id,into_id,catalog_revision,rule_rewrites,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`)
    .bind(key,"custom","custom",from.id,into.id,from.revision,JSON.stringify(rewrites),stamp,from.id,from.revision),
   env.DB.prepare(`INSERT INTO tag_merge_queue(merge_key,link_id,operation_key) SELECT ?,link_id,lower(hex(randomblob(16))) FROM custom_tag_links WHERE tag_id=? AND EXISTS(SELECT 1 FROM tag_merges WHERE merge_key=?) ON CONFLICT DO NOTHING`).bind(key,from.id,key),
   ...statements("EXISTS(SELECT 1 FROM tag_merges WHERE merge_key=?)",[key]),
  ]);
  if(!await env.DB.prepare("SELECT 1 FROM tag_merges WHERE merge_key=?").bind(key).first())return fail("revision_conflict",409);
  await env.DB.prepare("INSERT INTO tag_catalog_operations(operation_key,request_hash,revision,dimension,term_id,action,before_value,after_value,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
   .bind(key,hash,0,"custom",from.id,"merge",JSON.stringify(from),JSON.stringify({into:into.id}),stamp).run();
 }
 await drainTagMerges(env,10);
 return reply({...await view(env,key),replayed:false});
}

async function undoMerge(request:Request,env:Env,key:string){
 const b=await readJSONObject(request,4*1024);
 if(!b||typeof b.operation_key!=="string"||!uuid.test(b.operation_key)||Object.keys(b).some(k=>!["operation_key","expected_revision"].includes(k)))return fail("invalid_merge");
 const m=await env.DB.prepare("SELECT * FROM tag_merges WHERE merge_key=?").bind(key).first<Merge>();
 if(!m)return fail("not_found",404);
 if(m.status==="undone")return reply({...await view(env,key),replayed:true});
 const stamp=new Date().toISOString(),rewrites=JSON.parse(m.rule_rewrites) as Rewrite[];
 // Restore a rule only if nobody edited it after the merge.
 const restoreRules=rewrites.map(r=>env.DB.prepare(`UPDATE collections SET ${r.field}=?,rule_revision=rule_revision+1,revision=revision+1,updated_at=? WHERE id=? AND rule_revision=? AND ${r.field}=? AND ${currentRuleRefsSQL}`).bind(r.before,stamp,r.id,r.rule_revision,r.after,r.before,r.before));
 const queue=[
  env.DB.prepare("UPDATE tag_merge_queue SET state='skipped' WHERE merge_key=? AND phase='apply' AND state='pending'").bind(key),
  env.DB.prepare("INSERT INTO tag_merge_queue(merge_key,link_id,phase,operation_key) SELECT merge_key,link_id,'undo',lower(hex(randomblob(16))) FROM tag_merge_queue WHERE merge_key=? AND phase='apply' AND state='done' ON CONFLICT DO NOTHING").bind(key),
  env.DB.prepare("UPDATE tag_merges SET status='undone',undone_at=? WHERE merge_key=? AND status='active'").bind(stamp,key),
 ];
 if(m.kind==="system"){
  if(!Number.isSafeInteger(b.expected_revision))return fail("invalid_merge");
  const current=await displayedCatalog(env);
  if(current.revision!==b.expected_revision)return fail("revision_conflict",409,{revision:current.revision});
  const from=catalogTerm(current.catalog,"topics",m.from_id),into=catalogTerm(current.catalog,"topics",m.into_id);
  if(!from||!into)return fail("tag_not_found",404);
  const added=JSON.parse(m.added_aliases) as string[];
  const fromAfter:TermDefinition={...from,active:true,deprecated:false,status:"active",aliases:[...new Set([...(from.aliases??[]),...added])],relations:(from.relations??[]).filter(r=>!(r.kind==="synonym"&&r.id===into.id)),display_revision:(from.display_revision??0)+1};
  const intoAfter:TermDefinition={...into,aliases:(into.aliases??[]).filter(a=>!added.includes(a)),display_revision:(into.display_revision??0)+1};
  current.catalog.topics=(current.catalog.topics as TermDefinition[]).map(t=>t.id===from.id?fromAfter:t.id===into.id?intoAfter:t);
  fromAfter.definition_version=(from.definition_version??0)+1;current.catalog.version=`managed-${crypto.randomUUID()}`;current.catalog.definition_version++;
  const hash=await requestHash({key,...b});
  if(!await catalogWrite(env,current as never,b.operation_key,hash,"topics",from.id,"unmerge",{from,into},{from:fromAfter,into:intoAfter},()=>[]))return fail("revision_conflict",409,{revision:(await displayedCatalog(env)).revision});
 }
 // A personal source tag must be active again before its bookmarks can re-attach it.
 if(m.kind==="custom" && await env.DB.prepare("SELECT 1 FROM custom_tag_operations WHERE tag_id IN(?,?) AND action='delete'").bind(m.from_id,m.into_id).first())return fail("tag_not_found",404);
 if(m.kind==="custom")queue.push(env.DB.prepare("UPDATE custom_tags SET status='active',revision=revision+1,updated_at=? WHERE id=? AND status='deprecated' AND NOT EXISTS(SELECT 1 FROM custom_tag_operations d WHERE d.tag_id=custom_tags.id AND d.action='delete')").bind(stamp,m.from_id));
 await env.DB.batch([...queue,...restoreRules]);
 await drainTagMerges(env,10);
 return reply({...await view(env,key),replayed:false});
}

/** Moves queued memberships through the ordinary tag operation. Bounded and restartable. */
export async function drainTagMerges(env:Env,limit=50):Promise<number>{
 const rows=await env.DB.prepare(`SELECT q.merge_key,q.link_id,q.phase,q.operation_key,q.attempts,m.kind,m.dimension,m.from_id,m.into_id FROM tag_merge_queue q JOIN tag_merges m ON m.merge_key=q.merge_key
  WHERE q.state='pending' ORDER BY q.phase='undo' DESC,q.merge_key,q.link_id LIMIT ?`).bind(limit).all<{merge_key:string;link_id:number;phase:string;operation_key:string;attempts:number;kind:"system"|"custom";dimension:string;from_id:string;into_id:string}>();
 for(const q of rows.results){
  const mark=(state:string)=>env.DB.prepare("UPDATE tag_merge_queue SET state=?,attempts=attempts+1 WHERE merge_key=? AND link_id=? AND phase=?").bind(state,q.merge_key,q.link_id,q.phase).run();
  const link=await env.DB.prepare("SELECT personal_revision FROM links WHERE id=?").bind(q.link_id).first<{personal_revision:number}>();
  if(!link){await mark("skipped");continue;}
  let actions:unknown[];
  if(q.phase==="undo"){
   const applied=await env.DB.prepare("SELECT operation_key FROM tag_merge_queue WHERE merge_key=? AND link_id=? AND phase='apply' AND state='done'").bind(q.merge_key,q.link_id).first<{operation_key:string}>();
   const receipt=applied?await env.DB.prepare("SELECT revision FROM tag_operations WHERE operation_key=?").bind(applied.operation_key).first<{revision:number}>():null;
   // Someone changed this bookmark's tags after the merge: their edit stands.
   if(!applied||!receipt||receipt.revision!==link.personal_revision){await mark("skipped");continue;}
   actions=[{action:"undo",operation_id:applied.operation_key}];
  } else if(q.kind==="system"){
   const has=await env.DB.prepare("SELECT 1 FROM effective_tag_memberships WHERE link_id=? AND field=? AND term=?").bind(q.link_id,q.dimension,q.from_id).first();
   if(!has){await mark("skipped");continue;}
   actions=[{action:"replace",from_tag_ref:`system/${q.dimension}/${q.from_id}`,to_tag_ref:`system/${q.dimension}/${q.into_id}`}];
  } else {
   const has=await env.DB.prepare("SELECT 1 FROM custom_tag_links WHERE link_id=? AND tag_id=?").bind(q.link_id,q.from_id).first();
   if(!has){await mark("skipped");continue;}
   actions=[{action:"detach",tag_ref:`custom/default/${q.from_id}`},{action:"attach",tag_ref:`custom/default/${q.into_id}`}];
  }
  const path=`/api/v2/links/${q.link_id}/tags`;
  const response=await tagSystemRoute(new Request("https://merge.internal"+path,{method:"POST",headers:{"Content-Type":"application/json","X-Cairn-Tag-System":"1"},
   body:JSON.stringify({operation_key:q.operation_key,expected_revision:link.personal_revision,actions,reason:q.phase==="undo"?"撤销标签合并":"标签合并"})}),env,path);
  if(response?.ok){await mark("done");continue;}
  // Conflicts are retried on the next pass; give up after five tries.
  if(q.attempts>=4)await mark("skipped");else await env.DB.prepare("UPDATE tag_merge_queue SET attempts=attempts+1 WHERE merge_key=? AND link_id=? AND phase=?").bind(q.merge_key,q.link_id,q.phase).run();
 }
 // A merged personal tag is archived once its memberships have moved.
 await env.DB.prepare(`UPDATE custom_tags SET status='deprecated',revision=revision+1,updated_at=? WHERE status='active' AND id IN(SELECT m.from_id FROM tag_merges m WHERE m.kind='custom' AND m.status='active'
  AND NOT EXISTS(SELECT 1 FROM tag_merge_queue q WHERE q.merge_key=m.merge_key AND q.state='pending'))`).bind(new Date().toISOString()).run();
 await env.DB.prepare(`UPDATE custom_tags SET status='active',revision=revision+1,updated_at=? WHERE status='deprecated' AND NOT EXISTS(SELECT 1 FROM custom_tag_operations d WHERE d.tag_id=custom_tags.id AND d.action='delete') AND id IN(SELECT m.from_id FROM tag_merges m WHERE m.kind='custom' AND m.status='undone')
  AND NOT EXISTS(SELECT 1 FROM tag_merges x WHERE x.kind='custom' AND x.status='active' AND x.from_id=custom_tags.id)`).bind(new Date().toISOString()).run();
 return rows.results.length;
}

/** Per-tag usage for the settings page: bookmark count, last use and rule references. */
async function usage(env:Env){
 const [system,custom,rules,merges]=await env.DB.batch([
  env.DB.prepare(`SELECT e.field,e.term,COUNT(*) AS count,MAX(l.created_at) AS last_used_at FROM effective_tag_memberships e JOIN links l ON l.id=e.link_id GROUP BY e.field,e.term`),
  env.DB.prepare(`SELECT a.tag_id,COUNT(*) AS count,MAX(a.created_at) AS last_used_at FROM custom_tag_links a JOIN custom_tags t ON t.id=a.tag_id WHERE t.owner_id='default' GROUP BY a.tag_id`),
  env.DB.prepare(`SELECT id,name,rule_enabled,rule_tags,rule_exclude_tags FROM collections WHERE deleted=0 AND (rule_tags<>'[]' OR rule_exclude_tags<>'[]')`),
  env.DB.prepare(`SELECT merge_key FROM tag_merges ORDER BY created_at DESC LIMIT 20`),
 ]);
 const byRef=new Map<string,{collection_id:string;name:string;enabled:boolean;role:"include"|"exclude"}[]>();
 for(const r of rules.results as Array<{id:string;name:string;rule_enabled:number;rule_tags:string;rule_exclude_tags:string}>){
  for(const [role,list] of [["include",r.rule_tags],["exclude",r.rule_exclude_tags]] as const)for(const x of JSON.parse(list) as string[]){
   const arr=byRef.get(x)??[];arr.push({collection_id:r.id,name:r.name,enabled:r.rule_enabled===1,role});byRef.set(x,arr);}
 }
 const sys=(system.results as Array<{field:string;term:string;count:number;last_used_at:string}>).map(r=>{const d=r.field==="form"?"forms":r.field==="use"?"uses":r.field,tag_ref=`system/${d}/${r.term}`;return {tag_ref,count:r.count,last_used_at:r.last_used_at,rules:byRef.get(tag_ref)??[]};});
 const cus=(custom.results as Array<{tag_id:string;count:number;last_used_at:string}>).map(r=>{const tag_ref=`custom/default/${r.tag_id}`;return {tag_ref,count:r.count,last_used_at:r.last_used_at,rules:byRef.get(tag_ref)??[]};});
 const seen=new Set([...sys,...cus].map(x=>x.tag_ref));
 const unusedRules=[...byRef.entries()].filter(([k])=>!seen.has(k)).map(([tag_ref,rules])=>({tag_ref,count:0,last_used_at:null,rules}));
 const recent=await Promise.all((merges.results as Array<{merge_key:string}>).map(m=>view(env,m.merge_key)));
 return reply({items:[...sys,...cus,...unusedRules],merges:recent});
}

export async function tagMergeRoute(request:Request,env:Env,path:string):Promise<Response|null>{
 const m=path.match(/^\/api\/(?:v2\/)?tag-catalog\/(usage|merges)(?:\/([0-9a-f-]{36})(\/undo)?)?$/);
 if(!m)return null;
 if(request.headers.get("X-Cairn-Tag-System")!=="1")return fail("capability_mismatch",409);
 if(m[1]==="usage"){if(m[2])return fail("not_found",404);return request.method==="GET"?usage(env):fail("method_not_allowed",405);}
 if(!m[2])return request.method==="POST"?createMerge(request,env):fail("method_not_allowed",405);
 if(m[3])return request.method==="POST"?undoMerge(request,env,m[2]):fail("method_not_allowed",405);
 if(request.method!=="GET")return fail("method_not_allowed",405);
 const v=await view(env,m[2]);return v?reply(v):fail("not_found",404);
}
