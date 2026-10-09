import type { Env } from "./index";
import { readJSONObject } from "./json-body";
import { taxonomyV2, classificationTaxonomy, validateTaxonomy, normalizeTerm, type Taxonomy, type TermDefinition } from "./taxonomy-v2";
import { canonicalJSON } from "./domain";

export const catalogDimensions = ["topics","resource_kinds","content_functions","carriers","affordances","forms","uses"] as const;
export type CatalogDimension = typeof catalogDimensions[number];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reply = (body:unknown,status=200) => new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json","Cache-Control":"private, no-store","X-Cairn-Tag-System":"1"}});
const fail = (error:string,status=400,extra={}) => reply({error,...extra},status);
export async function managedCatalog(env:Pick<Env,"DB">):Promise<{revision:number;catalog:Taxonomy}> {
 const row=await env.DB.prepare("SELECT s.revision,p.catalog FROM tag_catalog_state s LEFT JOIN tag_catalog_snapshots p ON p.revision=s.revision WHERE s.id=1").first<{revision:number;catalog:string|null}>();
 return {revision:row?.revision??0,catalog:row?.catalog?JSON.parse(row.catalog):structuredClone(taxonomyV2())};
}
// Ordinary static-tag filters remain allocation/query compatible with the
// existing fast path. Runtime IDs and refinements need the current directory.
export async function filterCatalog(env:Pick<Env,"DB">,url:URL):Promise<Taxonomy|undefined> {
 return url.searchParams.has("topic_refinements")||[...url.searchParams.values()].some(v=>/(?:^|,)tag_[0-9a-f]{32}(?:,|$)/.test(v))?(await managedCatalog(env)).catalog:undefined;
}
export async function historicalCatalog(env:Pick<Env,"DB">,version:string):Promise<Taxonomy|null> {
 const seed=classificationTaxonomy(version);if(seed)return seed;
 const row=await env.DB.prepare("SELECT catalog FROM tag_catalog_snapshots WHERE version=? ORDER BY revision DESC LIMIT 1").bind(version).first<{catalog:string}>();
 return row?JSON.parse(row.catalog):null;
}
export function catalogTerm(catalog:Taxonomy,dimension:string,id:string):TermDefinition|undefined {
 return catalogDimensions.includes(dimension as CatalogDimension)?catalog[dimension as CatalogDimension]?.find(t=>t.id===id):undefined;
}
async function displayedCatalog(env:Env) {
 const current=await managedCatalog(env);
 // Legacy seed/snapshots predate ai_enabled. Opposition has always been a
 // human-only tag; expose that invariant before editing/archive validation.
 // Leave immutable source and historical snapshots untouched.
 const opposition=catalogTerm(current.catalog,'uses','contra');
 if(opposition)opposition.ai_enabled=false;
 const rows=await env.DB.prepare("SELECT dimension,term_id,label,display_revision FROM taxonomy_display_overrides").all<{dimension:string;term_id:string;label:string;display_revision:number}>();
 for(const row of rows.results){const term=catalogTerm(current.catalog,row.dimension,row.term_id);if(term&&row.display_revision>(term.display_revision??0)){term.label=row.label;term.display_revision=row.display_revision;}}
 return current;
}
function definition(value:unknown,dimension:CatalogDimension,before?:TermDefinition):TermDefinition|null {
 if(!value||typeof value!=="object"||Array.isArray(value))return null;
 const v=value as Record<string,unknown>;
 const allowed=["label","aliases","description","includes","excludes","granularity","navigation","recall_terms","ai_enabled"];
 if(Object.keys(v).some(k=>!allowed.includes(k)))return null;
 const result:Record<string,unknown>={...before,...v};
 if(typeof result.label!=="string"||!result.label.trim()||result.label.length>80||result.label.includes("\0")||typeof result.description!=="string"||result.description.length>1000||!result.description.trim())return null;
 for(const k of ["aliases","includes","excludes",...(dimension==="topics"?["recall_terms"]:[])]){const list=result[k]??[];if(!Array.isArray(list)||list.length>32||list.some(x=>typeof x!=="string"||!x.trim()||x.length>240||x.includes("\0")))return null;result[k]=[...new Set(list.map(x=>x.trim()))];}
 if(typeof result.ai_enabled!=="boolean"&&result.ai_enabled!==undefined)return null;
 if((result.aliases as string[]).length>20||(result.aliases as string[]).some(x=>x.length>80))return null;
 if(dimension!=="topics"&&["granularity","navigation","recall_terms"].some(k=>k in v))return null;
 if(dimension==="topics"&&!['broad','specific'].includes(String(result.granularity??'specific')))return null;
 if(result.navigation!==undefined&&typeof result.navigation!=="boolean")return null;
 if(dimension==='topics'){
  // A small human-defined tag needs usable Jev boundaries without making
  // optional example fields a prerequisite for creating it.
  if((result.granularity??'specific')==='specific'){
   if(!(result.includes as string[]).length)result.includes=[result.description.trim().slice(0,240)];
   if(!(result.excludes as string[]).length)result.excludes=['仅出现名称，正文没有讨论该主题'];
   if(!(result.recall_terms as string[]).length)result.recall_terms=[result.label.trim()];
  }
  const recall=result.recall_terms as string[];
  if(recall.some(x=>x.length>80))return null;
  result.recall_terms=[...new Map(recall.map(x=>[x.toLowerCase().replace(/\s+/g,' ').trim(),x])).values()];
 }
 return {...result,id:before?.id??`tag_${crypto.randomUUID().replaceAll('-','')}`,label:result.label.trim(),active:before?.active??true,deprecated:before?.deprecated??false,status:before?.status??"active",aliases:result.aliases as string[],ai_enabled:result.ai_enabled??true,
  ...(dimension==='topics'?{granularity:(result.granularity??'specific') as 'broad'|'specific',navigation:result.navigation??false,recall_terms:result.recall_terms as string[]}:{})} as TermDefinition;
}
export async function tagCatalogRoute(request:Request,env:Env,path:string):Promise<Response> {
 if(request.headers.get("X-Cairn-Tag-System")!=="1")return fail("capability_mismatch",409);
 if(path.endsWith('/history')) {
  if(request.method!=="GET")return fail("method_not_allowed",405);
  const refs=new URL(request.url).searchParams,dimension=refs.get('dimension'),id=refs.get('id');
  if(!catalogDimensions.includes(dimension as CatalogDimension)||!id)return fail('invalid_tag');
  const rows=await env.DB.prepare("SELECT operation_key,revision,action,before_value,after_value,created_at FROM tag_catalog_operations WHERE dimension=? AND term_id=? ORDER BY revision DESC LIMIT 100").bind(dimension,id).all();
  return reply({items:rows.results});
 }
 if(!path.endsWith('/operations')) {
  if(request.method!=="GET")return fail("method_not_allowed",405);
  const [current,counts]=await Promise.all([displayedCatalog(env),env.DB.prepare("SELECT field,term,COUNT(*) AS n FROM effective_tag_memberships GROUP BY field,term").all<{field:string;term:string;n:number}>()]);
  const custom=await env.DB.prepare("SELECT t.id,t.owner_id,t.label,t.revision,t.status,COUNT(a.link_id) AS link_count FROM custom_tags t LEFT JOIN custom_tag_links a ON a.tag_id=t.id WHERE t.owner_id='default' GROUP BY t.id ORDER BY t.label,t.id").all();
  return reply({...current,counts:counts.results,custom_tags:custom.results.map(t=>({...t,tag_ref:`custom/default/${t.id}`}))});
 }
 if(request.method!=="POST")return fail("method_not_allowed",405);
 const b=await readJSONObject(request,32*1024);
 if(!b||typeof b.operation_key!=='string'||!uuid.test(b.operation_key)||!Number.isSafeInteger(b.expected_revision)||!catalogDimensions.includes(b.dimension as CatalogDimension)||!['create','edit','archive','restore'].includes(String(b.type))||Object.keys(b).some(k=>!['operation_key','expected_revision','dimension','id','type','definition'].includes(k)))return fail('invalid_tag_operation');
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJSON(b))),hash=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
 const receipt=()=>env.DB.prepare('SELECT request_hash,revision,term_id FROM tag_catalog_operations WHERE operation_key=?').bind(b.operation_key).first<{request_hash:string;revision:number;term_id:string}>();
 const previous=await receipt();if(previous)return previous.request_hash===hash?reply({...await displayedCatalog(env),operation_revision:previous.revision,id:previous.term_id,replayed:true}):fail('operation_conflict',409);
 const current=await displayedCatalog(env);
 if(current.revision!==b.expected_revision)return fail('revision_conflict',409,{revision:current.revision});
 const dimension=b.dimension as CatalogDimension,catalog=current.catalog;
 const before=typeof b.id==='string'?catalogTerm(catalog,dimension,b.id):undefined;
 if(b.type!=='create'&&!before)return fail('tag_not_found',404);
 if(b.type==='create'&&(b.id!==undefined||dimension!=='topics'))return fail('invalid_dimension');
 let after:TermDefinition|null;
 if(b.type==='archive'||b.type==='restore'){if(b.definition!==undefined)return fail('invalid_tag_operation');after={...before!,active:b.type==='restore',deprecated:b.type==='archive',status:b.type==='restore'?'active':'deprecated'};}
 else after=definition(b.definition,dimension,before);
 if(!after)return fail('invalid_tag_definition');
 // Personal opposition remains human-only even if its display name changes.
 if(dimension==='uses'&&after.id==='contra'&&after.ai_enabled!==false)return fail('personal_use_human_only');
 const values=catalog[dimension]??[];
 if(b.type==='create'&&values.length>=128)return fail('tag_limit',409);
 catalog[dimension]=[...values.filter(t=>t.id!==after!.id),after];
 const problems=validateTaxonomy(catalog);if(problems.length)return fail('tag_collision',409,{details:problems});
 if(!catalog[dimension]?.some(t=>t.active&&!t.deprecated&&t.ai_enabled!==false&&!(dimension==='uses'&&t.id==='contra')))return fail('last_ai_tag',409);
 const custom=await env.DB.prepare("SELECT label FROM custom_tags WHERE status='active'").all<{label:string}>();
 if(custom.results.some(t=>[after!.label,...after!.aliases].some(a=>normalizeTerm(a.normalize('NFKC'))===normalizeTerm(t.label.normalize('NFKC')))))return fail('tag_collision',409);
 const semantics=(t:TermDefinition|undefined)=>t?canonicalJSON({description:t.description,includes:t.includes??[],excludes:t.excludes??[],active:t.active,deprecated:!!t.deprecated,ai_enabled:t.ai_enabled!==false,granularity:t.granularity,recall_terms:t.recall_terms??[]}):'';
 const semantic=semantics(before)!==semantics(after);
 after.definition_version=(before?.definition_version??0)+(semantic?1:0);after.display_revision=(before?.display_revision??0)+1;
 const next=current.revision+1,stamp=new Date().toISOString(),admission=crypto.randomUUID();
 if(semantic){catalog.version=`managed-${crypto.randomUUID()}`;catalog.definition_version++;}
 const guard='EXISTS(SELECT 1 FROM tag_catalog_state WHERE id=1 AND revision=? AND last_operation=?)';
 await env.DB.batch([
  env.DB.prepare('UPDATE tag_catalog_state SET revision=?,version=?,last_operation=? WHERE id=1 AND revision=? AND NOT EXISTS(SELECT 1 FROM tag_catalog_operations WHERE operation_key=?)').bind(next,catalog.version,admission,current.revision,b.operation_key),
  env.DB.prepare(`INSERT INTO tag_catalog_snapshots(revision,version,catalog,created_at) SELECT ?,?,?,? WHERE ${guard}`).bind(next,catalog.version,JSON.stringify(catalog),stamp,next,admission),
  env.DB.prepare(`INSERT INTO tag_catalog_operations(operation_key,request_hash,revision,dimension,term_id,action,before_value,after_value,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard}`).bind(b.operation_key,hash,next,dimension,after.id,b.type,before?JSON.stringify(before):null,JSON.stringify(after),stamp,next,admission),
  env.DB.prepare(`DELETE FROM taxonomy_display_overrides WHERE dimension=? AND term_id=? AND ${guard}`).bind(dimension,after.id,next,admission),
  env.DB.prepare(`INSERT INTO cache_metadata(key,value,updated_at) SELECT 'links_generation',1,? WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value=cache_metadata.value+1,updated_at=excluded.updated_at`).bind(stamp,next,admission)
 ]);
 const saved=await receipt();if(!saved)return fail('revision_conflict',409,{revision:(await managedCatalog(env)).revision});
 if(saved.request_hash!==hash)return fail('operation_conflict',409);
 return reply({...await displayedCatalog(env),id:after.id,operation_revision:next,replayed:false});
}
