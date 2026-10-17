import type { Env } from "./index";
import type { WriteGuard } from "./domain-routes";
import { canonicalJSON, type EffectiveView } from "./domain";
import { record } from "./curation";
import { readJSONObject } from "./json-body";

export const policyPreviewCapability = "X-Cairn-App-Policy-Replay";
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", [policyPreviewCapability]: "1" } });
const fail = (error: string, status = 409) => reply({ error }, status);
const keyOK = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(v);
const hashOK = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const storageKey = (key: string) => `app-policy-preview:${key}`;
const applyKey = (id: number, key: string, hash: string) => `app-policy:${id}:${key}:${hash}`;
const planFields = ["run_ids", "policy_version", "policy", "policy_hash", "automatic", "expected_revision", "content_revision",
  "spec_id", "spec_hash", "requested_model", "resolved_model", "expected_target_generation"].sort().join(",");
type Stored = { link_id: number; payload_hash: string; status: string; response: string };
export type PreparedPolicyPreview = { key: string; hash: string; plan: Record<string, unknown> };
type Submit = (request: Request, preview?: PreparedPolicyPreview, approvedReviewHash?: string) => Promise<Response>;

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(value)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function stored(env: Env, key: string): Promise<Stored | null> {
  return env.DB.prepare("SELECT link_id,payload_hash,status,response FROM classification_operations WHERE operation_key=?")
    .bind(storageKey(key)).first<Stored>();
}
async function decode(value: Stored, id: number, key: string, hash?: string): Promise<Record<string, unknown> | Response> {
  if (value.link_id !== id || value.status !== "app_policy_preview" || hash !== undefined && value.payload_hash !== hash) return fail("operation_conflict");
  try {
    const body = JSON.parse(value.response);
    if (!record(body) || body.version !== 1 || body.id !== id || body.preview_key !== key || body.preview_hash !== value.payload_hash ||
      !record(body.plan) || !hashOK(body.review_hash) || body.plan.operation_key !== applyKey(id, key, value.payload_hash)) return fail("preview_unavailable", 503);
    const { operation_key: ignored, ...plan } = body.plan;
    void ignored;
    if (await digest({ version: 1, id, preview_key: key, plan }) !== value.payload_hash) return fail("preview_unavailable", 503);
    return body;
  } catch { return fail("preview_unavailable", 503); }
}
/** The decision key itself binds the complete approved preview hash. Receipt
 * confirmation therefore survives source, policy, human and preview changes. */
async function receipt(env: Env, id: number, key: string, hash: string): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(`SELECT id,expected_personal_revision,policy_version,policy_hash,replay_target_generation
    FROM classification_decisions WHERE link_id=? AND operation_key=? AND policy_hash IS NOT NULL`)
    .bind(id, applyKey(id, key, hash)).first<{ id: number; expected_personal_revision: number; policy_version: string;
      policy_hash: string; replay_target_generation: number }>();
  return row ? { version: 1, id, preview_key: key, preview_hash: hash, status: "applied", decision_id: row.id,
    revision: row.expected_personal_revision, policy_version: row.policy_version, policy_hash: row.policy_hash,
    target_generation: row.replay_target_generation, replayed: true, model_calls: 0 } : null;
}

/** Internal-only durable preparation. The Go executor supplies the plan; an
 * App never supplies policy/spec/model/automatic data to this route. */
