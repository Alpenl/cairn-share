import {localImage,upgradeCapture} from './images.mjs';
import {discoverMedia} from './capture.mjs';
import { API_BASE, CaptureError } from "./config.mjs";
import { localMedia, mediaDigest, forgetMedia } from './media.mjs';

export function createClient({ fetchImpl = fetch, apiBase = API_BASE, timeoutMs = 10000 } = {}) {
  async function request(token, path, body, {method,raw=false,collections=false,missing=false,stage} = {}) {
    if (!token) throw new CaptureError("not_configured");
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), raw ? 25000 : timeoutMs);
    try {
      const response = await fetchImpl(`${apiBase}${path}`, {
        method: method || (body ? "POST" : "GET"),
        headers: { ...(collections ? {"X-Cairn-Collections":"1"} : {}), Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": raw ? 'application/octet-stream' : "application/json" } : {}) },
        ...(body ? { body: raw ? body : JSON.stringify(body) } : {}),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: abort.signal
      });
      if (missing && response.status===404) return null;
      if ((path === "/api/captures" || path === "/api/captures/v2") && response.status === 404) throw new CaptureError("upgrade_required");
      if (response.status === 401 || response.status === 403) throw new CaptureError("invalid_token");
      if (response.status >= 500 || response.status === 429) throw new CaptureError("server");
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        const kind = ["revision_conflict","collection_deleted","collection_limit","invalid_collection","collections_unsupported","invalid_image","capture_incomplete","invalid_url", "invalid_note", "invalid_client_id", "invalid_capture", "capture_conflict", "capture_deleted", "capture_images_incomplete",'media_stale','media_conflict','invalid_media','media_incomplete'].includes(data?.error) ? data.error : "response";
        throw new CaptureError(kind);
      }
      if(collections && response.headers.get("X-Cairn-Collections")!=="1") throw new CaptureError("collections_unsupported");
      return await response.json().catch(() => { throw new CaptureError("response"); });
    } catch (error) {
      const failure=error instanceof CaptureError?error:new CaptureError(abort.signal.aborted ? "timeout" : "network");
      if(stage)failure.stage=stage;throw failure;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async collections(token) {const data=await request(token,"/api/collections",null,{collections:true});if(!Array.isArray(data.items))throw new CaptureError("response");return data.items;},
    async addCollection(token,id,body){return request(token,`/api/collections/${id}/operations`,body,{collections:true});},
    async test(token) {
      const data = await request(token, "/api/links?limit=1");
      if (!Array.isArray(data?.items)) throw new CaptureError("response");
    },
    async upload(token, job, persist = async()=>{}, {round=crypto.randomUUID()} = {}) {
      job=await upgradeCapture(job,persist);
      const v2=job.capture?.protocol===2;
      const base=`/api/captures/v2/${job.client_id}`;
      let data=job.savedLink,imageFailure;
      if(v2){
        if(job.attempts || data)data=await request(token,base,null,{missing:true,stage:'text'});
        if(!data || data.completed===false){
          data=await request(token,'/api/captures/v2',{url:job.url,note:job.note,client_id:job.client_id,capture:job.capture,...(job.legacyHash?{legacy_hash:job.legacyHash}:{})},{stage:'text'});
        }
      }else if(!data)data=await request(token,'/api/links',{url:job.url,note:job.note,client_id:job.client_id},{stage:'text'});
      if (!Number.isSafeInteger(data?.id) || data.id<1 || data.url!==job.url || data.note!==job.note) throw new CaptureError('response');
      if(v2){
        const images=job.capture.images;
        const ready=new Set(data.images_ready || (data.capture_result?.images_saved===images.length?images.map((_,i)=>i):[]));
        await persist({savedLink:data,stage:'images',imageProgress:{uploaded:ready.size,total:images.length}});
        let next=0;const failures=[];
        const uploadImage=async()=>{
          while(next<images.length){
            const i=next++;if(ready.has(i))continue;
            try{
              const file=await localImage(job.client_id,i,images[i]);
              const state=await request(token,`${base}/images/${i}`,{digest:file.digest,size:file.blob.size,content_type:file.blob.type},{stage:'images'});
              if(!['pending','ready'].includes(state.status))throw new CaptureError('response');
              if(state.status!=='ready'){
                const uploaded=await request(token,`${base}/images/${i}`,file.blob,{method:'PUT',raw:true,stage:'images'});
                if(uploaded.status!=='ready')throw new CaptureError('response');
              }
              ready.add(i);await persist({imageProgress:{uploaded:ready.size,total:images.length}});
            }catch(error){error.stage='images';failures.push(error);}
          }
        };
        if(job.imageRound===round && job.imageFailure && ready.size<images.length) {
          imageFailure=Object.assign(new CaptureError(job.imageFailure.kind),job.imageFailure,{stage:'images'});
        }else{
          await Promise.all(Array.from({length:Math.min(3,images.length)},uploadImage));
          imageFailure=failures[0];
          await persist({imageRound:round,imageFailure:imageFailure?{kind:imageFailure.kind||'network',...(imageFailure.origins?{origins:imageFailure.origins}:{})}:null});
        }
        if(!job.uploadMedia){
          const uploadMedia=await discoverMedia(job.url,job.capture.media||[]);
          await persist({uploadMedia});job={...job,uploadMedia};
        }
        if(!job.mediaRegistered){await request(token,`${base}/media`,job.uploadMedia,{stage:'media'});await persist({mediaRegistered:true});}
      }
      const media=job.uploadMedia || job.capture?.media || [];
      let index=job.mediaIndex || 0;
      if(index<media.length){
        await persist({stage:"media"});
        if(!job.savedLink)await persist({savedLink:data});
        const key=`${job.client_id}:${index}`,id=(await mediaDigest(key)).slice(0,32);
        const file=await localMedia(key,media[index]);
        const state=await request(token,`/api/media/uploads/${id}`,{size:file.blob.size,digest:file.digest,content_type:file.blob.type});
        if(state.status!=='ready'){
          const size=state.chunk_size;if(size!==8*1024*1024||!Array.isArray(state.parts))throw new CaptureError('response');
          const part=state.parts.length+1,start=(part-1)*size;
          if(start<file.blob.size)await request(token,`/api/media/uploads/${id}/${part}`,file.blob.slice(start,start+size),{method:'PUT',raw:true});
          const uploaded=Math.min(start+size,file.blob.size);await persist({mediaProgress:{index,total:media.length,uploaded,size:file.blob.size}});
          if(uploaded<file.blob.size)return {...data,media_pending:true};
          await request(token,`/api/media/uploads/${id}/complete`,{});
        }
        index++;await persist({mediaIndex:index,mediaProgress:null});await forgetMedia(key);
        if(index<media.length)return {...data,media_pending:true};
      }
      if(imageFailure)throw imageFailure;
      data.media_saved=media.length;
      if(v2)data.capture_result={...data.capture_result,images_saved:job.capture.images.length};
      return data;
    }
  };
}
