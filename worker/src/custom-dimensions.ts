import type { Env } from './index';
import { canonicalJSON } from './domain';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type CustomDimension = {id:string;label:string;description:string;color:number;ai_enabled:number;archived:number;revision:number};
const reply = (body:unknown,status=200) => new Response(JSON.stringify(body), {status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export async function customDimensions(env:Pick<Env,'DB'>) {
 return (await env.DB.prepare('SELECT * FROM custom_dimensions ORDER BY rowid').all<CustomDimension>()).results;
}
export async function dimensionOperation(env:Env,b:Record<string,unknown>):Promise<Response> {
 const fail=(error:string,status=400)=>reply({error},status);
 if(typeof b.operation_key!=='string'||!uuid.test(b.operation_key)||typeof b.id!=='string'||(!uuid.test(b.id)&&!['topics','resource_kinds','content_functions','carriers','affordances','forms','uses','custom'].includes(b.id))||
  !Number.isSafeInteger(b.expected_revision)||Number(b.expected_revision)<0||
  !['dimension_create','dimension_edit','dimension_archive','dimension_restore'].includes(String(b.type))||
  Object.keys(b).some(k=>!['operation_key','id','expected_revision','type','definition'].includes(k)))return fail('invalid_dimension_operation');
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJSON(b)));
 const hash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
 const receipt=()=>env.DB.prepare('SELECT payload_hash,result FROM custom_dimension_operations WHERE operation_key=?').bind(b.operation_key).first<{payload_hash:string;result:string}>();
 const old=await receipt();if(old)return old.payload_hash===hash?reply({...JSON.parse(old.result),replayed:true}):fail('operation_conflict',409);
 const before=await env.DB.prepare('SELECT * FROM custom_dimensions WHERE id=?').bind(b.id).first<CustomDimension>();
 const creating=b.type==='dimension_create';
 if(creating?!!before:!before)return fail(creating?'dimension_exists':'dimension_not_found',creating?409:404);
 if(b.expected_revision!==(before?.revision??0))return fail('revision_conflict',409);
 const value=b.definition;
 if((creating||b.type==='dimension_edit')&&(!value||typeof value!=='object'||Array.isArray(value)))return fail('invalid_dimension_definition');
 if(!creating&&b.type!=='dimension_edit'&&value!==undefined)return fail('invalid_dimension_definition');
 const v=(value??{}) as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['label','description','color','ai_enabled'].includes(k)))return fail('invalid_dimension_definition');
 const next={id:b.id,label:'',description:'',color:0,ai_enabled:1,archived:0,...before,...v,revision:(before?.revision??0)+1};
 if(typeof next.label!=='string'||!next.label.trim()||next.label.length>80||next.label.includes('\0')||
  typeof next.description!=='string'||next.description.length>1000||next.description.includes('\0')||
  !Number.isInteger(next.color)||next.color<0||next.color>7||
  (v.ai_enabled!==undefined&&typeof v.ai_enabled!=='boolean'))return fail('invalid_dimension_definition');
 next.label=next.label.trim();next.ai_enabled=Number(Boolean(next.ai_enabled));
 if(b.type==='dimension_archive')next.archived=1;
 if(b.type==='dimension_restore')next.archived=0;
 const duplicate=await env.DB.prepare('SELECT id FROM custom_dimensions WHERE lower(trim(label))=lower(?) AND id<>?').bind(next.label,b.id).first();
 if(duplicate)return fail('dimension_exists',409);
 const result=JSON.stringify({dimension:next,revision:next.revision});
 const guard=creating?'NOT EXISTS(SELECT 1 FROM custom_dimensions WHERE id=?)':'EXISTS(SELECT 1 FROM custom_dimensions WHERE id=? AND revision=?)';
 const bindings=creating?[b.id]:[b.id,b.expected_revision];
 const accepted='EXISTS(SELECT 1 FROM custom_dimension_operations WHERE operation_key=? AND payload_hash=?)';
 try { await env.DB.batch([
  env.DB.prepare(`INSERT INTO custom_dimension_operations(operation_key,payload_hash,result) SELECT ?,?,? WHERE ${guard} ON CONFLICT DO NOTHING`).bind(b.operation_key,hash,result,...bindings),
  env.DB.prepare(`INSERT INTO custom_dimensions(id,label,description,color,ai_enabled,archived,revision) SELECT ?,?,?,?,?,?,? WHERE ${accepted}
   ON CONFLICT(id) DO UPDATE SET label=excluded.label,description=excluded.description,color=excluded.color,ai_enabled=excluded.ai_enabled,archived=excluded.archived,revision=excluded.revision WHERE custom_dimensions.revision=?`)
   .bind(next.id,next.label,next.description,next.color,next.ai_enabled,next.archived,next.revision,b.operation_key,hash,b.expected_revision),
 ]); } catch(cause) {
  const duplicate=await env.DB.prepare('SELECT id FROM custom_dimensions WHERE lower(trim(label))=lower(?) AND id<>?').bind(next.label,b.id).first();
  if(duplicate)return fail('dimension_exists',409);
  if(!await receipt())throw cause;
 }
 const saved=await receipt();return !saved?fail('revision_conflict',409):saved.payload_hash!==hash?fail('operation_conflict',409):reply(JSON.parse(saved.result));
}
