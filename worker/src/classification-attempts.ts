import type { Env } from "./index";
import { canonicalJSON } from "./domain";
import { readJSONObject } from "./json-body";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Cairn-Classification-Attempts": "1" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const fail = (error: string, status = 400) => reply({ error }, status);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const keys = ["operation_key", "link_id", "lease_token", "revision", "input_revision", "target_generation", "spec_id",
  "content_revision", "evidence_snapshot_id", "evidence_hash", "calls"];
const callKeys = ["reservation_key", "error_class", "request_hash", "state_hash", "question_ids", "requested_model",
  "resolved_model", "usage", "usage_missing", "http_status", "latency_ms"];
const errors = new Set(["timeout", "network", "canceled", "rate_limit", "auth", "provider_5xx", "provider_4xx", "invalid_response", "contract_fault", "unknown", "none"]);
async function hash(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(value)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// A receipt describes an already reserved actual attempt. It can arrive after
// its lease expires; it never grants budget, completes a job, or changes tags.
export async function classificationAttemptsRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/v2/classification-attempts") return null;
  if (request.headers.get("X-Cairn-Classification-Attempts") !== "1") return fail("capability_mismatch", 409);
  if (request.method !== "POST") return fail("method_not_allowed", 405);
  const body = await readJSONObject(request, 64 << 10);
  if (!body || Object.keys(body).some(k => !keys.includes(k)) || keys.some(k => !(k in body)) ||
    typeof body.operation_key !== "string" || !body.operation_key || body.operation_key.length > 200 ||
    typeof body.lease_token !== "string" || !body.lease_token || body.lease_token.length > 100 ||
    typeof body.spec_id !== "string" || !body.spec_id || body.spec_id.length > 100 || !hex(body.evidence_hash) ||
    !["link_id", "revision", "input_revision", "content_revision", "evidence_snapshot_id"].every(k => Number.isSafeInteger(body[k]) && Number(body[k]) > 0) ||
    !Number.isSafeInteger(body.target_generation) || Number(body.target_generation) < 0 ||
    !Array.isArray(body.calls) || body.calls.length < 1 || body.calls.length > 32) return fail("invalid_attempts");
  const calls: Record<string, unknown>[] = [];
  for (const value of body.calls) {
    if (!object(value) || Object.keys(value).some(k => !callKeys.includes(k)) || !hex(value.reservation_key) ||
      !hex(value.request_hash) || !hex(value.state_hash) || typeof value.requested_model !== "string" || !value.requested_model || value.requested_model.length > 200 ||
      (value.resolved_model !== undefined && (typeof value.resolved_model !== "string" || value.resolved_model.length > 200)) ||
      (value.error_class !== undefined && !errors.has(String(value.error_class))) ||
      typeof value.usage_missing !== "boolean" || !Number.isSafeInteger(value.http_status) || Number(value.http_status) < 0 || Number(value.http_status) > 599 ||
      !Number.isSafeInteger(value.latency_ms) || Number(value.latency_ms) < 0 || Number(value.latency_ms) > 86_400_000 ||
      !Array.isArray(value.question_ids) || !value.question_ids.length || value.question_ids.length > 64 ||
      !value.question_ids.every(id => typeof id === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(id)) ||
      new Set(value.question_ids).size !== value.question_ids.length) return fail("invalid_attempts");
    const usage = value.usage;
    if (value.usage_missing ? usage !== undefined && usage !== null :
      !object(usage) || Object.keys(usage).some(k => !["input_tokens", "output_tokens"].includes(k)) ||
      !["input_tokens", "output_tokens"].every(k => Number.isSafeInteger(usage[k]) && Number(usage[k]) >= 0)) return fail("invalid_attempts");
    calls.push(value);
  }
  if (new Set(calls.map(c => c.reservation_key)).size !== calls.length) return fail("invalid_attempts");
  const payloadHash = await hash(body), key = body.operation_key;
  const stored = () => env.DB.prepare("SELECT link_id,payload_hash FROM classification_attempt_operations WHERE operation_key=?")
    .bind(key).first<{ link_id: number; payload_hash: string }>();
  const acknowledge = async (row: { link_id: number; payload_hash: string }, replayed: boolean) => {
    if (row.link_id !== body.link_id || row.payload_hash !== payloadHash) return fail("operation_conflict", 409);
    const ids = await env.DB.prepare("SELECT id FROM classification_provider_attempts WHERE operation_key=? ORDER BY id")
      .bind(key).all<{ id: number }>();
    return reply({ stored: true, replayed, operation_key: key, attempt_ids: ids.results.map(r => r.id) });
  };
  const old = await stored(); if (old) return acknowledge(old, true);
  const reservations = await env.DB.prepare(`SELECT reservation_key,identity,payload_hash FROM classification_reservations
    WHERE link_id=? AND reservation_key IN (SELECT value FROM json_each(?))`)
    .bind(body.link_id, JSON.stringify(calls.map(c => c.reservation_key))).all<{ reservation_key: string; identity: string; payload_hash: string }>();
  if (reservations.results.length !== calls.length) return fail("unreserved_attempt", 409);
  for (const call of calls) {
    const row = reservations.results.find(r => r.reservation_key === call.reservation_key)!;
    const identity = JSON.parse(row.identity) as Record<string, unknown>;
    if (["link_id", "lease_token", "revision", "input_revision", "target_generation", "spec_id", "content_revision", "evidence_snapshot_id", "evidence_hash"]
      .some(k => identity[k] !== body[k]) || identity.model !== call.requested_model || identity.request_hash !== call.request_hash) return fail("reservation_mismatch", 409);
  }
  const spec = await env.DB.prepare("SELECT payload FROM question_specs WHERE spec_id=?").bind(body.spec_id).first<string>("payload");
  if (!spec) return fail("unknown_spec", 409);
  const questions = (JSON.parse(spec) as { questions: Array<{ id: string }> }).questions;
  if (!Array.isArray(questions) || calls.some(c => (c.question_ids as string[]).some(id => !questions.some(q => q.id === id)))) return fail("invalid_attempt_questions");
  const guard = `EXISTS(SELECT 1 FROM links WHERE id=?) AND
    (SELECT COUNT(*) FROM classification_reservations r JOIN json_each(?) p ON r.reservation_key=json_extract(p.value,'$.reservation_key')
      WHERE r.link_id=? AND r.payload_hash=json_extract(p.value,'$.payload_hash'))=?
    AND NOT EXISTS(SELECT 1 FROM classification_provider_attempts WHERE reservation_key IN (SELECT value FROM json_each(?)))`;
  const pinned = JSON.stringify(reservations.results.map(r => ({ reservation_key: r.reservation_key, payload_hash: r.payload_hash })));
  const binds = [body.link_id, pinned, body.link_id, calls.length, JSON.stringify(calls.map(c => c.reservation_key))] as Array<string | number>;
  const now = new Date().toISOString();
  const statements = [env.DB.prepare(`INSERT INTO classification_attempt_operations(operation_key,link_id,payload_hash,created_at)
    SELECT ?,?,?,? WHERE ${guard} ON CONFLICT(operation_key) DO NOTHING`).bind(key, body.link_id, payloadHash, now, ...binds)];
  for (const call of calls) statements.push(env.DB.prepare(`INSERT INTO classification_provider_attempts(link_id,operation_key,reservation_key,call_json,created_at)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM classification_attempt_operations WHERE operation_key=? AND payload_hash=?)
    ON CONFLICT(reservation_key) DO NOTHING`).bind(body.link_id, key, call.reservation_key, canonicalJSON(call), now, key, payloadHash));
  try { await env.DB.batch(statements); } catch (cause) { const receipt = await stored(); if (receipt) return acknowledge(receipt, true); throw cause; }
  const receipt = await stored();
  return receipt ? acknowledge(receipt, false) : fail("attempt_conflict", 409);
}
