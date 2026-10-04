import { API_BASE, CaptureError } from "./config.mjs";

export function createClient({ fetchImpl = fetch, apiBase = API_BASE, timeoutMs = 10000 } = {}) {
  async function request(token, path, body) {
    if (!token) throw new CaptureError("not_configured");
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${apiBase}${path}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
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
        const kind = ["invalid_url", "invalid_note", "invalid_client_id", "invalid_capture", "capture_conflict", "capture_deleted"].includes(data?.error) ? data.error : "response";
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
    async upload(token, job) {
      const data = await request(token, job.capture ? "/api/captures" : "/api/links", { url: job.url, note: job.note, client_id: job.client_id, ...(job.capture ? {capture:job.capture} : {}) });
      if (!Number.isSafeInteger(data?.id) || data.id < 1 || data.url !== job.url || data.note !== job.note) {
        throw new CaptureError("response");
      }
      return data;
    }
  };
}
