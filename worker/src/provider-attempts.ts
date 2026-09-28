import type { Env } from "./index";
import { canonicalJSON } from "./domain";

// Call-count reservations are the hard stop. Observed cost is recorded later,
// since xAI does not provide a pre-call price for a tool-using response.
export const PROVIDER_ATTEMPT_LIMITS = { daily_total: 500, daily_item: 10, daily_canary: 4 };
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const fail = (code: string, status = 400) => json({ error: code }, status);

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("invalid_content_type");
  }
  const reader = request.body?.getReader();
  if (!reader) return fail("invalid_json");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4096) { await reader.cancel(); return fail("request_too_large", 413); }
      parts.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : fail("invalid_json");
  } catch { return fail("invalid_json"); }
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Reserve = {
  operation_key: string; request_hash: string; model: string; stage: "fetch" | "reading" | "canary";
  variant: "fetch_thread" | "fetch_post" | "reading" | "canary";
  attempt_number: 1 | 2; link_id?: number; lease_token?: string; content_revision?: number;
  min_remaining_ms?: number;
};

function validReserve(value: Record<string, unknown>): value is Reserve {
  const common = ["operation_key", "request_hash", "model", "stage", "variant", "attempt_number"];
  const canary = value.stage === "canary";
  const keys = canary ? common : [...common, "link_id", "lease_token", "content_revision", "min_remaining_ms"];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) ||
      !hex(value.operation_key) || !hex(value.request_hash) ||
      typeof value.model !== "string" || value.model.length < 1 || value.model.length > 100 ||
      !/^[a-zA-Z0-9._-]+$/.test(value.model)) return false;
  if (canary) return value.variant === "canary" && value.attempt_number === 1;
  if (!Number.isSafeInteger(value.link_id) || Number(value.link_id) < 1 ||
      !Number.isSafeInteger(value.content_revision) || Number(value.content_revision) < 1 ||
      typeof value.lease_token !== "string" || value.lease_token.length < 1 || value.lease_token.length > 100 ||
      !Number.isSafeInteger(value.min_remaining_ms) || Number(value.min_remaining_ms) < 1 ||
      Number(value.min_remaining_ms) > 15 * 60 * 1000) return false;
  return (value.stage === "fetch" &&
      ((value.variant === "fetch_thread" && value.attempt_number === 1) ||
       (value.variant === "fetch_post" && value.attempt_number === 2))) ||
    (value.stage === "reading" && value.variant === "reading" && value.attempt_number === 1);
}

