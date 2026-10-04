import {CaptureError} from './config.mjs';
const MAX=256*1024*1024;
const MIME=new Set(['video/mp4','video/webm','video/quicktime','audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/x-wav','audio/webm','audio/aac','audio/flac','application/zip']);
const db=()=>new Promise((resolve,reject)=>{const r=indexedDB.open('cairn-media-queue',1);r.onupgradeneeded=()=>r.result.createObjectStore('files');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new CaptureError('storage'));});
async function fileStore(method,key,value){const d=await db();try{return await new Promise((resolve,reject)=>{const tx=d.transaction('files',method==='get'?'readonly':'readwrite');const r=method==='put'?tx.objectStore('files').put(value,key):tx.objectStore('files')[method](key);tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(new CaptureError('storage'));});}finally{d.close();}}
export const forgetMedia=(key)=>fileStore('delete',key);
export async function pruneMedia(clientIDs){const d=await db();try{await new Promise((resolve,reject)=>{const tx=d.transaction('files','readwrite');const store=tx.objectStore('files'),r=store.openCursor();r.onsuccess=()=>{const c=r.result;if(c){if(!clientIDs.some(id=>String(c.key).startsWith(id+':')))c.delete();c.continue();}};tx.oncomplete=resolve;tx.onerror=reject;});}finally{d.close();}}
export async function mediaDigest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):await value.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function fetchMedia(url,limit=MAX) {
 let u;try{u=new URL(url);}catch{throw new CaptureError('media_unavailable');}
 if(!/^https?:$/.test(u.protocol)||u.username||u.password)throw new CaptureError('media_unavailable');
 const ext=globalThis.browser??globalThis.chrome;
 const origin=`${u.protocol}//${u.hostname}/*`;
 if(ext?.permissions && !await ext.permissions.contains({origins:[origin]})) {const e=new CaptureError('media_permission');e.origins=[origin];throw e;}
 const response=await fetch(url,{credentials:'omit',cache:'force-cache',signal:AbortSignal.timeout(120000)});
 if(!response.ok)throw new CaptureError('media_unavailable');
 if(Number(response.headers.get('content-length'))>limit)throw new CaptureError('media_too_large');
 const reader=response.body.getReader(),chunks=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new CaptureError('media_too_large');}chunks.push(value);}
 return new Blob(chunks,{type:response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()||''});
}
const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
// Store-only ZIP: media is already compressed. Relative playlists and their
// actual segments travel together, rather than archiving an expiring URL.
async function zipFiles(files){
 const chunks=[],central=[];let offset=0,centralSize=0;
 for(const [name,blob] of files){
  const raw=new Uint8Array(await blob.arrayBuffer()),filename=new TextEncoder().encode(name);let crc=0xffffffff;
  for(const b of raw)crc=crcTable[(crc^b)&255]^(crc>>>8);crc=(crc^0xffffffff)>>>0;
  const header=new Uint8Array(30+filename.length),v=new DataView(header.buffer);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint32(14,crc,true);v.setUint32(18,raw.length,true);v.setUint32(22,raw.length,true);v.setUint16(26,filename.length,true);header.set(filename,30);
  const entry=new Uint8Array(46+filename.length),e=new DataView(entry.buffer);e.setUint32(0,0x02014b50,true);e.setUint16(4,20,true);e.setUint16(6,20,true);e.setUint32(16,crc,true);e.setUint32(20,raw.length,true);e.setUint32(24,raw.length,true);e.setUint16(28,filename.length,true);e.setUint32(42,offset,true);entry.set(filename,46);
  chunks.push(header,blob);central.push(entry);offset+=header.length+blob.size;centralSize+=entry.length;
 }
 const end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,files.size,true);e.setUint16(10,files.size,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
 return new Blob([...chunks,...central,end],{type:'application/zip'});
}
export async function archiveHLS(url,initial,fetcher=fetchMedia){
 const files=new Map(),resources=new Map();let total=0;
 const download=async u=>{if(resources.has(u))return resources.get(u);if(files.size>=1000)throw new CaptureError('media_too_large');const b=await fetcher(u,MAX-total);total+=b.size;if(total>MAX)throw new CaptureError('media_too_large');const name=`segment-${resources.size}.bin`;files.set(name,b);resources.set(u,name);return name;};
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
 const text=await initial.text();if(initial.size>1024*1024)throw new CaptureError('media_too_large');
 if(text.includes('#EXT-X-STREAM-INF:')){
  const lines=text.split(/\r?\n/),variants=[];
  for(let i=0;i<lines.length;i++)if(lines[i].startsWith('#EXT-X-STREAM-INF:')&&lines[i+1]&&!lines[i+1].startsWith('#'))variants.push({line:lines[i],url:new URL(lines[i+1].trim(),url).href,bitrate:Number(lines[i].match(/(?:^|[,:])BANDWIDTH=(\d+)/)?.[1]||0)});
  variants.sort((a,b)=>b.bitrate-a.bitrate);const v=variants[0];if(!v)throw new CaptureError('media_live_or_unsupported');
  let master='#EXTM3U\n#EXT-X-VERSION:7\n';const group=v.line.match(/AUDIO="([^"]+)"/)?.[1];
  if(group){const tracks=lines.filter(l=>l.startsWith('#EXT-X-MEDIA:')&&l.includes('TYPE=AUDIO')&&l.includes(`GROUP-ID="${group}"`));const track=tracks.find(l=>l.includes('DEFAULT=YES'))||tracks[0];const uri=track?.match(/URI="([^"]+)"/)?.[1];if(uri){const au=new URL(uri,url).href;await playlist(au,await (await fetcher(au,1024*1024)).text(),'audio.m3u8');master+=track.replace(uri,'audio.m3u8')+'\n';}}
  await playlist(v.url,await (await fetcher(v.url,1024*1024)).text(),'video.m3u8');files.set('index.m3u8',new Blob([master+v.line+'\nvideo.m3u8\n']));
 }else await playlist(url,text,'index.m3u8');
 const archive=await zipFiles(files);if(archive.size>MAX)throw new CaptureError('media_too_large');return archive;
}
export async function localMedia(key,descriptor){
 const cached=await fileStore('get',key);if(cached)return cached;
 if(!descriptor.url)throw new CaptureError('media_unavailable');
 let blob=await fetchMedia(descriptor.url);
 if(/mpegurl/.test(blob.type)||new URL(descriptor.url).pathname.endsWith('.m3u8'))blob=await archiveHLS(descriptor.url,blob);
 if(!MIME.has(blob.type)){
  const ext=new URL(descriptor.url).pathname.match(/\.(mp4|webm|mp3|m4a|wav|ogg|aac|flac)$/i)?.[1]?.toLowerCase();
  const type=({mp4:'video/mp4',webm:descriptor.kind==='audio'?'audio/webm':'video/webm',mp3:'audio/mpeg',m4a:'audio/mp4',wav:'audio/wav',ogg:'audio/ogg',aac:'audio/aac',flac:'audio/flac'})[ext];
  if(!type)throw new CaptureError('media_unsupported');blob=new Blob([blob],{type});
 }
 if(!blob.size)throw new CaptureError('media_unavailable');
 const file={blob,digest:await mediaDigest(blob)};await fileStore('put',key,file);return file;
}
