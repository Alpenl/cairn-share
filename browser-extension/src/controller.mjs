import { CaptureError, MAX_QUEUE, submissionUrl, tokenIdentity, validateCapture } from "./config.mjs";

export function emptyState() {
  return { settings: { token: "", keepFullUrl: true }, queue: [], lastResult: null };
}

const PAUSED_ERRORS = new Set(["invalid_image","capture_incomplete","revision_conflict","collection_deleted","collection_limit","collections_unsupported","invalid_token", "invalid_url", "invalid_note", "invalid_client_id", "invalid_capture", "capture_conflict", "capture_deleted", "capture_images_incomplete", "upgrade_required",'media_stale','media_conflict','invalid_media','media_permission','media_too_large','media_protected','media_unsupported','media_unavailable','media_live_or_unsupported']);

// Only this background controller writes storage. A mutex prevents independent
// popup/menu/alarm events from overwriting one another's persisted changes.
export function createController({ store, client, now = Date.now, uuid = () => crypto.randomUUID(), onChange = async () => {}, onUploaded = async () => {} }) {
  let mutations = Promise.resolve();
  let flushPromise = null;
  let connectionTest = null;

  const read = async () => (await store.read()) ?? emptyState();
  function update(edit) {
    const operation = mutations.then(async () => {
      const state = await read();
      const result = await edit(state);
      try { await store.write(state); } catch { throw new CaptureError("storage"); }
      try { await onChange(state); } catch { /* A badge failure must not undo a durable save. */ }
      return result;
    });
    mutations = operation.catch(() => {});
    return operation;
  }

  async function snapshot() {
    await mutations;
    const state = await read();
    // Never send the saved token to the popup, content pages, or queue views.
    return {
      configured: Boolean(state.settings.token),
      binding:state.settings.token?await tokenIdentity(state.settings.token):"",
      keepFullUrl: state.settings.keepFullUrl,
      queue: state.queue.map(({ binding, capture, ...job }) => job),
      lastResult: state.lastResult
    };
  }

  async function saveSettings({ token, keepFullUrl, movePending = false }) {
    if (typeof keepFullUrl !== "boolean" || typeof token !== "string" || token.trim().length > 512) throw new CaptureError("invalid_token");
    // An empty field keeps the existing token; the options page never needs
    // to read it back. A candidate is tested before the active token changes.
    const previous = await read();
    const candidate = token.trim() || previous.settings.token;
    if (!candidate) throw new CaptureError("not_configured");
    if (connectionTest) throw new CaptureError("unexpected");
    connectionTest = candidate;
    try {
      await client.test(candidate);
      const binding = await tokenIdentity(candidate);
      await update((state) => {
        if (candidate !== state.settings.token && state.queue.length && !movePending) throw new CaptureError("queue_connection");
        if (candidate !== state.settings.token) {
          state.queue.forEach((job) => { job.binding = binding; job.collection_ids=[];job.collectionOperations={};job.collectionIndex=0;delete job.savedLink;delete job.mediaIndex;delete job.mediaProgress;delete job.legacyHash;delete job.uploadMedia;delete job.mediaRegistered;delete job.imageProgress;delete job.stage; job.errorKind = null; job.nextAttemptAt = 0; });
        }
        state.settings = { token: candidate, keepFullUrl };
      });
    } finally { connectionTest = null; }
    return snapshot();
  }

  async function enqueue({ url, note = "", title = "", client_id, capture: pageCapture, collection_ids = [], binding: captureBinding }) {
    // The popup persists this UUID before messaging background, so closing
    // it during an upload and re-opening cannot create a second operation.
    if (typeof client_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(client_id)) {
      throw new CaptureError("invalid_client_id");
    }
    return update(async (state) => {
      const existing = state.queue.find((job) => job.client_id === client_id);
      if (existing) return existing;
      if (state.lastResult?.client_id === client_id) return state.lastResult;
      if (!state.settings.token) throw new CaptureError("not_configured");
      if(collection_ids.length && captureBinding!==await tokenIdentity(state.settings.token))throw new CaptureError("queue_connection");
      if (state.queue.length >= MAX_QUEUE) throw new CaptureError("queue_full");
      if(!Array.isArray(collection_ids)||collection_ids.length>100||new Set(collection_ids).size!==collection_ids.length||collection_ids.some(id=>typeof id!=="string"||!/^[a-f0-9-]{36}$/.test(id)))throw new CaptureError("invalid_collection");
      const capture = validateCapture(submissionUrl(url, state.settings.keepFullUrl), note);
      if (pageCapture && JSON.stringify(state.queue).length + JSON.stringify(pageCapture).length > 24000000) throw new CaptureError("queue_full");
      const job = { ...capture, collection_ids, collectionOperations:{}, collectionIndex:0, ...(pageCapture ? { capture: pageCapture } : {}), title: typeof title === "string" ? title.slice(0, 300) : "", client_id,
        binding: await tokenIdentity(state.settings.token), createdAt: now(), attempts: 0, nextAttemptAt: 0, errorKind: null };
      state.queue.push(job);
      state.lastResult = { client_id, url: job.url, title: job.title, status: "queued", at: now() };
      return job;
    });
  }

  function flush({ force = false, onlyId } = {}) {
    // A new menu/capture event can arrive after an existing flush has read
    // its final empty queue. Run another pass after it settles, so that the
    // newly committed item does not have to wait for the next alarm.
    if (flushPromise) return flushPromise.then(() => flush({ force, onlyId }));
    flushPromise = (async () => {
      // Bound work per wakeup below Chrome's fetch lifetime limit. Remaining
      // items are persisted and the alarm resumes them on the next wakeup.
      const attempted = new Set();
      const round=crypto.randomUUID();
      const startedAt = now();
      for (let count = 0; count < MAX_QUEUE && now() - startedAt < 15000; count++) {
        await mutations;
        const state = await read();
        if (!state.settings.token) break;
        const binding = await tokenIdentity(state.settings.token);
        const job = state.queue.find((item) => item.binding === binding && !attempted.has(item.client_id) &&
          (!onlyId || item.client_id === onlyId) && (force || (!PAUSED_ERRORS.has(item.errorKind) && item.nextAttemptAt <= now())));
        if (!job) break;
        attempted.add(job.client_id);
        try {
          const link = await client.upload(state.settings.token, job, patch=>update(current=>{
            const pending=current.queue.find(j=>j.client_id===job.client_id&&j.binding===binding);
            if(!pending)return;
            Object.assign(pending,patch,{errorKind:null,nextAttemptAt:0});
            if(patch.savedLink)current.lastResult={client_id:job.client_id,url:job.url,title:job.title,status:'media',linkId:patch.savedLink.id,at:now()};
          }),{round});
          if(link.media_pending){
            await update(current=>{if(current.queue.some(j=>j.client_id===job.client_id&&j.binding===binding))current.lastResult={client_id:job.client_id,url:job.url,title:job.title,status:'media',linkId:link.id,at:now()};});
            attempted.delete(job.client_id);
            continue;
          }
          if(job.collection_ids?.length){
            await update(current=>{const pending=current.queue.find(j=>j.client_id===job.client_id&&j.binding===binding);if(pending)pending.stage="collections";});
            await update(current=>{const pending=current.queue.find(j=>j.client_id===job.client_id&&j.binding===binding);if(pending)pending.savedLink=link;});
            for(let index=job.collectionIndex||0;index<job.collection_ids.length;index++){
              const id=job.collection_ids[index];let body=job.collectionOperations?.[id];
              if(!body || (force && job.errorKind==="revision_conflict")){
                const definitions=await client.collections(state.settings.token),c=definitions.find(c=>c.id===id&&!c.deleted&&!c.archived);
                if(!c)throw new CaptureError("collection_deleted");
                body={operation_key:uuid(),expected_revision:c.revision,type:"add",link_ids:[link.id]};
                await update(current=>{const pending=current.queue.find(j=>j.client_id===job.client_id&&j.binding===binding);if(pending)(pending.collectionOperations??={})[id]=body;});
              }
              await client.addCollection(state.settings.token,id,body);
              await update(current=>{const pending=current.queue.find(j=>j.client_id===job.client_id&&j.binding===binding);if(pending)pending.collectionIndex=index+1;});
            }
          }
          const finished=await update((current) => {
            if (!current.queue.some((item) => item.client_id === job.client_id && item.binding === binding)) return;
            current.queue = current.queue.filter((item) => item.client_id !== job.client_id);
            current.lastResult = { client_id: job.client_id, url: job.url, title: job.title, captured: Boolean(job.capture), action:link.capture_result?.action, imagesSaved:link.capture_result?.images_saved ?? job.capture?.images?.length ?? 0, mediaSaved:link.media_saved || 0, missingImages: job.capture?.missing_images || 0, truncated: Boolean(job.capture?.truncated), status: "uploaded", linkId: link.id, at: now() };
            return true;
          });
          try { if(finished)await onUploaded(job); } catch { /* Startup pruning retries local cleanup. */ }
        } catch (error) {
          const kind = error.kind ?? "network";
          await update((current) => {
            const pending = current.queue.find((item) => item.client_id === job.client_id && item.binding === binding);
            if (!pending) return;
            pending.attempts++;
            pending.errorKind = kind;
            if(error.stage)pending.stage=error.stage;
            if(error.origins)pending.requiredOrigins=error.origins;
            pending.nextAttemptAt = now() + Math.min(60 * 60 * 1000, 5000 * 2 ** Math.min(pending.attempts - 1, 10));
          });
          if (["invalid_token", "network", "timeout", "server"].includes(kind)) break;
        }
      }
      return snapshot();
    })().finally(() => { flushPromise = null; });
    return flushPromise;
  }

  async function remove(client_id) {
    await update((state) => {
      state.queue = state.queue.filter((job) => job.client_id !== client_id);
      if (state.lastResult?.client_id === client_id && state.lastResult.status === "queued") state.lastResult = null;
    });
    return snapshot();
  }

  async function collections(){await mutations;const state=await read();if(!state.settings.token)throw new CaptureError("not_configured");const binding=await tokenIdentity(state.settings.token);try{const items=await client.collections(state.settings.token);if((await read()).settings.token!==state.settings.token)throw new CaptureError("queue_connection");await update(current=>{current.collectionCatalog={binding,items,at:now()}});return {items,cached:false,binding};}catch(error){if(state.collectionCatalog?.binding===binding)return {items:state.collectionCatalog.items,cached:true,binding};throw error;}}
  return { snapshot, saveSettings, enqueue, flush, remove, collections, newId: uuid };
}
