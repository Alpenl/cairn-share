import type { Env } from "./index";
import { readJSONObject } from "./json-body";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const collectionID = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const columns = "c.id,c.name,c.description,c.pinned,c.archived,c.deleted,c.revision,c.created_at,c.updated_at";
const counts = "(SELECT COUNT(*) FROM collection_items i WHERE i.collection_id=c.id) AS item_count";
type Collection = {id:string;revision:number;deleted:number;item_count:number};
type Entry = {collection_id:string;link_id:number;position:number;note:string;added_at:string};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status,headers:{"Content-Type":"application/json","Cache-Control":"private, no-store","X-Cairn-Collections":"1"}});
const error = (code: string, status = 400, extra = {}) => reply({error:code,...extra},status);
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n)>0;
async function get(env:Env,id:string) { return env.DB.prepare(`SELECT ${columns},${counts} FROM collections c WHERE c.id=?`).bind(id).first<Collection>(); }
function text(value:unknown,max:number) { return typeof value === "string" && value.length<=max && !value.includes("\0"); }
async function digest(value:unknown) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value))))).map(x=>x.toString(16).padStart(2,"0")).join(""); }

/** Separate identity-only feed: collection edits never invalidate article bodies or enqueue AI. */
async function sync(request:Request,env:Env) {
 const q=new URL(request.url).searchParams;
 if([...q.keys()].some(k=>!["after","epoch","limit"].includes(k)||q.getAll(k).length!==1)) return error("invalid_query");
 const after=Number(q.get("after")??0),limit=Number(q.get("limit")??100);
 if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>200) return error("invalid_query");
 const [metaResult,eventsResult]=await env.DB.batch([
  env.DB.prepare("SELECT epoch,COALESCE((SELECT MAX(seq) FROM collection_changes),0) AS high FROM library_sync_state WHERE id=1"),
  env.DB.prepare("SELECT seq,collection_id,link_id FROM collection_changes WHERE seq>? ORDER BY seq LIMIT ?").bind(after,limit+1)
 ]);
 const meta=metaResult.results[0] as {epoch:string;high:number};
 if(!meta) return error("collections_unavailable",503);
 if((q.has("epoch")&&q.get("epoch")!==meta.epoch)||after>meta.high||(after>0&&!q.has("epoch"))) return error("reset_required",409);
 const rows=eventsResult.results.slice(0,limit) as {seq:number;collection_id:string;link_id:number|null}[];
 const ids=[...new Set(rows.filter(r=>r.link_id===null).map(r=>r.collection_id))];
 const pairs=rows.filter(r=>r.link_id!==null).map(r=>[r.collection_id,r.link_id]);
 const [collections,items]=await env.DB.batch([
  env.DB.prepare(`SELECT ${columns},${counts} FROM collections c WHERE c.id IN(SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)),
  env.DB.prepare("SELECT i.* FROM collection_items i JOIN json_each(?) j ON i.collection_id=json_extract(j.value,'$[0]') AND i.link_id=json_extract(j.value,'$[1]')").bind(JSON.stringify(pairs))
 ]);
 const lookup=new Map((items.results as Entry[]).map(r=>[`${r.collection_id}/${r.link_id}`,r]));
 const defs=new Map((collections.results as Collection[]).map(r=>[r.id,r]));
 // Hydration can observe later values; those writes remain after this cursor and are replayed.
 return reply({protocol_version:1,epoch:meta.epoch,cursor:rows.at(-1)?.seq??after,has_more:eventsResult.results.length>limit,
  changes:rows.map(r=>({...r,value:r.link_id===null?defs.get(r.collection_id)??null:lookup.get(`${r.collection_id}/${r.link_id}`)??null}))});
}

export async function collectionsRoute(request:Request,env:Env,path:string):Promise<Response> {
 if(request.headers.get("X-Cairn-Collections")!=="1") return error("capability_mismatch",409);
 if(path==="/api/collections/sync") return request.method==="GET"?sync(request,env):error("method_not_allowed",405);
 if(path==="/api/collections") {
  if(request.method!=="GET") return error("method_not_allowed",405);
  // A personal library has at most 500 live collections; descriptions contain no article bodies.
  const query=new URL(request.url).searchParams;
  if([...query.keys()].some(k=>k!=="link_ids"||query.getAll(k).length!==1)) return error("invalid_query");
  const ids=query.has("link_ids")?query.get("link_ids")!.split(',').map(Number):[];
  if(ids.length>100||ids.some(n=>!positive(n))) return error("invalid_ids");
  const rows=await env.DB.prepare(`SELECT ${columns},${counts},(SELECT COUNT(*) FROM collection_items i WHERE i.collection_id=c.id AND i.link_id IN(SELECT value FROM json_each(?))) AS selected_count FROM collections c ORDER BY pinned DESC,updated_at DESC,id`).bind(JSON.stringify(ids)).all();
  return reply({items:rows.results});
 }
 const m=path.match(/^\/api\/collections\/([^/]+)(\/operations)?$/);
 if(!m||!collectionID(m[1])) return error("invalid_collection");
 const id=m[1];
 if(!m[2]) {
  if(request.method!=="GET") return error("method_not_allowed",405);
  const results=await env.DB.batch([env.DB.prepare(`SELECT ${columns},${counts} FROM collections c WHERE c.id=?`).bind(id),
   env.DB.prepare("SELECT i.*,COALESCE(NULLIF(l.ai_title,''),l.url) AS title FROM collection_items i JOIN links l ON l.id=i.link_id WHERE collection_id=? ORDER BY position,link_id").bind(id)]);
  if(!results[0].results.length) return error("not_found",404);
  return reply({collection:results[0].results[0],items:results[1].results});
 }
 if(request.method!=="POST") return error("method_not_allowed",405);
 const b=await readJSONObject(request,64*1024);
 if(!b||!collectionID(b.operation_key)||!Number.isSafeInteger(b.expected_revision)||Number(b.expected_revision)<0) return error("invalid_operation");
 const type=b.type;
 const fields:Record<string,string[]>={create:["name","description"],edit:["name","description","pinned","archived"],delete:[],restore:[],add:["link_ids"],remove:["link_ids"],note:["link_id","note"],move:["link_id","before_id"]};
 if(typeof type!=="string"||!Object.hasOwn(fields,type)||Object.keys(b).some(k=>!["operation_key","expected_revision","type",...fields[type]].includes(k))) return error("invalid_operation");
 if((type==="create"||"name" in b)&&(!text(b.name,80)||!(b.name as string).trim())) return error("invalid_name");
 if("description" in b&&!text(b.description,2000)) return error("invalid_description");
 if(["pinned","archived"].some(k=>k in b&&typeof b[k]!=="boolean")) return error("invalid_operation");
 if(type==="edit"&&!fields.edit.some(k=>k in b)) return error("invalid_operation");
 if(["add","remove"].includes(type)&&(!Array.isArray(b.link_ids)||!b.link_ids.length||b.link_ids.length>100||!b.link_ids.every(positive)||new Set(b.link_ids).size!==b.link_ids.length)) return error("invalid_ids");
 if(["note","move"].includes(type)&&!positive(b.link_id)) return error("invalid_ids");
 if(type==="note"&&!text(b.note,2000)) return error("invalid_note");
 if(type==="move"&&!(b.before_id===null||positive(b.before_id)) || type==="move"&&b.before_id===b.link_id) return error("invalid_order");
 const hash=await digest([id,Object.fromEntries(Object.entries(b).sort(([a],[z])=>a.localeCompare(z)))]);
 const receipt=()=>env.DB.prepare("SELECT request_hash,revision FROM collection_operations WHERE operation_key=?").bind(b.operation_key).first<{request_hash:string;revision:number}>();
 const old=await receipt();
 if(old) return old.request_hash===hash?reply({revision:old.revision,collection:await get(env,id),replayed:true}):error("operation_conflict",409);
 const current=await get(env,id),expected=Number(b.expected_revision);
 if(type==="create"?(expected!==0||current!==null):(!current||current.revision!==expected)) {
  const concurrent=await receipt();
  if(concurrent) return concurrent.request_hash===hash?reply({revision:concurrent.revision,collection:await get(env,id),replayed:true}):error("operation_conflict",409);
  return error("revision_conflict",409,{revision:current?.revision??0});
 }
 if(current?.deleted&&type!=="restore") return error("collection_deleted",409,{revision:current.revision});
 if(type==="restore"&&!current?.deleted) return error("revision_conflict",409,{revision:current?.revision});
 if(type==="add") {
  const row=await env.DB.prepare("SELECT COUNT(*) AS n FROM links WHERE id IN(SELECT value FROM json_each(?))").bind(JSON.stringify(b.link_ids)).first<{n:number}>();
  if(row?.n!==(b.link_ids as number[]).length) return error("invalid_ids");
 }
 // A distinct transaction admission token prevents concurrent retries of one
 // receipt from repeating member changes after the winning transaction commits.
 const stamp=new Date().toISOString(),next=expected+1,op=b.operation_key,admission=crypto.randomUUID();
 const guard="EXISTS(SELECT 1 FROM collections WHERE id=? AND last_operation=? AND revision=?)";
 const statements:D1PreparedStatement[]=[];
 if(type==="create") statements.push(env.DB.prepare(`INSERT INTO collections(id,name,description,created_at,updated_at,last_operation)
 SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM collection_operations WHERE operation_key=?) AND (SELECT COUNT(*) FROM collections WHERE deleted=0)<500 ON CONFLICT(id) DO NOTHING`).bind(id,(b.name as string).trim(),b.description??"",stamp,stamp,admission,op));
 else {
  const patch:string[]=[],values:unknown[]=[];
  for(const k of fields.edit) if(type==="edit"&&k in b) {patch.push(`${k}=?`);values.push(typeof b[k]==="boolean"?Number(b[k]):k==="name"?(b[k] as string).trim():b[k]);}
  if(type==="delete"||type==="restore") patch.push(`deleted=${type==="delete"?1:0}`);
  let condition="";
  if(type==="restore") condition=" AND (SELECT COUNT(*) FROM collections WHERE deleted=0)<500";
  if(type==="add") condition=" AND (SELECT COUNT(*) FROM collection_items WHERE collection_id=collections.id)+(SELECT COUNT(*) FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM collection_items i WHERE i.collection_id=collections.id AND i.link_id=j.value))<=1000",values.push(JSON.stringify(b.link_ids));
  if(type==="note"||type==="move") condition=" AND EXISTS(SELECT 1 FROM collection_items WHERE collection_id=collections.id AND link_id=?)",values.push(b.link_id);
  if(type==="move"&&b.before_id!==null) condition+=" AND EXISTS(SELECT 1 FROM collection_items WHERE collection_id=collections.id AND link_id=?)",values.push(b.before_id);
  // Patch bindings precede the admission bindings. Conditions follow them.
  const patchValues=type==="edit"?values:[];const conditionValues=type==="edit"?[]:values;
  statements.push(env.DB.prepare(`UPDATE collections SET ${patch.length?patch.join(',')+',':""}revision=revision+1,last_operation=?,updated_at=? WHERE id=? AND revision=? AND deleted=? AND NOT EXISTS(SELECT 1 FROM collection_operations WHERE operation_key=?)${condition}`)
   .bind(...patchValues,admission,stamp,id,expected,type==="restore"?1:0,op,...conditionValues));
 }
 if(type==="add") statements.push(env.DB.prepare(`INSERT INTO collection_items(collection_id,link_id,position,added_at)
  SELECT ?,value,COALESCE((SELECT MAX(position)+1 FROM collection_items WHERE collection_id=?),0)+CAST(key AS INTEGER),? FROM json_each(?) WHERE ${guard} ON CONFLICT(collection_id,link_id) DO NOTHING`)
  .bind(id,id,stamp,JSON.stringify(b.link_ids),id,admission,next));
 if(type==="remove") statements.push(env.DB.prepare(`DELETE FROM collection_items WHERE collection_id=? AND link_id IN(SELECT value FROM json_each(?)) AND ${guard}`).bind(id,JSON.stringify(b.link_ids),id,admission,next));
 if(type==="note") statements.push(env.DB.prepare(`UPDATE collection_items SET note=? WHERE collection_id=? AND link_id=? AND ${guard}`).bind(b.note,id,b.link_id,id,admission,next));
 if(type==="move") {
  // Normalize a bounded (<=1000) collection in one statement, retaining every other relative order.
  statements.push(env.DB.prepare(`WITH ordered AS MATERIALIZED (SELECT link_id,ROW_NUMBER() OVER(ORDER BY CASE WHEN link_id=? THEN COALESCE((SELECT position-0.5 FROM collection_items WHERE collection_id=? AND link_id=?),1e18) ELSE position END,link_id)-1 AS rank FROM collection_items WHERE collection_id=?)
   UPDATE collection_items SET position=(SELECT rank FROM ordered WHERE ordered.link_id=collection_items.link_id) WHERE collection_id=? AND ${guard}`)
   .bind(b.link_id,id,b.before_id,id,id,id,admission,next));
 }
 statements.push(env.DB.prepare(`INSERT OR IGNORE INTO collection_operations(operation_key,collection_id,request_hash,revision,created_at) SELECT ?,?,?,?,? WHERE ${guard}`).bind(op,id,hash,next,stamp,id,admission,next));
 // The cache generation changes atomically with the successful operation; no stale filtered page.
 statements.push(env.DB.prepare(`INSERT INTO cache_metadata(key,value,updated_at) SELECT 'links_generation',1,? WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value=cache_metadata.value+1,updated_at=excluded.updated_at`).bind(stamp,id,admission,next));
 try { await env.DB.batch(statements); } catch { return error("collection_write_failed",409); }
 const saved=await receipt();
 if(!saved) {
  const latest=await get(env,id);
  if((latest?.revision??0)!==expected) return error("revision_conflict",409,{revision:latest?.revision??0});
  if(["create","restore","add"].includes(type)) return error("collection_limit",409);
  if(type==="note"||type==="move") return error("member_not_found",409);
  return error("collection_write_failed",409);
 }
 if(saved.request_hash!==hash) return error("operation_conflict",409);
 return reply({revision:saved.revision,collection:await get(env,id)});
}
