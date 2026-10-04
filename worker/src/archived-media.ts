import type { Env } from './index';
import { readBoundedJSON } from './json-body';
const CHUNK = 8 * 1024 * 1024, MAX = 256 * 1024 * 1024;
const types: Record<string,string> = {'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','audio/mpeg':'mp3','audio/mp4':'m4a','audio/ogg':'ogg','audio/wav':'wav','audio/x-wav':'wav','audio/webm':'webm','audio/aac':'aac','audio/flac':'flac','application/zip':'zip'};
const reply = (body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
type Media = {id:string;link_id:number;capture_id:string;ordinal:number;url:string;title:string;kind:string;content_type:string;size:number;digest:string;r2_key:string;upload_id:string;upload_started_at:string;parts:string;status:string};
type Part = {partNumber:number;etag:string;size:number;digest:string};
async function sha(value:string|Uint8Array) {
 const raw=typeof value==='string'?new TextEncoder().encode(value):value;
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',raw))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function validMediaDeclarations(value:unknown): boolean {
 if(value===undefined)return true;
 return Array.isArray(value)&&value.length<=16&&value.every(m=>{
  if(!m||!['video','audio'].includes(m.kind)||typeof m.url!=='string'||m.url.length>8192||typeof m.title!=='string'||m.title.length>300)return false;
  if(!m.url)return true;
  try{const u=new URL(m.url);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password;}catch{return false;}
 });
}
export async function registerMedia(env:Env,captureID:string,items:{url:string;title:string;kind:string}[]) {
 if(!items?.length)return;
 const statements=await Promise.all(items.map(async (item,ordinal)=>env.DB.prepare(`INSERT INTO archived_media(id,link_id,capture_id,ordinal,url,title,kind,updated_at)
  SELECT ?,l.id,?,?,?,?,?,? FROM links l JOIN browser_captures b ON b.link_id=l.id
  WHERE b.client_id=? AND b.completed=1 AND l.last_capture_id=b.client_id ON CONFLICT(capture_id,ordinal) DO NOTHING`)
  .bind((await sha(captureID+':'+ordinal)).slice(0,32),captureID,ordinal,item.url,item.title,item.kind,new Date().toISOString(),captureID)));
 await env.DB.batch(statements);
}
async function current(env:Env,id:string) {
 return env.DB.prepare(`SELECT m.* FROM archived_media m JOIN links l ON l.id=m.link_id WHERE m.id=? AND l.last_capture_id=m.capture_id`).bind(id).first<Media>();
}
async function json(request:Request) { try{return await readBoundedJSON(request,8192) as Record<string,any>;}catch{return null;} }
export async function mediaRoute(request:Request,env:Env,path:string):Promise<Response> {
 const list=path.match(/^\/api\/(?:links|enrichment)\/(\d+)\/media$/);
 if(list){
  if(request.method!=='GET')return reply({error:'method_not_allowed'},405);
  if(!await env.DB.prepare('SELECT id FROM links WHERE id=?').bind(Number(list[1])).first())return reply({error:'not_found'},404);
  const rows=await env.DB.prepare(`SELECT m.id,m.title,m.kind,m.content_type,m.size,m.status FROM archived_media m JOIN links l ON l.id=m.link_id
   WHERE m.link_id=? AND l.last_capture_id=m.capture_id ORDER BY m.ordinal`).bind(Number(list[1])).all();
  return reply({items:rows.results});
 }
 const upload=path.match(/^\/api\/media\/uploads\/([a-f0-9]{32})(?:\/(\d+|complete))?$/);
 if(upload){
  let m=await current(env,upload[1]);if(!m)return reply({error:'media_stale'},409);
  if(request.method==='GET'&&!upload[2])return reply({id:m.id,status:m.status,parts:JSON.parse(m.parts),chunk_size:CHUNK});
  if(request.method==='POST'&&!upload[2]){
   const b=await json(request);
   if(!b||!types[b.content_type]||!Number.isSafeInteger(b.size)||b.size<1||b.size>MAX||!/^[a-f0-9]{64}$/.test(b.digest||''))return reply({error:'invalid_media'},400);
   if(m.size&&(m.size!==b.size||m.digest!==b.digest||m.content_type!==b.content_type))return reply({error:'media_conflict'},409);
   if(m.status==='ready')return reply({id:m.id,status:m.status,parts:JSON.parse(m.parts),chunk_size:CHUNK});
   const key=`enrichment/${m.link_id}/media/${b.digest}.${types[b.content_type]}`;
   const reusable=await env.ENRICHMENT_IMAGES.head(key);
   if(reusable&&reusable.size===b.size){
    const reused=await env.DB.prepare("UPDATE archived_media SET size=?,digest=?,content_type=?,r2_key=?,status='ready',updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM links WHERE id=link_id AND last_capture_id=capture_id)")
     .bind(b.size,b.digest,b.content_type,key,new Date().toISOString(),m.id).run();
    if(!reused.meta.changes)return reply({error:'media_stale'},409);
    return reply({id:m.id,status:'ready',parts:[],chunk_size:CHUNK});
   }
   if(m.upload_id && Date.parse(m.upload_started_at || '1970-01-01') < Date.now()-6*86400000){
    const old=await env.ENRICHMENT_IMAGES.resumeMultipartUpload(m.r2_key,m.upload_id);
    try{await old.abort();}catch{/* R2 may already have expired the upload. */}
    await env.DB.prepare("UPDATE archived_media SET upload_id=NULL,parts='[]' WHERE id=? AND upload_id=? AND status<>'ready'").bind(m.id,m.upload_id).run();
    m=await current(env,m.id);if(!m)return reply({error:'media_stale'},409);
   }
   if(!m.upload_id){
    const multipart=await env.ENRICHMENT_IMAGES.createMultipartUpload(key,{httpMetadata:{contentType:b.content_type}});
    const saved=await env.DB.prepare("UPDATE archived_media SET size=?,digest=?,content_type=?,r2_key=?,upload_id=?,status='uploading',updated_at=?,upload_started_at=? WHERE id=? AND upload_id IS NULL AND EXISTS(SELECT 1 FROM links WHERE id=link_id AND last_capture_id=capture_id)")
     .bind(b.size,b.digest,b.content_type,key,multipart.uploadId,new Date().toISOString(),new Date().toISOString(),m.id).run();
    if(!saved.meta.changes)await multipart.abort();
   }
   m=await current(env,m.id);if(!m)return reply({error:'media_stale'},409);
   return reply({id:m.id,status:m.status,parts:JSON.parse(m.parts),chunk_size:CHUNK});
  }
  if(request.method==='POST'&&upload[2]==='complete'&&m.status==='ready')return reply({id:m.id,status:'ready'});
  if(!m.upload_id)return reply({error:'media_not_initialized'},409);
  if(request.method==='PUT'&&/^\d+$/.test(upload[2]||'')){
   const n=Number(upload[2]),count=Math.ceil(m.size/CHUNK),expected=n===count?m.size-(n-1)*CHUNK:CHUNK;
   if(n<1||n>count||!request.body)return reply({error:'invalid_media_part'},400);
   const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
   for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>expected){await reader.cancel();return reply({error:'invalid_media_part'},400);}chunks.push(value);}
   if(size!==expected)return reply({error:'invalid_media_part'},400);
   const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
   const digest=await sha(bytes),parts:Part[]=JSON.parse(m.parts),old=parts.find(p=>p.partNumber===n);
   if(old)return old.digest===digest?reply({part:n}):reply({error:'media_conflict'},409);
   const multipart=await env.ENRICHMENT_IMAGES.resumeMultipartUpload(m.r2_key,m.upload_id);
   const part=await multipart.uploadPart(n,bytes);
   parts.push({...part,size,digest});parts.sort((a,b)=>a.partNumber-b.partNumber);
   const stored=await env.DB.prepare('UPDATE archived_media SET parts=?,updated_at=? WHERE id=? AND parts=? AND upload_id=? AND EXISTS(SELECT 1 FROM links WHERE id=link_id AND last_capture_id=capture_id)')
    .bind(JSON.stringify(parts),new Date().toISOString(),m.id,m.parts,m.upload_id).run();
   return stored.meta.changes?reply({part:n}):reply({error:'media_conflict'},409);
  }
  if(request.method==='POST'&&upload[2]==='complete'){
   if(m.status==='ready')return reply({id:m.id,status:'ready'});
   const parts:Part[]=JSON.parse(m.parts);
   if(parts.length!==Math.ceil(m.size/CHUNK)||parts.some((p,i)=>p.partNumber!==i+1)||parts.reduce((n,p)=>n+p.size,0)!==m.size)return reply({error:'media_incomplete'},409);
   const existing=await env.ENRICHMENT_IMAGES.head(m.r2_key);
   if(!existing){const multipart=await env.ENRICHMENT_IMAGES.resumeMultipartUpload(m.r2_key,m.upload_id);await multipart.complete(parts.map(({partNumber,etag})=>({partNumber,etag})));}
   const result=await env.DB.prepare("UPDATE archived_media SET status='ready',updated_at=? WHERE id=? AND parts=? AND upload_id=? AND EXISTS(SELECT 1 FROM links WHERE id=link_id AND last_capture_id=capture_id)")
    .bind(new Date().toISOString(),m.id,m.parts,m.upload_id).run();
   if(!result.meta.changes)return reply({error:'media_stale'},409);
   return reply({id:m.id,status:'ready'});
  }
  return reply({error:'method_not_allowed'},405);
 }
 const file=path.match(/^\/api\/(?:enrichment\/)?media\/([a-f0-9]{32})$/);
 if(file&&['GET','HEAD'].includes(request.method)){
  const m=await current(env,file[1]);if(!m||m.status!=='ready')return reply({error:'not_found'},404);
  const range=request.headers.get('Range');
  if(range&&!/^bytes=(?:\d+-\d*|-\d+)$/.test(range))return reply({error:'invalid_range'},416);
  let wanted:{offset:number;length:number}|undefined;
  if(range){
   const [first,last]=range.slice(6).split('-');const start=first?Number(first):Math.max(0,m.size-Number(last));const end=first?(last?Math.min(Number(last),m.size-1):m.size-1):m.size-1;
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=m.size||end<start||(!first&&Number(last)===0))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${m.size}`,'Cache-Control':'private, no-store'}});
   wanted={offset:start,length:end-start+1};
  }
  const object=await env.ENRICHMENT_IMAGES.get(m.r2_key,wanted?{range:wanted}:undefined);
  if(!object)return reply({error:'not_found'},404);
  const again=await current(env,m.id);if(!again||again.status!=='ready'||again.r2_key!==m.r2_key)return reply({error:'not_found'},404);
  const headers=new Headers({'Content-Type':m.content_type,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store','Accept-Ranges':'bytes','ETag':object.httpEtag,
   'Content-Disposition':`${m.content_type==='application/zip'?'attachment':'inline'}; filename="media.${types[m.content_type]}"`});
  let status=200;
  if(range&&object.range){
   const r=object.range as {offset?:number;length?:number;suffix?:number};const start=r.offset??Math.max(0,object.size-(r.suffix??object.size)),length=r.length??r.suffix??object.size;
   headers.set('Content-Range',`bytes ${start}-${start+length-1}/${object.size}`);headers.set('Content-Length',String(length));status=206;
  }else headers.set('Content-Length',String(object.size));
  return new Response(request.method==='HEAD'?null:object.body,{status,headers});
 }
 return reply({error:'not_found'},404);
}
