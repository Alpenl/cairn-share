import type { Env } from "./index";
import { urlIdentity } from "./url-identity";
import { readJSONObject } from "./json-body";
import { canonicalJSON } from "./domain";

const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json","Cache-Control":"private, no-store"}});
const fail=(error:string,status=400,extra={})=>reply({error,...extra},status);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Read-only "is this page already saved?" for the extension popup and the share sheet. */
async function lookup(request:Request,env:Env){
 const params=new URL(request.url).searchParams;
 const raw=params.get("url");
 if([...params.keys()].some(k=>k!=="url")||params.getAll("url").length!==1||!raw||raw.length>4096)return fail("invalid_url");
 let identity:string,url:URL;
 try{url=new URL(raw);identity=urlIdentity(raw);}catch{return fail("invalid_url");}
 if(!["http:","https:"].includes(url.protocol))return fail("invalid_url");
 const row=await env.DB.prepare(`SELECT id,url,created_at,COALESCE(NULLIF(ai_title,''),'') AS title,why,enrichment_status,
   CASE WHEN json_valid(images) AND json_type(images)='array' THEN json_array_length(images) ELSE 0 END AS image_count,
   (original_text IS NOT NULL AND original_text<>'') AS has_text
   FROM links WHERE url_identity=? OR (url_identity IS NULL AND url=?) ORDER BY id LIMIT 1`).bind(identity,raw).first<Record<string,unknown>&{id:number}>();
 if(!row)return reply({saved:false});
 const collections=await env.DB.prepare(`SELECT c.id,c.name FROM collection_items i JOIN collections c ON c.id=i.collection_id WHERE i.link_id=? AND c.deleted=0 ORDER BY c.name`).bind(row.id).all();
 return reply({saved:true,link:{...row,has_text:row.has_text===1,collections:collections.results}});
}

// Cross-device preferences. Only AI tagging lives here: reading preferences stay per device.
// E4 applies them to new decisions, so the defaults reproduce the classifier's existing
// behaviour (policy MaxPrimaryTags=5, nothing held) until the user opts in.
export const PREFERENCE_DEFAULTS={ai_suggestion_limit:5,ai_confirm_before_apply:false,ai_low_confidence_review:false};
type Preferences=typeof PREFERENCE_DEFAULTS;
const validators:Record<keyof Preferences,(v:unknown)=>boolean>={
 ai_suggestion_limit:v=>Number.isInteger(v)&&(v as number)>=1&&(v as number)<=8,
 ai_confirm_before_apply:v=>typeof v==="boolean",
 ai_low_confidence_review:v=>typeof v==="boolean",
};
export async function readPreferences(env:Pick<Env,"DB">):Promise<{value:Preferences;revision:number}>{
 const row=await env.DB.prepare("SELECT value,revision FROM preferences WHERE id=1").first<{value:string;revision:number}>();
 const stored=row?JSON.parse(row.value):{};
 const value={...PREFERENCE_DEFAULTS};
 for(const k of Object.keys(validators) as Array<keyof Preferences>)if(k in stored&&validators[k](stored[k]))(value as Record<string,unknown>)[k]=stored[k];
 return {value,revision:row?.revision??0};
}
async function writePreferences(request:Request,env:Env){
 const b=await readJSONObject(request,4*1024);
 if(!b||typeof b.operation_key!=="string"||!uuid.test(b.operation_key)||!Number.isSafeInteger(b.expected_revision)||!b.patch||typeof b.patch!=="object"||Array.isArray(b.patch)
  ||Object.keys(b).some(k=>!["operation_key","expected_revision","patch"].includes(k)))return fail("invalid_preferences");
 const patch=b.patch as Record<string,unknown>;
 if(!Object.keys(patch).length||Object.entries(patch).some(([k,v])=>!(k in validators)||!validators[k as keyof Preferences](v)))return fail("invalid_preferences");
 const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonicalJSON(b))),hash=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,"0")).join("");
 const prior=await env.DB.prepare("SELECT request_hash FROM preference_operations WHERE operation_key=?").bind(b.operation_key).first<{request_hash:string}>();
 if(prior)return prior.request_hash===hash?reply({...await readPreferences(env),replayed:true}):fail("operation_conflict",409);
 const current=await readPreferences(env);
 if(current.revision!==b.expected_revision)return fail("revision_conflict",409,current);
 const next={...current.value,...patch},stamp=new Date().toISOString();
 await env.DB.batch([
  env.DB.prepare("UPDATE preferences SET value=?,revision=revision+1,updated_at=?,last_operation=? WHERE id=1 AND revision=?").bind(JSON.stringify(next),stamp,b.operation_key,current.revision),
  env.DB.prepare("INSERT INTO preference_operations(operation_key,request_hash,revision,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM preferences WHERE id=1 AND last_operation=? AND revision=?)")
   .bind(b.operation_key,hash,current.revision+1,stamp,b.operation_key,current.revision+1),
 ]);
 const saved=await env.DB.prepare("SELECT request_hash FROM preference_operations WHERE operation_key=?").bind(b.operation_key).first<{request_hash:string}>();
 if(saved?.request_hash!==hash)return fail("revision_conflict",409,await readPreferences(env));
 return reply({...await readPreferences(env),replayed:false});
}
/** Bookmarks whose legacy 整理状态 was 不要 (drop). The UI no longer offers that status, but those items stay out of the to-read queue, AI tagging and rules. */
async function legacyDropped(env:Env){
 const n=await env.DB.prepare("SELECT COUNT(*) AS n FROM links WHERE curation_status='drop'").first<{n:number}>("n");
 return reply({count:Number(n??0)});
}

export async function libraryExtrasRoute(request:Request,env:Env,path:string):Promise<Response|null>{
 if(path==="/api/links/lookup")return request.method==="GET"?lookup(request,env):fail("method_not_allowed",405);
 if(path==="/api/preferences")return request.method==="GET"?reply(await readPreferences(env)):fail("method_not_allowed",405);
 if(path==="/api/preferences/operations")return request.method==="POST"?writePreferences(request,env):fail("method_not_allowed",405);
 if(path==="/api/links/legacy-dropped")return request.method==="GET"?legacyDropped(env):fail("method_not_allowed",405);
 return null;
}
