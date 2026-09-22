import type { Env } from "./index";
import { canonicalJSON } from "./domain";

const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
const fail=(error:string,status=400)=>reply({error},status);
const hex=(v:unknown):v is string=>typeof v==="string" && /^[a-f0-9]{64}$/.test(v);
const positive=(v:unknown)=>Number.isSafeInteger(v) && Number(v)>0;
type Binding={link_id:number;evidence_snapshot_id:number;content_revision:number;content_hash:string};
type Candidate={surface:string;start:number;end:number;block_id:string;source_url?:string;kind:string};
type Row=Binding & {cache_key:string;source_links:string;owner_token:string;status:string;request_json:string;candidates:string;answers:string;result_hash:string|null;expires_at:number};
const fields="cache_key,link_id,evidence_snapshot_id,content_revision,content_hash,source_links,owner_token,status,request_json,candidates,answers,result_hash,expires_at";
// Objective inputs only: a classification decision or human correction does not
// change entity evidence. Related links are checked separately from revision.
const currentInput=`EXISTS (SELECT 1 FROM links l JOIN evidence_snapshots s ON s.link_id=l.id
 WHERE l.id=? AND s.id=? AND l.content_revision=? AND s.content_revision=l.content_revision AND s.content_hash=?
 AND json(COALESCE(NULLIF(l.related_links,''),'[]'))=json(?))`;
