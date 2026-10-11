import type { Env } from "./index";
import type { ProviderRecoveryEvent, WorkerBusinessEvent } from "./observability";
import { canonicalJSON, contentHash, objectivePayload, type EvidenceSnapshot } from "./domain";
import { validEnrichmentSource } from "./source-validation";

// Call-count reservations are the hard stop. Observed cost is recorded later,
// since xAI does not provide a pre-call price for a tool-using response.
export const PROVIDER_ATTEMPT_LIMITS = { daily_total: 500, daily_item: 10, canary_min_interval_seconds: 60 };
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const fail = (code: string, status = 400) => json({ error: code }, status);
type AttemptEvent = Extract<WorkerBusinessEvent, { kind: "provider_attempt" }>;

export async function readBody(request: Request, maxBytes = 4096): Promise<Record<string, unknown> | Response> {
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
      if (length > maxBytes) { await reader.cancel(); return fail("request_too_large", 413); }
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

async function reserve(request: Request, env: Env,
  onResolved: (event: AttemptEvent) => void): Promise<Response> {
  const value = await readBody(request);
  if (value instanceof Response) return value;
  if (!validReserve(value)) return fail("invalid_reservation");
  // Never issue a new source-fetch permit, even to a legacy consumer. Settlement
  // and recovery of historical attempts remain available for accounting.
  if (value.stage === "fetch") return fail("capture_required", 410);
  const payloadHash = await digest(canonicalJSON(value));
  const old = await env.DB.prepare("SELECT reservation_hash FROM enrichment_provider_attempts WHERE operation_key=?")
    .bind(value.operation_key).first<{ reservation_hash: string }>();
  if (old) {
    if (old.reservation_hash === payloadHash) {
      onResolved({ kind: "provider_attempt", action: "reserve", stage: value.stage,
        outcome: "already_reserved", status: 200 });
      return json({ granted: false, reason: "already_reserved" });
    }
    onResolved({ kind: "provider_attempt", action: "reserve", stage: value.stage,
      outcome: "rejected", status: 409, reason: "operation_conflict" });
    return fail("operation_conflict", 409);
  }
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
        AND NOT EXISTS (SELECT 1 FROM enrichment_provider_attempts WHERE stage='canary' AND created_at>?)
      ON CONFLICT(operation_key) DO NOTHING`)
      .bind(value.operation_key, value.request_hash, payloadHash, value.model, nowISO,
        day, PROVIDER_ATTEMPT_LIMITS.daily_total,
        new Date(now.getTime() - 60_000).toISOString()).run();
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
        AND EXISTS(SELECT 1 FROM enrichment_component_gates g
          WHERE g.component=? AND (g.state='closed' OR (g.state='probing'
            AND g.probe_token=l.enrichment_lease_token AND g.probe_until>?)))
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
        "reading", nowISO,
        day, PROVIDER_ATTEMPT_LIMITS.daily_total,
        start, end, PROVIDER_ATTEMPT_LIMITS.daily_item,
        value.attempt_number, leaseHash, value.stage,
        value.attempt_number, leaseHash, leaseHash).run();
  }
  // D1 includes the marker trigger's UPDATE in changes for link attempts.
  if (result.meta.changes > 0) {
    onResolved({ kind: "provider_attempt", action: "reserve", stage: value.stage,
      outcome: "reserved", status: 200 });
    return json({ granted: true, reason: "reserved" });
  }
  const raced = await env.DB.prepare("SELECT reservation_hash FROM enrichment_provider_attempts WHERE operation_key=?")
    .bind(value.operation_key).first<{ reservation_hash: string }>();
  if (raced) {
    if (raced.reservation_hash === payloadHash) {
      onResolved({ kind: "provider_attempt", action: "reserve", stage: value.stage,
        outcome: "already_reserved", status: 200 });
      return json({ granted: false, reason: "already_reserved" });
    }
    onResolved({ kind: "provider_attempt", action: "reserve", stage: value.stage,
      outcome: "rejected", status: 409, reason: "operation_conflict" });
    return fail("operation_conflict", 409);
  }
  const counts = await env.DB.prepare(`SELECT
    (SELECT total FROM enrichment_provider_daily_usage WHERE day=?) AS total,
    (SELECT canary FROM enrichment_provider_daily_usage WHERE day=?) AS canary,
    (SELECT COUNT(*) FROM enrichment_provider_attempts WHERE link_id=? AND created_at>=? AND created_at<?) AS item`)
    .bind(day, day, value.link_id ?? null, start, end)
    .first<{ total: number; canary: number; item: number }>();
  if (counts && ((counts.total ?? 0) >= PROVIDER_ATTEMPT_LIMITS.daily_total ||
      value.stage !== "canary" && counts.item >= PROVIDER_ATTEMPT_LIMITS.daily_item)) {
    onResolved({ kind: "provider_attempt", action: "reserve", stage: value.stage,
      outcome: "rejected", status: 429, reason: "budget_exhausted" });
    return fail("budget_exhausted", 429);
  }
  if (value.stage === "canary") {
    const response = fail("canary_cooldown", 429);
    response.headers.set("Retry-After", "60");
    return response;
  }
  {
    const gate = await env.DB.prepare(`SELECT state,probe_token,probe_until,retry_at
      FROM enrichment_component_gates WHERE component=?`)
      .bind("reading")
      .first<{ state: string; probe_token: string | null; probe_until: string | null; retry_at: string | null }>();
    if (gate && gate.state !== "closed" &&
        !(gate.state === "probing" && gate.probe_token === value.lease_token &&
          gate.probe_until && gate.probe_until > nowISO)) {
      onResolved({ kind: "provider_attempt", action: "reserve", stage: value.stage,
        outcome: "rejected", status: 503, reason: "component_paused" });
      const response = fail("component_paused", 503);
      const until = gate.state === "open" ? gate.retry_at : gate.probe_until;
      const delay = until ? Math.max(0, Date.parse(until) - Date.now()) : 0;
      if (delay > 0) response.headers.set("Retry-After", String(Math.ceil(delay / 1000)));
      return response;
    }
  }
  onResolved({ kind: "provider_attempt", action: "reserve", stage: value.stage,
    outcome: "rejected", status: 409, reason: "lease_conflict" });
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
async function settle(request: Request, env: Env,
  onResolved: (event: AttemptEvent) => void): Promise<Response> {
  const value = await readBody(request);
  if (value instanceof Response) return value;
  if (!validSettle(value)) return fail("invalid_settlement");
  const settlementHash = await digest(canonicalJSON(value));
  const result = await env.DB.prepare(`UPDATE enrichment_provider_attempts SET
    state='responded',http_status=?,response_id=?,input_tokens=?,output_tokens=?,
    total_tokens=?,x_search_calls=?,cost_usd_ticks=?,settlement_hash=?,settled_at=?
    WHERE operation_key=? AND state='reserved'
      AND NOT EXISTS (SELECT 1 FROM enrichment_provider_reconciliations r
        WHERE r.operation_key=enrichment_provider_attempts.operation_key)
    RETURNING stage`)
    .bind(value.http_status, value.response_id, value.input_tokens, value.output_tokens,
      value.total_tokens, value.x_search_calls, value.cost_usd_ticks, settlementHash,
      new Date().toISOString(), value.operation_key).run();
  const updated = result.results[0] as { stage: "fetch" | "reading" | "canary" } | undefined;
  if (updated) {
    onResolved({ kind: "provider_attempt", action: "settle", stage: updated.stage,
      outcome: "responded", status: 200, provider_status: value.http_status,
      response_id_present: value.response_id !== null });
    return json({ settled: true });
  }
  const old = await env.DB.prepare("SELECT settlement_hash,stage FROM enrichment_provider_attempts WHERE operation_key=?")
    .bind(value.operation_key).first<{ settlement_hash: string | null;
      stage: "fetch" | "reading" | "canary" }>();
  if (!old) return fail("not_found", 404);
  if (old.settlement_hash === settlementHash) {
    onResolved({ kind: "provider_attempt", action: "settle", stage: old.stage,
      outcome: "replay", status: 200, provider_status: value.http_status,
      response_id_present: value.response_id !== null });
    return json({ settled: true });
  }
  onResolved({ kind: "provider_attempt", action: "settle", stage: old.stage,
    outcome: "rejected", status: 409, reason: "operation_conflict" });
  return fail("operation_conflict", 409);
}

async function authorizeFallback(_request: Request, _env: Env,
  _onResolved: (event: AttemptEvent) => void): Promise<Response> {
  return fail("capture_required", 410);
}

async function reconcile(request: Request, env: Env,
  onResolved: (event: AttemptEvent) => void): Promise<Response> {
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
  const readReceipt = () => env.DB.prepare(`SELECT r.request_hash,a.stage
    FROM enrichment_provider_reconciliations r JOIN enrichment_provider_attempts a
      ON a.operation_key=r.operation_key WHERE r.operation_key=?`).bind(value.operation_key)
    .first<{ request_hash: string; stage: "fetch" | "reading" }>();
  const prior = await readReceipt();
  if (prior) {
    if (prior.request_hash !== requestHash) return fail("operation_conflict", 409);
    onResolved({ kind: "provider_attempt", action: "reconcile", stage: prior.stage,
      outcome: "replay", status: 200 });
    return json({ reconciled: true, status: "pending" });
  }

  const attempt = await env.DB.prepare(`SELECT a.link_id,a.lease_hash,a.stage,l.enrichment_lease_token
    FROM enrichment_provider_attempts a JOIN links l ON l.id=a.link_id
    WHERE a.operation_key=? AND a.state='reserved' AND a.link_id IS NOT NULL`)
    .bind(value.operation_key).first<{ link_id: number; lease_hash: string;
      stage: "fetch" | "reading"; enrichment_lease_token: string | null }>();
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
      onResolved({ kind: "provider_attempt", action: "reconcile", stage: attempt.stage,
        outcome: "confirmed_not_billed", status: 200 });
      return json({ reconciled: true, status: "pending" });
    }
    // The two guarded statements share one D1 transaction. A missing insert
    // cannot authorize the UPDATE; a missing UPDATE must not create an audit.
    if (results[0].results.length || results[1].results.length) throw Error("incomplete reconciliation");
  } catch (cause) {
    const raced = await readReceipt();
    if (raced) {
      if (raced.request_hash !== requestHash) return fail("operation_conflict", 409);
      onResolved({ kind: "provider_attempt", action: "reconcile", stage: raced.stage,
        outcome: "replay", status: 200 });
      return json({ reconciled: true, status: "pending" });
    }
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

// An operator can inspect one exact permit before querying a stored provider
// response. Do not expose the prompt hash, lease hash or source bytes. A
// reserved row without a response ID remains unassociated with any provider
// response until independent evidence identifies it.
async function inspect(env: Env, url: URL): Promise<Response> {
  if (url.searchParams.size !== 1 || !hex(url.searchParams.get("operation_key"))) {
    return fail("invalid_query");
  }
  const row = await env.DB.prepare(`SELECT a.operation_key,a.link_id,a.content_revision,a.stage,a.variant,
    a.attempt_number,a.model,CASE WHEN r.operation_key IS NULL THEN a.state
      ELSE 'confirmed_not_billed' END AS state,a.response_id,a.http_status,a.created_at,a.settled_at,
    a.input_tokens,a.output_tokens,a.total_tokens,a.x_search_calls,a.cost_usd_ticks,
    l.content_revision AS current_content_revision,
    l.enrichment_paid_uncertain AS current_paid_unresolved,
    r.evidence_kind,r.created_at AS reconciled_at
    FROM enrichment_provider_attempts a LEFT JOIN links l ON l.id=a.link_id
    LEFT JOIN enrichment_provider_reconciliations r ON r.operation_key=a.operation_key
    WHERE a.operation_key=?`).bind(url.searchParams.get("operation_key")).first();
  return row ? json({ attempt: row }) : fail("not_found", 404);
}

// A provider GET and its decoded source are checked by the operator-side Go
// command. The Worker accepts only a response ID already bound to this exact
// settled permit; the migration trigger fences the expired original lease and
// commits source, evidence, queue transition and audit in one SQLite statement.
async function recoverSource(request: Request, env: Env,
  onResolved: (outcome: "committed" | "replay") => void): Promise<Response> {
  const value = await readBody(request, 256 * 1024);
  if (value instanceof Response) return value;
  const keys = ["operation_key", "response_id", "actor", "source"];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) ||
      !hex(value.operation_key) || typeof value.response_id !== "string" ||
      value.response_id.length < 1 || value.response_id.length > 200 ||
      !/^[A-Za-z0-9_-]+$/.test(value.response_id) ||
      typeof value.actor !== "string" || !/^[A-Za-z0-9._@-]{3,80}$/.test(value.actor) ||
      !validEnrichmentSource(value.source) || !value.source.original_language.trim()) {
    return fail("invalid_recovery");
  }
  const source = value.source;
  const payloadHash = await digest(canonicalJSON({ response_id: value.response_id, source }));
  const readReceipt = () => env.DB.prepare(`SELECT payload_hash,response
    FROM enrichment_provider_source_recoveries WHERE operation_key=?`)
    .bind(value.operation_key).first<{ payload_hash: string; response: string }>();
  const replay = (row: { payload_hash: string; response: string } | null) => row
    ? row.payload_hash === payloadHash ? json(JSON.parse(row.response)) : fail("operation_conflict", 409)
    : null;
  const prior = replay(await readReceipt());
  if (prior) {
    if (prior.status === 200) onResolved("replay");
    return prior;
  }

  const owner = await env.DB.prepare(`SELECT a.lease_hash,l.enrichment_lease_token
    FROM enrichment_provider_attempts a JOIN links l ON l.id=a.link_id
    WHERE a.operation_key=?`).bind(value.operation_key)
    .first<{ lease_hash: string | null; enrichment_lease_token: string | null }>();
  if (!owner?.lease_hash || !owner.enrichment_lease_token ||
      await digest(owner.enrichment_lease_token) !== owner.lease_hash) {
    return fail("attempt_not_eligible", 409);
  }

  const now = new Date().toISOString();
  const blocks: EvidenceSnapshot["blocks"] = [
    { id: "primary-1", role: "primary", text: source.original_text, acquired: "fetch" }
  ];
  if (source.context_text.trim()) {
    blocks.push({ id: "context-1", role: "legacy_unknown", text: source.context_text,
      relation: "stored context" });
  }
  const snapshot: EvidenceSnapshot = { blocks, fetched_at: now, retrieval: "x_search",
    truncation: { truncated: false } };
  const evidenceHash = await contentHash(snapshot);
  try {
    await env.DB.prepare(`INSERT INTO enrichment_provider_source_recoveries
      (operation_key,link_id,response_id,actor,payload_hash,source_payload,evidence_payload,
       evidence_hash,lease_token,lease_hash,created_at)
      SELECT ?,a.link_id,?,?,?,?,?,?,?,?,? FROM enrichment_provider_attempts a
      WHERE a.operation_key=?`)
      .bind(value.operation_key, value.response_id, value.actor, payloadHash,
        JSON.stringify(source), objectivePayload(snapshot), evidenceHash,
        owner.enrichment_lease_token, owner.lease_hash, now, value.operation_key).run();
    const stored = await readReceipt();
    if (!stored) return fail("attempt_not_eligible", 409);
    const result = replay(stored)!;
    if (result.status === 200) onResolved("committed");
    return result;
  } catch (cause) {
    const raced = replay(await readReceipt());
    if (raced) {
      if (raced.status === 200) onResolved("replay");
      return raced;
    }
    if (String(cause).includes("provider_source_recovery_ineligible") ||
        String(cause).includes("provider_source_recovery_snapshot_conflict")) {
      return fail("attempt_not_eligible", 409);
    }
    throw cause;
  }
}

type RecoveredReading = {
  ai_title: string; original_language: string; translated_text: string;
  summary: string; model: string;
};

function validRecoveredReading(value: unknown): value is RecoveredReading {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reading = value as Record<string, unknown>;
  const limits: Record<string, number> = { ai_title: 200, original_language: 32,
    translated_text: 100_000, summary: 4_000, model: 200 };
  const title = reading.ai_title;
  if (typeof title !== "string" || Array.from(title).length < 8 ||
      Array.from(title).length > 32 || !/\p{Script=Han}/u.test(title)) return false;
  return Object.keys(reading).length === Object.keys(limits).length &&
    Object.entries(limits).every(([key, limit]) => typeof reading[key] === "string" &&
      (reading[key] as string).trim().length > 0 &&
      (reading[key] as string).length <= limit &&
      (reading[key] as string) === (reading[key] as string).trim());
}

// R2 image names are deterministic for their source URL and content type.
// A paid reading attempt starts only after StoreImages has completed. Require
// exactly one matching object for every current source URL; missing or
// ambiguous objects keep the permit blocked rather than guessing a reference.
async function recoveredImages(env: Env, id: number, imageURLs: string[]): Promise<
  { key: string; content_type: string }[] | null> {
  const types = [
    ["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"],
    ["image/gif", "gif"], ["image/avif", "avif"]
  ] as const;
  const images: { key: string; content_type: string }[] = [];
  for (const url of new Set(imageURLs)) {
    const hash = await digest(url);
    const candidates = await Promise.all(types.map(async ([type, extension]) => {
      const key = `enrichment/${id}/${hash}.${extension}`;
      const object = await env.ENRICHMENT_IMAGES.head(key);
      return object && object.customMetadata?.source_url === url &&
        object.httpMetadata?.contentType === type && object.size > 0 && object.size <= (15 << 20)
        ? { key, content_type: type } : null;
    }));
    const matching = candidates.flatMap((image) => image === null ? [] : [image]);
    if (matching.length !== 1) return null;
    images.push(matching[0]);
  }
  return images;
}

async function verifiedCurrentImages(env: Env, id: number, payload: string): Promise<boolean> {
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return false; }
  if (!Array.isArray(value) || value.length > 8) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const image = item as Record<string, unknown>;
    if (Object.keys(image).length !== 2 || typeof image.key !== "string" ||
        typeof image.content_type !== "string" ||
        !new RegExp(`^enrichment/${id}/[0-9a-f]{64}\\.(jpg|png|webp|gif|avif)$`).test(image.key) ||
        seen.has(image.key)) return false;
    seen.add(image.key);
    const object = await env.ENRICHMENT_IMAGES.head(image.key);
    if (!object || object.httpMetadata?.contentType !== image.content_type ||
        object.size < 1 || object.size > (15 << 20)) return false;
  }
  return true;
}

async function recoverReading(request: Request, env: Env,
  onResolved: (outcome: "committed" | "replay") => void): Promise<Response> {
  const value = await readBody(request, 512 * 1024);
  if (value instanceof Response) return value;
  const keys = ["operation_key", "response_id", "actor", "reading"];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) ||
      !hex(value.operation_key) || typeof value.response_id !== "string" ||
      value.response_id.length < 1 || value.response_id.length > 200 ||
      !/^[A-Za-z0-9_-]+$/.test(value.response_id) ||
      typeof value.actor !== "string" || !/^[A-Za-z0-9._@-]{3,80}$/.test(value.actor) ||
      !validRecoveredReading(value.reading)) return fail("invalid_recovery");
  const reading = value.reading;
  const payloadHash = await digest(canonicalJSON({ response_id: value.response_id, reading }));
  const readReceipt = () => env.DB.prepare(`SELECT payload_hash,response
    FROM enrichment_provider_reading_recoveries WHERE operation_key=?`)
    .bind(value.operation_key).first<{ payload_hash: string; response: string }>();
  const replay = (row: { payload_hash: string; response: string } | null) => row
    ? row.payload_hash === payloadHash ? json(JSON.parse(row.response)) : fail("operation_conflict", 409)
    : null;
  const prior = replay(await readReceipt());
  if (prior) {
    if (prior.status === 200) onResolved("replay");
    return prior;
  }

  const current = await env.DB.prepare(`SELECT a.link_id,a.lease_hash,l.enrichment_lease_token,
    l.url,l.original_text,l.images,s.url AS source_url,s.original_text AS source_text,
    s.payload AS source_payload
    FROM enrichment_provider_attempts a JOIN links l ON l.id=a.link_id
    JOIN enrichment_sources s ON s.link_id=l.id WHERE a.operation_key=?`)
    .bind(value.operation_key).first<{ link_id: number; lease_hash: string | null;
      enrichment_lease_token: string | null; url: string; original_text: string | null; images: string;
      source_url: string; source_text: string; source_payload: string }>();
  if (!current?.lease_hash || !current.enrichment_lease_token ||
      await digest(current.enrichment_lease_token) !== current.lease_hash ||
      current.url !== current.source_url || current.original_text !== current.source_text) {
    return fail("attempt_not_eligible", 409);
  }
  let source: unknown;
  try { source = JSON.parse(current.source_payload); } catch { return fail("attempt_not_eligible", 409); }
  if (!validEnrichmentSource(source) || source.original_text !== current.original_text) {
    return fail("attempt_not_eligible", 409);
  }
  const images = source.image_urls.length > 0
    ? await recoveredImages(env, current.link_id, source.image_urls) : [];
  if (images === null || source.image_urls.length === 0 &&
      !await verifiedCurrentImages(env, current.link_id, current.images)) {
    return fail("stored_images_unavailable", 409);
  }
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`INSERT INTO enrichment_provider_reading_recoveries
      (operation_key,link_id,response_id,actor,payload_hash,reading_payload,source_payload,
       images_payload,lease_token,lease_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(value.operation_key, current.link_id, value.response_id, value.actor, payloadHash,
        JSON.stringify(reading), current.source_payload,
        source.image_urls.length > 0 ? JSON.stringify(images) : null,
        current.enrichment_lease_token, current.lease_hash, now).run();
    const stored = await readReceipt();
    if (!stored) return fail("attempt_not_eligible", 409);
    const result = replay(stored)!;
    if (result.status === 200) onResolved("committed");
    return result;
  } catch (cause) {
    const raced = replay(await readReceipt());
    if (raced) {
      if (raced.status === 200) onResolved("replay");
      return raced;
    }
    if (String(cause).includes("provider_reading_recovery_ineligible")) {
      return fail("attempt_not_eligible", 409);
    }
    throw cause;
  }
}

export async function providerAttemptRoute(request: Request, env: Env, path: string,
  onRecovery?: (event: ProviderRecoveryEvent) => void,
  onBusiness?: (event: WorkerBusinessEvent) => void): Promise<Response | null> {
  const root = "/api/enrichment/provider-attempts";
  if (path !== root && !["reserve", "settle", "authorize-fallback", "summary", "reconcile", "inspect", "recover-source", "recover-reading"].some((part) => path === `${root}/${part}`)) {
    return null;
  }
  if (path === root) return request.method === "GET" ? list(env, new URL(request.url)) : fail("method_not_allowed", 405);
  if (path === `${root}/summary`) return request.method === "GET" ? summary(env) : fail("method_not_allowed", 405);
  if (path === `${root}/inspect`) return request.method === "GET" ? inspect(env, new URL(request.url)) : fail("method_not_allowed", 405);
  if (request.method !== "POST") return fail("method_not_allowed", 405);
  if (["reserve", "settle", "authorize-fallback", "reconcile"].some((part) => path.endsWith(`/${part}`))) {
    const action = path.endsWith("/reserve") ? "reserve" : path.endsWith("/settle") ? "settle" :
      path.endsWith("/authorize-fallback") ? "authorize_fallback" : "reconcile";
    let event: AttemptEvent | undefined;
    try {
      const response = action === "reserve"
        ? await reserve(request, env, (resolved) => { event = resolved; })
        : action === "settle" ? await settle(request, env, (resolved) => { event = resolved; })
          : action === "authorize_fallback"
            ? await authorizeFallback(request, env, (resolved) => { event = resolved; })
            : await reconcile(request, env, (resolved) => { event = resolved; });
      onBusiness?.(event ?? { kind: "provider_attempt", action, stage: "unknown",
        outcome: response.status >= 400 ? "rejected" : "failed", status: response.status,
        reason: response.status === 400 || response.status === 413 ? "invalid_request" :
          response.status === 404 ? "not_found" : "unclassified" });
      return response;
    } catch (cause) {
      onBusiness?.({ kind: "provider_attempt", action, stage: "unknown", outcome: "failed", status: 500 });
      throw cause;
    }
  }
  if (path.endsWith("/recover-source") || path.endsWith("/recover-reading")) {
    const stage = path.endsWith("/recover-source") ? "source" : "reading";
    let outcome: ProviderRecoveryEvent["outcome"] = "rejected";
    try {
      const result = stage === "source"
        ? await recoverSource(request, env, (resolved) => { outcome = resolved; })
        : await recoverReading(request, env, (resolved) => { outcome = resolved; });
      onRecovery?.({ stage, outcome, status: result.status });
      return result;
    } catch (cause) {
      onRecovery?.({ stage, outcome: "failed", status: 500 });
      throw cause;
    }
  }
  return fail("not_found", 404);
}