async function reserve(request: Request, env: Env): Promise<Response> {
  const value = await readBody(request);
  if (value instanceof Response) return value;
  if (!validReserve(value)) return fail("invalid_reservation");
  const payloadHash = await digest(canonicalJSON(value));
  const old = await env.DB.prepare("SELECT reservation_hash FROM enrichment_provider_attempts WHERE operation_key=?")
    .bind(value.operation_key).first<{ reservation_hash: string }>();
  if (old) return old.reservation_hash === payloadHash
    ? json({ granted: false, reason: "already_reserved" }) : fail("operation_conflict", 409);
  const now = new Date();
  const nowISO = now.toISOString();
  const start = nowISO.slice(0, 10) + "T00:00:00.000Z";
  const day = start.slice(0, 10);
  const end = new Date(Date.parse(start) + 86400000).toISOString();
  let result: D1Result;
  if (value.stage === "canary") {
    result = await env.DB.prepare(`INSERT INTO enrichment_provider_attempts
      (operation_key,stage,variant,attempt_number,request_hash,reservation_hash,model,created_at)
      SELECT ?,'canary','canary',1,?,?,?,?
      WHERE COALESCE((SELECT total FROM enrichment_provider_daily_usage WHERE day=?),0) < ?
        AND COALESCE((SELECT canary FROM enrichment_provider_daily_usage WHERE day=?),0) < ?
      ON CONFLICT(operation_key) DO NOTHING`)
      .bind(value.operation_key, value.request_hash, payloadHash, value.model, nowISO,
        day, PROVIDER_ATTEMPT_LIMITS.daily_total,
        day, PROVIDER_ATTEMPT_LIMITS.daily_canary).run();
  } else {
    const leaseHash = await digest(value.lease_token!);
    const deadline = new Date(now.getTime() + value.min_remaining_ms!).toISOString();
    result = await env.DB.prepare(`INSERT INTO enrichment_provider_attempts
      (operation_key,link_id,lease_hash,content_revision,stage,variant,attempt_number,
       request_hash,reservation_hash,model,created_at)
      SELECT ?,l.id,?,l.content_revision,?,?,?,?,?,?,?
      FROM links l WHERE l.id=? AND l.content_revision=?
        AND l.enrichment_status='processing' AND l.enrichment_lease_token=?
        AND l.enrichment_lease_until>=?
        AND l.enrichment_paid_stage=?
        AND COALESCE((SELECT total FROM enrichment_provider_daily_usage WHERE day=?),0) < ?
        AND (SELECT COUNT(*) FROM enrichment_provider_attempts WHERE link_id=l.id AND created_at>=? AND created_at<?) < ?
        AND ((?=1 AND l.enrichment_paid_uncertain=0
          AND NOT EXISTS (SELECT 1 FROM enrichment_provider_attempts a
          WHERE a.link_id=l.id AND a.lease_hash=? AND a.stage=?))
          OR (?=2 AND l.enrichment_paid_uncertain=1
          AND EXISTS (SELECT 1 FROM enrichment_provider_attempts a
          WHERE a.link_id=l.id AND a.lease_hash=? AND a.stage='fetch'
            AND a.attempt_number=1 AND a.state='responded' AND a.http_status=200
            AND a.fallback_authorized=1)
          AND NOT EXISTS (SELECT 1 FROM enrichment_provider_attempts a
            WHERE a.link_id=l.id AND a.lease_hash=? AND a.stage='fetch' AND a.attempt_number=2)))
      ON CONFLICT(operation_key) DO NOTHING`)
      .bind(value.operation_key, leaseHash, value.stage, value.variant, value.attempt_number,
        value.request_hash, payloadHash, value.model, nowISO,
        value.link_id, value.content_revision, value.lease_token, deadline, value.stage,
        day, PROVIDER_ATTEMPT_LIMITS.daily_total,
        start, end, PROVIDER_ATTEMPT_LIMITS.daily_item,
        value.attempt_number, leaseHash, value.stage,
        value.attempt_number, leaseHash, leaseHash).run();
  }
  // D1 includes the marker trigger's UPDATE in changes for link attempts.
  if (result.meta.changes > 0) return json({ granted: true, reason: "reserved" });
  const raced = await env.DB.prepare("SELECT reservation_hash FROM enrichment_provider_attempts WHERE operation_key=?")
    .bind(value.operation_key).first<{ reservation_hash: string }>();
  if (raced) return raced.reservation_hash === payloadHash
    ? json({ granted: false, reason: "already_reserved" }) : fail("operation_conflict", 409);
  const counts = await env.DB.prepare(`SELECT
    (SELECT total FROM enrichment_provider_daily_usage WHERE day=?) AS total,
    (SELECT canary FROM enrichment_provider_daily_usage WHERE day=?) AS canary,
    (SELECT COUNT(*) FROM enrichment_provider_attempts WHERE link_id=? AND created_at>=? AND created_at<?) AS item`)
    .bind(day, day, value.link_id ?? null, start, end)
    .first<{ total: number; canary: number; item: number }>();
  if (counts && ((counts.total ?? 0) >= PROVIDER_ATTEMPT_LIMITS.daily_total ||
      value.stage === "canary" && (counts.canary ?? 0) >= PROVIDER_ATTEMPT_LIMITS.daily_canary ||
      value.stage !== "canary" && counts.item >= PROVIDER_ATTEMPT_LIMITS.daily_item)) {
    return fail("budget_exhausted", 429);
  }
  return fail("lease_conflict", 409);
}

type Settle = { operation_key: string; http_status: number; response_id: string | null;
  input_tokens: number | null; output_tokens: number | null; total_tokens: number | null;
  x_search_calls: number | null; cost_usd_ticks: number | null };
function validSettle(value: Record<string, unknown>): value is Settle {
  const keys = ["operation_key", "http_status", "response_id", "input_tokens", "output_tokens",
    "total_tokens", "x_search_calls", "cost_usd_ticks"];
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)) &&
    hex(value.operation_key) && Number.isSafeInteger(value.http_status) &&
    Number(value.http_status) >= 100 && Number(value.http_status) <= 599 &&
    (value.response_id === null || (typeof value.response_id === "string" &&
      value.response_id.length <= 200 && /^[a-zA-Z0-9_-]+$/.test(value.response_id))) &&
    keys.slice(3).every((key) => value[key] === null || integer(value[key]));
}
async function settle(request: Request, env: Env): Promise<Response> {
  const value = await readBody(request);
  if (value instanceof Response) return value;
  if (!validSettle(value)) return fail("invalid_settlement");
  const settlementHash = await digest(canonicalJSON(value));
  const result = await env.DB.prepare(`UPDATE enrichment_provider_attempts SET
    state='responded',http_status=?,response_id=?,input_tokens=?,output_tokens=?,
    total_tokens=?,x_search_calls=?,cost_usd_ticks=?,settlement_hash=?,settled_at=?
    WHERE operation_key=? AND state='reserved'
      AND NOT EXISTS (SELECT 1 FROM enrichment_provider_reconciliations r
        WHERE r.operation_key=enrichment_provider_attempts.operation_key)`)
    .bind(value.http_status, value.response_id, value.input_tokens, value.output_tokens,
      value.total_tokens, value.x_search_calls, value.cost_usd_ticks, settlementHash,
      new Date().toISOString(), value.operation_key).run();
  if (result.meta.changes === 1) return json({ settled: true });
  const old = await env.DB.prepare("SELECT settlement_hash FROM enrichment_provider_attempts WHERE operation_key=?")
    .bind(value.operation_key).first<{ settlement_hash: string | null }>();
  if (!old) return fail("not_found", 404);
  return old.settlement_hash === settlementHash ? json({ settled: true }) : fail("operation_conflict", 409);
}

