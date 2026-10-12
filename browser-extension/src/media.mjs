import {CaptureError} from './config.mjs';
import {sha256} from '@noble/hashes/sha2.js';
import {ZipWriter,BlobReader,BlobWriter} from '@zip.js/zip.js';
const MIME=new Set(['video/mp4','video/webm','video/quicktime','audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/x-wav','audio/webm','audio/aac','audio/flac','application/zip']);
const db=()=>new Promise((resolve,reject)=>{const r=indexedDB.open('cairn-media-queue',1);r.onupgradeneeded=()=>r.result.createObjectStore('files');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new CaptureError('storage'));});
export async function fileStore(method,key,value){const d=await db();try{return await new Promise((resolve,reject)=>{const tx=d.transaction('files',method==='get'?'readonly':'readwrite');const r=method==='put'?tx.objectStore('files').put(value,key):tx.objectStore('files')[method](key);tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(new CaptureError('storage'));});}finally{d.close();}}
export const forgetMedia=(key)=>fileStore('delete',key);
export async function pruneMedia(clientIDs){const d=await db();try{await new Promise((resolve,reject)=>{const tx=d.transaction('files','readwrite');const store=tx.objectStore('files'),r=store.openCursor();r.onsuccess=()=>{const c=r.result;if(c){if(!clientIDs.some(id=>String(c.key).startsWith(id+':')))c.delete();c.continue();}};tx.oncomplete=resolve;tx.onerror=reject;});}finally{d.close();}}
// Hash bounded pieces; a multi-GB Blob must never become one ArrayBuffer.
export async function mediaDigest(value) {
 if(typeof value==='string')return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const hash=sha256.create();
 for(let offset=0;offset<value.size;offset+=1024*1024)hash.update(new Uint8Array(await value.slice(offset,offset+1024*1024).arrayBuffer()));
 return hash.digest().reduce((hex,b)=>hex+b.toString(16).padStart(2,'0'),'');
}
export async function fetchMedia(url,{fetchImpl=fetch,idleTimeoutMs=120000}={}) {
 let u;try{u=new URL(url);}catch{throw new CaptureError('media_unavailable');}
 if(!/^https?:$/.test(u.protocol)||u.username||u.password)throw new CaptureError('media_unavailable');
 const ext=globalThis.browser??globalThis.chrome;
 const origin=`${u.protocol}//${u.hostname}/*`;
 if(ext?.permissions && !await ext.permissions.contains({origins:[origin]})) {const e=new CaptureError('media_permission');e.origins=[origin];throw e;}
 const abort=new AbortController();let timer;
 const progress=()=>{clearTimeout(timer);timer=setTimeout(()=>abort.abort(),idleTimeoutMs);};
 progress();
 try {
  const response=await fetchImpl(url,{credentials:'omit',cache:'force-cache',signal:abort.signal});
  if(!response.ok||!response.body)throw new CaptureError('media_unavailable');
  progress();
  // Response.blob lets the browser manage the backing store instead of holding
  // every download chunk in a JavaScript array. Only inactivity expires a fetch.
  const stream=response.body.pipeThrough(new TransformStream({transform(chunk,controller){progress();controller.enqueue(chunk);}}));
  return await new Response(stream,{headers:{'Content-Type':response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()||''}}).blob();
 }catch(error){if(abort.signal.aborted)throw new CaptureError('timeout');throw error;}
 finally{clearTimeout(timer);}
}
// Stream store-only ZIP64 entries. Media is already compressed; large files,
// large offsets and long playlists must not overflow classic ZIP fields.
async function zipFiles(files){
 const writer=new ZipWriter(new BlobWriter('application/zip'),{level:0,zip64:true,useWebWorkers:false});
 for(const [name,blob] of files)await writer.add(name,new BlobReader(blob));
 return writer.close();
}
export async function archiveHLS(url,initial,fetcher=fetchMedia){
 const files=new Map(),resources=new Map();
 const download=async u=>{if(resources.has(u))return resources.get(u);const b=await fetcher(u);const name=`segment-${resources.size}.bin`;files.set(name,b);resources.set(u,name);return name;};
 const playlist=async (u,text,name)=>{
  if(!text.startsWith('#EXTM3U')||!text.includes('#EXT-X-ENDLIST'))throw new CaptureError('media_live_or_unsupported');
  if(/#EXT-X-(?:SESSION-)?KEY:(?!METHOD=NONE)/.test(text))throw new CaptureError('media_protected');
  const lines=[];
  for(const line of text.split(/\r?\n/)){
   if(line&&!line.startsWith('#'))lines.push(await download(new URL(line.trim(),u).href));
   else if(line.startsWith('#EXT-X-MAP:')){const uri=line.match(/URI="([^"]+)"/)?.[1];if(!uri)throw new CaptureError('media_live_or_unsupported');lines.push(line.replace(uri,await download(new URL(uri,u).href)));}
   else lines.push(line);
  }
  files.set(name,new Blob([lines.join('\n')],{type:'application/vnd.apple.mpegurl'}));
 };
 const text=await initial.text();
 if(text.includes('#EXT-X-STREAM-INF:')){
  const lines=text.split(/\r?\n/),variants=[];
  for(let i=0;i<lines.length;i++)if(lines[i].startsWith('#EXT-X-STREAM-INF:')&&lines[i+1]&&!lines[i+1].startsWith('#'))variants.push({line:lines[i],url:new URL(lines[i+1].trim(),url).href,bitrate:Number(lines[i].match(/(?:^|[,:])BANDWIDTH=(\d+)/)?.[1]||0)});
  variants.sort((a,b)=>b.bitrate-a.bitrate);const v=variants[0];if(!v)throw new CaptureError('media_live_or_unsupported');
  let master='#EXTM3U\n#EXT-X-VERSION:7\n';const group=v.line.match(/AUDIO="([^"]+)"/)?.[1];
  if(group){const tracks=lines.filter(l=>l.startsWith('#EXT-X-MEDIA:')&&l.includes('TYPE=AUDIO')&&l.includes(`GROUP-ID="${group}"`));const track=tracks.find(l=>l.includes('DEFAULT=YES'))||tracks[0];const uri=track?.match(/URI="([^"]+)"/)?.[1];if(uri){const au=new URL(uri,url).href;await playlist(au,await (await fetcher(au)).text(),'audio.m3u8');master+=track.replace(uri,'audio.m3u8')+'\n';}}
  await playlist(v.url,await (await fetcher(v.url)).text(),'video.m3u8');files.set('index.m3u8',new Blob([master+v.line+'\nvideo.m3u8\n']));
 }else await playlist(url,text,'index.m3u8');
 return zipFiles(files);
}
export async function localMedia(key,descriptor){
 const cached=await fileStore('get',key);if(cached)return cached;
 if(!descriptor.url)throw new CaptureError('media_unavailable');
 const runtime=(globalThis.browser??globalThis.chrome)?.runtime;
 // Extension API activity keeps an MV3 download alive while it makes progress.
 const keepAlive=runtime?.getPlatformInfo?setInterval(()=>{void runtime.getPlatformInfo().catch(()=>{});},20000):null;
 try {
 let blob=await fetchMedia(descriptor.url);
 if(/mpegurl/.test(blob.type)||new URL(descriptor.url).pathname.endsWith('.m3u8'))blob=await archiveHLS(descriptor.url,blob);
 if(!MIME.has(blob.type)){
  const ext=new URL(descriptor.url).pathname.match(/\.(mp4|webm|mp3|m4a|wav|ogg|aac|flac)$/i)?.[1]?.toLowerCase();
  const type=({mp4:'video/mp4',webm:descriptor.kind==='audio'?'audio/webm':'video/webm',mp3:'audio/mpeg',m4a:'audio/mp4',wav:'audio/wav',ogg:'audio/ogg',aac:'audio/aac',flac:'audio/flac'})[ext];
  if(!type)throw new CaptureError('media_unsupported');blob=new Blob([blob],{type});
 }
 if(!blob.size)throw new CaptureError('media_unavailable');
 const file={blob,digest:await mediaDigest(blob)};await fileStore('put',key,file);return file;
 }finally{if(keepAlive!==null)clearInterval(keepAlive);}
}
