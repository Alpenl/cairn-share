import { CaptureError } from './config.mjs';
import { fileStore, mediaDigest } from './media.mjs';

const MAX=16*1024*1024;
const imageType=t=>/^image\/(png|jpeg|webp|gif|avif)$/.test(t);
export const imageKey=(id,i)=>`${id}:image:${i}`;

export async function keepImageFallback(id,i,data) {
  if(!data)return;
  const match=data.match(/^data:(image\/(?:png|jpeg|webp|gif|avif));base64,([A-Za-z0-9+/=]+)$/);
  if(!match)return;
  const raw=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));
  if(raw.length>MAX)throw new CaptureError('media_too_large');
  const blob=new Blob([raw],{type:match[1]});
  await fileStore('put',imageKey(id,i)+':fallback',{blob,digest:await mediaDigest(blob)});
}

export async function localImage(id,i,descriptor) {
  const key=imageKey(id,i),cached=await fileStore('get',key);
  if(cached)return cached;
  const fallback=await fileStore('get',key+':fallback');
  let file;
  // A legacy queue already contains the exact bytes used in its receipt hash.
  if(descriptor.local)file=fallback;
  else try {
    const u=new URL(descriptor.url),ext=globalThis.browser??globalThis.chrome;
    const origin=`${u.protocol}//${u.hostname}/*`;
    if(!/^https?:$/.test(u.protocol)||u.username||u.password)throw new CaptureError('media_unavailable');
    if(ext?.permissions&&!await ext.permissions.contains({origins:[origin]})){
      const error=new CaptureError('media_permission');error.origins=[origin];throw error;
    }
    const r=await fetch(u.href,{credentials:'omit',cache:'force-cache',signal:AbortSignal.timeout(20000)});
    const type=r.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if(!r.ok||!imageType(type))throw new CaptureError('media_unavailable');
    if(Number(r.headers.get('content-length'))>MAX)throw new CaptureError('media_too_large');
    const reader=r.body.getReader(),chunks=[];let size=0;
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX){await reader.cancel();throw new CaptureError('media_too_large');}chunks.push(value);}
    if(!size)throw new CaptureError('media_unavailable');
    const blob=new Blob(chunks,{type});file={blob,digest:await mediaDigest(blob)};
  }catch(error){if(fallback)file=fallback;else throw error;}
  if(!file)throw new CaptureError('media_unavailable');
  await fileStore('put',key,file);return file;
}

function canonical(value){return value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;}
export async function upgradeCapture(job,persist) {
  if(!job.capture||job.capture.protocol===2)return job;
  const body={url:job.url,note:job.note,client_id:job.client_id,capture:job.capture};
  const legacyHash=await mediaDigest(canonical(body));
  const images=[];
  for(let i=0;i<job.capture.images.length;i++){
    const image=job.capture.images[i];
    await keepImageFallback(job.client_id,i,`data:${image.content_type};base64,${image.data}`);
    images.push({url:'',local:true});
  }
  const capture={...job.capture,images,protocol:2};
  // Commit only after every binary is durable. A crash before this write leaves
  // the old full queue intact; after it the new descriptors resolve locally.
  const patch={capture,legacyHash};await persist(patch);return {...job,...patch};
}
