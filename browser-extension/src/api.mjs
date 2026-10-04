import { API_BASE, CaptureError } from "./config.mjs";
import { localMedia, mediaDigest, forgetMedia } from './media.mjs';

export function createClient({ fetchImpl = fetch, apiBase = API_BASE, timeoutMs = 10000 } = {}) {
  async function request(token, path, body, {method,raw=false} = {}) {
    if (!token) throw new CaptureError("not_configured");
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), raw ? 30000 : timeoutMs);
    try {
      const response = await fetchImpl(`${apiBase}${path}`, {
        method: method || (body ? "POST" : "GET"),
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": raw ? 'application/octet-stream' : "application/json" } : {}) },
        ...(body ? { body: raw ? body : JSON.stringify(body) } : {}),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: abort.signal
      });
      if (path === "/api/captures" && response.status === 404) throw new CaptureError("upgrade_required");
      if (response.status === 401 || response.status === 403) throw new CaptureError("invalid_token");
      if (response.status >= 500 || response.status === 429) throw new CaptureError("server");
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        const kind = ["invalid_url", "invalid_note", "invalid_client_id", "invalid_capture", "capture_conflict", "capture_deleted", "capture_images_incomplete",'media_stale','media_conflict','invalid_media','media_incomplete'].includes(data?.error) ? data.error : "response";
        throw new CaptureError(kind);
      }
      return await response.json().catch(() => { throw new CaptureError("response"); });
    } catch (error) {
      if (error instanceof CaptureError) throw error;
      throw new CaptureError(abort.signal.aborted ? "timeout" : "network");
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async test(token) {
      const data = await request(token, "/api/links?limit=1");
      if (!Array.isArray(data?.items)) throw new CaptureError("response");
    },
    async upload(token, job, persist = async()=>{}) {
      const data = job.savedLink || await request(token, job.capture ? "/api/captures" : "/api/links", { url: job.url, note: job.note, client_id: job.client_id, ...(job.capture ? {capture:job.capture} : {}) });
      if (!Number.isSafeInteger(data?.id) || data.id < 1 || data.url !== job.url || data.note !== job.note) {
        throw new CaptureError("response");
      }
      const media = job.capture?.media || [];
      let index=job.mediaIndex || 0;
      if(index<media.length){
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
      data.media_saved=media.length;
      return data;
    }
  };
}