async function authorizeFallback(request: Request, env: Env): Promise<Response> {
  const value = await readBody(request);
  if (value instanceof Response) return value;
  if (Object.keys(value).length !== 1 || !hex(value.operation_key)) return fail("invalid_operation");
  const result = await env.DB.prepare(`UPDATE enrichment_provider_attempts SET fallback_authorized=1
    WHERE operation_key=? AND stage='fetch' AND attempt_number=1
      AND state='responded' AND http_status=200`)
    .bind(value.operation_key).run();
  return result.meta.changes === 1 ? json({ authorized: true }) : fail("attempt_not_eligible", 409);
}

// This is deliberately an operator-only decision, never a background retry.
// A missing response, elapsed time or provider GET failure is not evidence of
// non-billing. The audit row, queue transition and old permit remain durable.
async function reconcile(request: Request, env: Env): Promise<Response> {
  const value = await readBody(request);
  if (value instanceof Response) return value;
  const keys = ["operation_key", "verdict", "actor", "evidence_kind", "evidence_ref"];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) ||
      !hex(value.operation_key) || value.verdict !== "confirmed_not_billed" ||
      typeof value.actor !== "string" || !/^[A-Za-z0-9._@-]{3,80}$/.test(value.actor) ||
      (value.evidence_kind !== "provider_invoice" && value.evidence_kind !== "provider_support") ||
      typeof value.evidence_ref !== "string" || !/^[A-Za-z0-9._:/-]{8,120}$/.test(value.evidence_ref)) {
    return fail("invalid_reconciliation");
  }
  const requestHash = await digest(canonicalJSON(value));
  const prior = await env.DB.prepare(`SELECT request_hash FROM enrichment_provider_reconciliations
    WHERE operation_key=?`).bind(value.operation_key).first<{ request_hash: string }>();
  if (prior) return prior.request_hash === requestHash
    ? json({ reconciled: true, status: "pending" }) : fail("operation_conflict", 409);

  const attempt = await env.DB.prepare(`SELECT a.link_id,a.lease_hash,l.enrichment_lease_token
    FROM enrichment_provider_attempts a JOIN links l ON l.id=a.link_id
    WHERE a.operation_key=? AND a.state='reserved' AND a.link_id IS NOT NULL`)
    .bind(value.operation_key).first<{ link_id: number; lease_hash: string;
      enrichment_lease_token: string | null }>();
  if (!attempt?.enrichment_lease_token ||
      await digest(attempt.enrichment_lease_token) !== attempt.lease_hash) {
    return fail("attempt_not_eligible", 409);
  }
  const now = new Date().toISOString();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO enrichment_provider_reconciliations
        (operation_key,link_id,verdict,actor,evidence_kind,evidence_ref,request_hash,created_at)
        SELECT a.operation_key,l.id,'confirmed_not_billed',?,?,?,?,?
        FROM enrichment_provider_attempts a JOIN links l ON l.id=a.link_id
        WHERE a.operation_key=? AND a.state='reserved'
          AND a.content_revision=l.content_revision
          AND a.lease_hash=? AND l.enrichment_lease_token=?
          AND l.enrichment_status IN ('processing','failed','exhausted')
          AND l.enrichment_paid_uncertain=1
          AND l.enrichment_paid_stage=a.stage AND l.enrichment_lease_until<=?
          AND NOT EXISTS (SELECT 1 FROM enrichment_provider_reconciliations r
            WHERE r.operation_key=a.operation_key)
        RETURNING operation_key`)
        .bind(value.actor, value.evidence_kind, value.evidence_ref, requestHash, now,
          value.operation_key, attempt.lease_hash, attempt.enrichment_lease_token, now),
      env.DB.prepare(`UPDATE links SET enrichment_status='pending',enrichment_attempts=0,
        enrichment_paid_stage_started=0,enrichment_paid_uncertain=0,enrichment_paid_stage=NULL,
        enrichment_lease_token=NULL,enrichment_lease_until=NULL,enrichment_next_retry_at=NULL,
        enrichment_error=NULL,enrichment_updated_at=?
        WHERE id=? AND enrichment_lease_token=? AND enrichment_paid_uncertain=1
          AND EXISTS (SELECT 1 FROM enrichment_provider_reconciliations
            WHERE operation_key=? AND link_id=links.id)
        RETURNING id`)
        .bind(now, attempt.link_id, attempt.enrichment_lease_token, value.operation_key)
    ]);
    if (results[0].results.length === 1 && results[1].results.length === 1) {
      return json({ reconciled: true, status: "pending" });
    }
    // The two guarded statements share one D1 transaction. A missing insert
    // cannot authorize the UPDATE; a missing UPDATE must not create an audit.
    if (results[0].results.length || results[1].results.length) throw Error("incomplete reconciliation");
  } catch (cause) {
    const raced = await env.DB.prepare(`SELECT request_hash FROM enrichment_provider_reconciliations
      WHERE operation_key=?`).bind(value.operation_key).first<{ request_hash: string }>();
    if (raced) return raced.request_hash === requestHash
      ? json({ reconciled: true, status: "pending" }) : fail("operation_conflict", 409);
    throw cause;
  }
  return fail("attempt_not_eligible", 409);
}

async function list(env: Env, url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "reserved";
  const limit = Number(url.searchParams.get("limit") ?? "50");
  if (!(["reserved", "responded", "confirmed_not_billed", "all"].includes(state)) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return fail("invalid_query");
  }
  const rows = await env.DB.prepare(`SELECT a.operation_key,a.link_id,a.content_revision,a.stage,a.variant,
    a.attempt_number,a.model,CASE WHEN r.operation_key IS NULL THEN a.state
      ELSE 'confirmed_not_billed' END AS state,a.http_status,a.response_id,a.input_tokens,
    a.output_tokens,a.total_tokens,a.x_search_calls,a.cost_usd_ticks,a.created_at,a.settled_at,
    r.actor AS reconciled_by,r.evidence_kind,r.evidence_ref,r.created_at AS reconciled_at
    FROM enrichment_provider_attempts a LEFT JOIN enrichment_provider_reconciliations r
      ON r.operation_key=a.operation_key
    WHERE (?='all' OR (?='confirmed_not_billed' AND r.operation_key IS NOT NULL)
      OR (?=a.state AND r.operation_key IS NULL))
    ORDER BY a.created_at DESC LIMIT ?`).bind(state, state, state, limit).all();
  return json({ items: rows.results });
}

async function summary(env: Env): Promise<Response> {
  const now = new Date();
  const start = now.toISOString().slice(0, 10) + "T00:00:00.000Z";
  const [unknown, used] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count,MIN(created_at) AS oldest_at
      FROM enrichment_provider_attempts a WHERE a.state='reserved'
        AND NOT EXISTS (SELECT 1 FROM enrichment_provider_reconciliations r
          WHERE r.operation_key=a.operation_key)`)
      .first<{ count: number; oldest_at: string | null }>(),
    env.DB.prepare(`SELECT total,canary,fetch_first,fetch_fallback,reading
      FROM enrichment_provider_daily_usage WHERE day=?`)
      .bind(start.slice(0, 10)).first<{ total: number; canary: number; fetch_first: number;
        fetch_fallback: number; reading: number }>()
  ]);
  return json({ as_of: now.toISOString(), unknown: {
    count: unknown?.count ?? 0, oldest_at: unknown?.oldest_at ?? null,
    oldest_age_ms: unknown?.oldest_at ? Math.max(0, now.getTime() - Date.parse(unknown.oldest_at)) : null
  }, budget: { day: start.slice(0, 10), limits: PROVIDER_ATTEMPT_LIMITS,
    used: { total: used?.total ?? 0, canary: used?.canary ?? 0,
      fetch_first: used?.fetch_first ?? 0, fetch_fallback: used?.fetch_fallback ?? 0,
      reading: used?.reading ?? 0 } } });
}

export async function providerAttemptRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  const root = "/api/enrichment/provider-attempts";
  if (path !== root && !["reserve", "settle", "authorize-fallback", "summary", "reconcile"].some((part) => path === `${root}/${part}`)) {
    return null;
  }
  if (path === root) return request.method === "GET" ? list(env, new URL(request.url)) : fail("method_not_allowed", 405);
  if (path === `${root}/summary`) return request.method === "GET" ? summary(env) : fail("method_not_allowed", 405);
  if (request.method !== "POST") return fail("method_not_allowed", 405);
  if (path.endsWith("/reserve")) return reserve(request, env);
  if (path.endsWith("/settle")) return settle(request, env);
  if (path.endsWith("/reconcile")) return reconcile(request, env);
  return authorizeFallback(request, env);
}