const bind=(b:Binding,links:string)=>[b.link_id,b.evidence_snapshot_id,b.content_revision,b.content_hash,links];
const hash=async(s:string)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,"0")).join("");
async function current(env:Env,b:Binding,links:string){return Boolean(await env.DB.prepare(`SELECT ${currentInput} ok`).bind(...bind(b,links)).first<number>("ok"));}
async function bodyOf(request:Request):Promise<Record<string,unknown>|null>{
 if(!request.headers.get("Content-Type")?.startsWith("application/json"))return null;
 try{const reader=request.body?.getReader();if(!reader)return null;const chunks:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144){await reader.cancel();return null;}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 const body=JSON.parse(new TextDecoder().decode(bytes));return body&&typeof body==="object"&&!Array.isArray(body)?body:null;}catch{return null;}
}
const view=(r:Row,owned=false)=>({key:r.cache_key,status:r.status,owned,expires_at:r.expires_at,answers:JSON.parse(r.answers)});
function validAnswers(value:unknown,candidates:Candidate[]){
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const answers=value as Record<string,Record<string,unknown>>;
 return Object.keys(answers).length===candidates.length && candidates.every((_,i)=>{const a=answers[`entity_${i}`];return a&&Object.keys(a).length===2&&a.type==="noul"&&typeof a.noul==="number"&&Number.isFinite(a.noul)&&a.noul>=0&&a.noul<=1;});
}
export async function pruneEntityCache(env:{DB:D1Database}){
 await env.DB.prepare("DELETE FROM entity_cache WHERE cache_key IN (SELECT cache_key FROM entity_cache WHERE expires_at<=? ORDER BY expires_at LIMIT 100)").bind(Date.now()).run();
}
export async function entityCacheRoute(request:Request,env:Env,path:string):Promise<Response|null>{
 const match=path.match(/^\/api\/v2\/entity-cache\/(claim|[a-f0-9]{64})(\/complete)?$/);if(!match)return null;
 if(match[1]==="claim"&&!match[2]){
  if(request.method!=="POST")return fail("method_not_allowed",405);
  const b=await bodyOf(request);
  const keys=["link_id","evidence_snapshot_id","content_revision","content_hash","owner_token","request_json","candidates","spec_hash"];
  if(!b||Object.keys(b).length!==keys.length||Object.keys(b).some(k=>!keys.includes(k))||!positive(b.link_id)||!positive(b.evidence_snapshot_id)||!positive(b.content_revision)||!hex(b.content_hash)||!hex(b.owner_token)||!hex(b.spec_hash)||typeof b.request_json!=="string"||new TextEncoder().encode(b.request_json).length>131072||!Array.isArray(b.candidates)||b.candidates.length<1||b.candidates.length>40)return fail("invalid_entity_cache_request");
  let wire:{model:string;state:{material:Array<{ID:string;Text:string;role?:string;url?:string}>;stored_links:string[]};questions:Record<string,{type:string}>};
  try{wire=JSON.parse(b.request_json);}catch{return fail("invalid_entity_cache_request");}
  if(!wire||wire.model!=="jev-1.13.0"||!wire.state||!Array.isArray(wire.state.material)||!Array.isArray(wire.state.stored_links)||!wire.state.stored_links.every(v=>typeof v==="string")||!wire.questions||Object.keys(wire.questions).length!==b.candidates.length||!b.candidates.every((_,i)=>wire.questions[`entity_${i}`]?.type==="noul"))return fail("invalid_entity_cache_request");
  const binding=b as unknown as Binding,links=canonicalJSON(wire.state.stored_links);
  const snapshot=await env.DB.prepare("SELECT payload FROM evidence_snapshots WHERE id=? AND link_id=? AND content_revision=? AND content_hash=?").bind(b.evidence_snapshot_id,b.link_id,b.content_revision,b.content_hash).first<{payload:string}>();
  if(!snapshot||!await current(env,binding,links))return fail("entity_input_stale",409);
  const blocks=(JSON.parse(snapshot.payload).blocks??[]) as Array<{id:string;text:string;role?:string;url?:string}>;
  const material=blocks.map(v=>({ID:v.id,Text:v.text,...(v.role?{role:v.role}:{}),...(v.url?{url:v.url}:{})}));
  if(canonicalJSON(material)!==canonicalJSON(wire.state.material))return fail("entity_material_mismatch",409);
  const candidates=b.candidates as Candidate[];
  if(!candidates.every(c=>{if(!c||typeof c.surface!=="string"||!c.surface||c.surface.length>2048||typeof c.block_id!=="string"||!Number.isSafeInteger(c.start)||!Number.isSafeInteger(c.end))return false;
   if(c.kind==="link")return c.source_url===c.surface&&wire.state.stored_links.includes(c.surface)&&c.block_id===""&&c.start===0&&c.end===0;
   const block=blocks.find(v=>v.id===c.block_id);return c.kind==="surface"&&block&&c.start>=0&&c.end>c.start&&c.end<=Array.from(block.text).length&&Array.from(block.text).slice(c.start,c.end).join("")===c.surface;
  }))return fail("invalid_entity_candidates");
  const {owner_token:ignoredOwner,...identity}=b;
  const key=await hash(canonicalJSON(identity));
  // b includes the exact request, candidates and semantic/policy hash. Only the
  // ephemeral owner is excluded from identity, so restart can find the result.
  await pruneEntityCache(env);const now=Date.now();
  const result=await env.DB.batch([
   env.DB.prepare("DELETE FROM entity_cache WHERE cache_key=? AND expires_at<=?").bind(key,now),
   env.DB.prepare(`INSERT INTO entity_cache(cache_key,link_id,evidence_snapshot_id,content_revision,content_hash,source_links,owner_token,status,request_json,candidates,spec_hash,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,'pending',?,?,?,?,? WHERE ${currentInput} AND (SELECT COUNT(*) FROM entity_cache)<200 ON CONFLICT(cache_key) DO NOTHING`)
    .bind(key,b.link_id,b.evidence_snapshot_id,b.content_revision,b.content_hash,links,b.owner_token,b.request_json,canonicalJSON(candidates),b.spec_hash,now,now+86400000,...bind(binding,links))
  ]);
  const row=await env.DB.prepare(`SELECT ${fields} FROM entity_cache WHERE cache_key=?`).bind(key).first<Row>();
  if(!await current(env,binding,links))return fail("entity_input_stale",409);if(!row)return fail("entity_cache_full",429);
  return reply(view(row,Number(result[1].meta.changes)===1));
 }
 const row=await env.DB.prepare(`SELECT ${fields} FROM entity_cache WHERE cache_key=?`).bind(match[1]).first<Row>();
 if(!row||row.expires_at<=Date.now())return fail("not_found",404);
 if(!match[2]){if(request.method!=="GET")return fail("method_not_allowed",405);return await current(env,row,row.source_links)?reply(view(row)):fail("entity_input_stale",409);}
 if(request.method!=="POST")return fail("method_not_allowed",405);const body=await bodyOf(request);
 if(!body||Object.keys(body).some(k=>!["owner_token","status","answers"].includes(k))||body.owner_token!==row.owner_token||!['completed','failed'].includes(String(body.status))||typeof body.status!=="string")return fail("invalid_entity_cache_completion",409);
 if(body.status==="completed"&&!validAnswers(body.answers,JSON.parse(row.candidates)))return fail("invalid_entity_answers");
 if(body.status==="failed"&&(!body.answers||typeof body.answers!=="object"||Array.isArray(body.answers)||Object.keys(body.answers).length!==0))return fail("invalid_entity_answers");
 const answers=canonicalJSON(body.answers),resultHash=await hash(canonicalJSON({status:body.status,answers:body.answers}));if(answers.length>32768)return fail("invalid_entity_answers");
 if(row.status!=="pending")return row.result_hash===resultHash&&await current(env,row,row.source_links)?reply(view(row)):fail("operation_conflict",409);
 await env.DB.prepare(`UPDATE entity_cache SET status=?,answers=?,result_hash=? WHERE cache_key=? AND owner_token=? AND status='pending' AND expires_at>? AND ${currentInput}`)
 .bind(body.status,answers,resultHash,row.cache_key,row.owner_token,Date.now(),...bind(row,row.source_links)).run();
 const saved=await env.DB.prepare(`SELECT ${fields} FROM entity_cache WHERE cache_key=?`).bind(row.cache_key).first<Row>();
 return saved?.result_hash===resultHash&&await current(env,row,row.source_links)?reply(view(saved)):fail("entity_input_stale",409);
}