export async function policyPreviewRoute(request: Request, env: Env, id: number, submit: Submit): Promise<Response> {
  if (request.headers.get(policyPreviewCapability) !== "1") return fail("capability_mismatch");
  if (!Number.isSafeInteger(id) || id < 1) return fail("invalid_request", 400);
  const url = new URL(request.url);
  if (request.method === "GET") {
    const key = url.searchParams.get("preview_key"), hash = url.searchParams.get("preview_hash");
    if (!keyOK(key) || hash !== null && !hashOK(hash) || [...url.searchParams.keys()].some(k => !["preview_key", "preview_hash"].includes(k)) ||
      [...url.searchParams.keys()].some(k => url.searchParams.getAll(k).length !== 1)) return fail("invalid_request", 400);
    if (hash !== null) { const applied = await receipt(env, id, key, hash); if (applied) return reply(applied); }
    const value = await stored(env, key);
    if (value) {
      const body = await decode(value, id, key, hash ?? undefined);
      if (body instanceof Response) return body;
      const applied = await receipt(env, id, key, value.payload_hash);
      return reply(applied ?? body);
    }
    if (!await env.DB.prepare("SELECT 1 FROM links WHERE id=?").bind(id).first()) return fail("not_found", 404);
    return fail("preview_not_found", 404);
  }
  if (request.method !== "POST") return fail("method_not_allowed", 405);
  const body = await readJSONObject(request, 128 << 10);
  if (url.search || !body || Object.keys(body).sort().join(",") !== "plan,preview_key,version" ||
    body.version !== 1 || !keyOK(body.preview_key) || !record(body.plan) || Object.keys(body.plan).sort().join(",") !== planFields) return fail("invalid_preview", 400);
  const hash = await digest({ version: 1, id, preview_key: body.preview_key, plan: body.plan });
  const old = await stored(env, body.preview_key);
  if (old) {
    const saved = await decode(old, id, body.preview_key, hash);
    return saved instanceof Response ? saved : reply(await receipt(env, id, body.preview_key, hash) ?? saved);
  }
  const preview = { key: body.preview_key, hash, plan: { ...body.plan, operation_key: applyKey(id, body.preview_key, hash) } };
  const applied = await receipt(env, id, preview.key, hash);
  if (applied) return reply(applied);
  return submit(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(preview.plan) }), preview);
}

/** Uses the decision's full existing source/run/spec/target/human guard. This
 * only inserts an immutable preview; no decision, queue or projection writes. */
export async function persistPolicyPreview(env: Env, id: number, preview: PreparedPolicyPreview, before: EffectiveView,
  after: EffectiveView, reviewHash: string, guard: WriteGuard): Promise<Response> {
  const body = { version: 1, id, preview_key: preview.key, preview_hash: preview.hash, status: "prepared", model_calls: 0,
    content_revision: preview.plan.content_revision, personal_revision: preview.plan.expected_revision,
    target_generation: preview.plan.expected_target_generation, policy_version: preview.plan.policy_version,
    policy_hash: preview.plan.policy_hash, before, after, review_hash: reviewHash, plan: preview.plan };
  const result = await env.DB.prepare(`INSERT INTO classification_operations(operation_key,link_id,payload_hash,status,response,created_at)
    SELECT ?,?,?,'app_policy_preview',?,? WHERE ${guard.sql}
    ON CONFLICT(operation_key) DO NOTHING RETURNING operation_key`)
    .bind(storageKey(preview.key), id, preview.hash, JSON.stringify(body), new Date().toISOString(), ...guard.bindings).all();
  if (result.results.length) return reply(body);
  const old = await stored(env, preview.key);
  if (old) { const saved = await decode(old, id, preview.key, preview.hash); return saved instanceof Response ? saved : reply(saved); }
  return fail("state_conflict");
}

/** Applying always loads the immutable, internally prepared body. A matching
 * decision is acknowledged before checking any mutable state or fetching runs. */
export async function applyPolicyPreviewRoute(request: Request, env: Env, id: number, submit: Submit): Promise<Response> {
  if (request.headers.get(policyPreviewCapability) !== "1") return fail("capability_mismatch");
  if (request.method !== "POST") return fail("method_not_allowed", 405);
  const body = await readJSONObject(request, 4096);
  if (!Number.isSafeInteger(id) || id < 1 || new URL(request.url).search || !body || body.version !== 1 ||
    Object.keys(body).sort().join(",") !== "preview_hash,preview_key,version" || !keyOK(body.preview_key) || !hashOK(body.preview_hash)) return fail("invalid_request", 400);
  const applied = await receipt(env, id, body.preview_key, body.preview_hash);
  if (applied) return reply(applied);
  const value = await stored(env, body.preview_key);
  if (!value) {
    const exists = await env.DB.prepare("SELECT 1 FROM links WHERE id=?").bind(id).first();
    return fail(exists ? "preview_unavailable" : "not_found", exists ? 503 : 404);
  }
  const prepared = await decode(value, id, body.preview_key, body.preview_hash);
  if (prepared instanceof Response) return prepared;
  const response = await submit(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(prepared.plan) }),
    undefined, String(prepared.review_hash));
  if (response.status !== 200) return response;
  // Only a stored decision proves success, even if a handler returned 200.
  const confirmed = await receipt(env, id, body.preview_key, body.preview_hash);
  if (!confirmed) return fail("receipt_unavailable", 503);
  return reply({ ...confirmed, replayed: (await response.json() as { replayed?: boolean }).replayed === true });
}
