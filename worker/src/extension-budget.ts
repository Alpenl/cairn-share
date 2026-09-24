import type { Env } from "./index";
import { canonicalJSON } from "./domain";

// Operator-owned ceiling for all extension operations in one Worker/D1
// deployment and UTC day. A caller may only request stricter limits. These
// bounds are not supplied by bookmark content or a model answer.
// Jev 1.13 reserves its documented 64k input ceiling per attempt (outputs are
// free). This is a reservation ceiling, never an observed-usage claim.
// https://docs.typesafe.ai/models (checked 2026-09-23).
export const EXTENSION_LIMITS = {
  max_calls_total: 20, max_calls_per_item: 2, max_tokens: 20 * 65536, max_tokens_per_item: 2 * 65536
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const fail = (error: string, status = 400) => reply({ error }, status);

// A reservation is an at-most-once grant, not a replayable permit. If its
// response is lost, a repeat returns granted:false. Keep the charge: whether
// an external service executed a request cannot be established by refunding a
// local timeout. The client must not automatically retry the external call.
export async function extensionBudgetRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/v2/extension-budget/reserve") return null;
  if (request.method !== "POST") return fail("method_not_allowed", 405);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return fail("invalid_content_type");
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 8192) return fail("request_too_large", 413);
    body = JSON.parse(raw);
  } catch { return fail("invalid_json"); }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).some(k => !["operation_key", "kind", "item_ids", "tokens", "limits"].includes(k))) return fail("invalid_reservation");
  const limits = body.limits as typeof EXTENSION_LIMITS;
  const ids = body.item_ids;
  if (typeof body.operation_key !== "string" || !/^[a-f0-9]{64}$/.test(body.operation_key) ||
    typeof body.kind !== "string" || !["entity", "rerank", "evidence"].includes(body.kind) ||
    !Array.isArray(ids) || ids.length < 1 || ids.length > 20 || new Set(ids).size !== ids.length ||
    ids.some(id => !Number.isSafeInteger(id) || id < 1) ||
    body.tokens !== (body.kind === "evidence" ? 0 : 65536) ||
    !limits || typeof limits !== "object" || Array.isArray(limits) || Object.keys(limits).length !== 4 ||
    Object.entries(EXTENSION_LIMITS).some(([k, max]) => {
      const value = limits[k as keyof typeof limits];
      return !Number.isSafeInteger(value) || value < 1 || value > max;
    })) return fail("invalid_reservation");
  const itemIDs = [...ids].sort((a, b) => a - b);
  const payload = canonicalJSON({ ...body, item_ids: itemIDs });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const payloadHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  const operationKey = `extension:${body.operation_key}`;
  const old = await env.DB.prepare("SELECT units FROM budget_ledger WHERE operation_key=?").bind(operationKey).first<{ units: string }>();
  if (old) return JSON.parse(old.units).payload_hash === payloadHash
    ? reply({ granted: false, reason: "already_reserved" }) : fail("operation_conflict", 409);
  const now = new Date();
  const start = now.toISOString().slice(0, 10) + "T00:00:00.000Z";
  const end = new Date(Date.parse(start) + 86400000).toISOString();
  const itemJSON = JSON.stringify(itemIDs);
  const units = canonicalJSON({ calls: 1, tokens: body.tokens, kind: body.kind, payload_hash: payloadHash });
  const bindings = [itemJSON, start, end];
  // All guards and charges share one transaction. In particular the global
  // row cannot be inserted if a candidate disappears or any item is exhausted.
  const insert = env.DB.prepare(`INSERT INTO budget_ledger(scope,link_id,units,operation_key,created_at)
    SELECT 'extension_global',NULL,?,?,? WHERE
      (SELECT COUNT(*) FROM links WHERE id IN (SELECT value FROM json_each(?)))=?
      AND (SELECT COUNT(*) FROM budget_ledger WHERE scope='extension_global' AND created_at>=? AND created_at<?) < ?
      AND (SELECT COALESCE(SUM(json_extract(units,'$.tokens')),0) FROM budget_ledger WHERE scope='extension_global' AND created_at>=? AND created_at<?)+? <= ?
      AND NOT EXISTS (SELECT 1 FROM json_each(?) item WHERE
        (SELECT COUNT(*) FROM budget_ledger WHERE scope='extension_item' AND link_id=item.value AND created_at>=? AND created_at<?) >= ?
        OR (SELECT COALESCE(SUM(json_extract(units,'$.tokens')),0) FROM budget_ledger WHERE scope='extension_item' AND link_id=item.value AND created_at>=? AND created_at<?)+? > ?)
    ON CONFLICT(operation_key) DO NOTHING`)
    .bind(units, operationKey, now.toISOString(), itemJSON, itemIDs.length,
      start, end, limits.max_calls_total, start, end, body.tokens, limits.max_tokens,
      ...bindings, limits.max_calls_per_item, start, end, body.tokens, limits.max_tokens_per_item);
  const itemCharge = env.DB.prepare(`INSERT INTO budget_ledger(scope,link_id,units,operation_key,created_at)
    SELECT 'extension_item',item.value,?,? || ':' || item.value,? FROM json_each(?) item
    WHERE EXISTS (SELECT 1 FROM budget_ledger WHERE operation_key=? AND json_extract(units,'$.payload_hash')=?)
    ON CONFLICT(operation_key) DO NOTHING`)
    .bind(units, operationKey, now.toISOString(), itemJSON, operationKey, payloadHash);
  const result = await env.DB.batch([insert, itemCharge]);
  const stored = await env.DB.prepare("SELECT units FROM budget_ledger WHERE operation_key=?").bind(operationKey).first<{ units: string }>();
  if (stored && JSON.parse(stored.units).payload_hash !== payloadHash) return fail("operation_conflict", 409);
  if (Number(result[0].meta.changes) === 1) return reply({ granted: true, reason: "reserved" });
  if (stored) return reply({ granted: false, reason: "already_reserved" });
  const count = await env.DB.prepare("SELECT COUNT(*) n FROM links WHERE id IN (SELECT value FROM json_each(?))").bind(itemJSON).first<number>("n");
  return count !== itemIDs.length ? fail("not_found", 404) : reply({ granted: false, reason: "budget_exhausted" });
}
