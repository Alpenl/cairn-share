import type { Env } from "./index";
import { record } from "./curation";
import { readBoundedJSON, readJSONObject } from "./json-body";
import { policyPreviewCapability as capability } from "./policy-preview";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", [capability]: "1" } });
const fail = (error: string, status = 409) => reply({ error }, status);
const keyOK = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(value);
const hashOK = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function executor(env: Env): URL | null {
  try {
    if (!env.CAIRN_POLICY_REPLAY_URL || !env.CAIRN_ENRICHER_TOKEN) return null;
    const url = new URL(env.CAIRN_POLICY_REPLAY_URL);
    if (url.username || url.password || url.search || url.hash ||
      url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) return null;
    return url;
  } catch { return null; }
}
function view(value: unknown): boolean {
  if (!record(value) || !["form", "use"].every(key => typeof value[key] === "string")) return false;
  return ["topics", "content_functions", "carriers", "affordances", "entities", "resource_kinds"].every(key =>
    key === "resource_kinds" && value[key] === undefined || Array.isArray(value[key]) && value[key].length <= 1000 && value[key].every(v => typeof v === "string"));
}

/** Only called after the existing App authentication check. The configured
 * executor receives its own private credential, never a caller's token/cookie. */
export async function appPolicyProxyRoute(request: Request, env: Env, rawID: string, action: "capabilities" | "preview" | "apply"): Promise<Response> {
  if (request.headers.get(capability) !== "1") return fail("capability_mismatch");
  const id = Number(rawID), query = new URL(request.url).searchParams;
  if (!Number.isSafeInteger(id) || id < 1 || String(id) !== rawID) return fail("invalid_id", 400);
  const get = request.method === "GET";
  if (get ? action === "apply" : request.method !== "POST" || action === "capabilities") return fail("method_not_allowed", 405);
  let key: string | undefined, hash: string | undefined, payload: string | undefined;
  if (get && action === "preview") {
    key = query.get("preview_key") ?? undefined;
    hash = query.get("preview_hash") ?? undefined;
    if (!keyOK(key) || hash !== undefined && !hashOK(hash) ||
      [...query.keys()].some(k => !["preview_key", "preview_hash"].includes(k) || query.getAll(k).length !== 1)) return fail("invalid_request", 400);
  } else if (query.size) return fail("invalid_request", 400);
  if (!get) {
    const body = await readJSONObject(request, 4096);
    const fields = action === "apply" ? "preview_hash,preview_key,version" : "preview_key,version";
    if (!body || Object.keys(body).sort().join(",") !== fields || body.version !== 1 || !keyOK(body.preview_key) ||
      action === "apply" && !hashOK(body.preview_hash)) return fail("invalid_request", 400);
    key = body.preview_key; hash = typeof body.preview_hash === "string" ? body.preview_hash : undefined; payload = JSON.stringify(body);
  }
  const target = executor(env);
  if (!target) return fail("policy_replay_unsupported", 501);
  if (!await env.DB.prepare("SELECT 1 FROM links WHERE id=?").bind(id).first()) return fail("not_found", 404);
  target.pathname = `${target.pathname.replace(/\/$/, "")}/api/app-policy/bookmarks/${id}/${action}`;
  target.search = get ? query.toString() : "";
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(target, { method: request.method, redirect: "manual", signal: controller.signal,
      headers: { Authorization: `Bearer ${env.CAIRN_ENRICHER_TOKEN}`, "Content-Type": "application/json", Accept: "application/json", [capability]: "1" },
      ...(payload === undefined ? {} : { body: payload }) });
    if (response.headers.get(capability) !== "1" || ![200, 400, 404, 409, 413, 501].includes(response.status)) {
      await response.body?.cancel();
      return fail("policy_executor_unavailable", 503);
    }
    const body = await readBoundedJSON(response, 256 << 10);
    if (!record(body)) return fail("policy_executor_unavailable", 503);
    if (response.status !== 200) return typeof body.error === "string" && /^[a-z][a-z0-9_]{0,99}$/.test(body.error)
      ? fail(body.error, response.status) : fail("policy_executor_unavailable", 503);
    if (body.version !== 1 || body.id !== id || body.model_calls !== 0 || "plan" in body || "review_hash" in body) return fail("receipt_unavailable", 503);
    if (action === "capabilities") {
      if (typeof body.supported !== "boolean" || typeof body.can_preview !== "boolean" || typeof body.can_apply !== "boolean" ||
        body.can_preview !== body.supported || body.can_apply && !body.can_preview || typeof body.policy_version !== "string" ||
        body.policy_version.length > 100 || body.supported && !body.policy_version) return fail("receipt_unavailable", 503);
      return reply(body);
    }
    if (body.preview_key !== key || !hashOK(body.preview_hash) || hash !== undefined && body.preview_hash !== hash ||
      !hashOK(body.policy_hash) || typeof body.policy_version !== "string" || !body.policy_version || body.policy_version.length > 100 ||
      !nonnegative(body.target_generation)) return fail("receipt_unavailable", 503);
    if (body.status === "applied") return nonnegative(body.decision_id) && body.decision_id > 0 && nonnegative(body.revision) && typeof body.replayed === "boolean"
      ? reply(body) : fail("receipt_unavailable", 503);
    if (action === "apply" || body.status !== "prepared" || !nonnegative(body.content_revision) || body.content_revision < 1 ||
      !nonnegative(body.personal_revision) || !view(body.before) || !view(body.after)) return fail("receipt_unavailable", 503);
    return reply(body);
  } catch { return fail("policy_executor_unavailable", 503);
  } finally { clearTimeout(timeout); }
}
