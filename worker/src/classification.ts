import type { Env } from "./index";
import { record, taxonomy, validateClassification } from "./curation";

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;

// Typed failure classes. The consumer must not have to guess from a bare HTTP
// status: a 409 could be a lost lease, a changed target, a stale input or a
// duplicate completion, and those need different recovery. Each code maps to
// exactly one class and one HTTP status.
export type ClassificationErrorCode =
  | "capability_mismatch"
  | "target_changed"
  | "input_changed"
  | "lease_expired"
  | "already_completed"
  | "operation_conflict"
  | "invalid_classification"
  | "invalid_classification_config"
  | "invalid_source"
  | "invalid_operation_key"
  | "configuration_error"
  | "not_found"
  | "method_not_allowed"
  | "invalid_json";

const ERROR_STATUS: Record<ClassificationErrorCode, number> = {
  capability_mismatch: 409,
  target_changed: 409,
  input_changed: 409,
  lease_expired: 409,
  already_completed: 409,
  operation_conflict: 409,
  invalid_classification: 400,
  invalid_classification_config: 400,
  invalid_source: 400,
  invalid_operation_key: 400,
  configuration_error: 500,
  not_found: 404,
  method_not_allowed: 405,
  invalid_json: 400
};

// `conflict` stays for legacy callers that only understand `lease_conflict`.
const conflict = () => reply({ error: "lease_conflict" }, 409);
export const fail = (code: ClassificationErrorCode, extra: Record<string, unknown> = {}) =>
  reply({ error: code, ...extra }, ERROR_STATUS[code]);

// Legacy error codes that pre-v2 consumers already handle. `capability_mismatch`
// is deliberately *not* in this set so an old consumer cannot silently treat a
// v2-only target as an empty queue.
const LEGACY_ERROR_CODES = new Set(["invalid_classification", "invalid_classification_config", "invalid_source", "not_found", "method_not_allowed", "invalid_json"]);

// A completion is identified by an operation key supplied by the consumer. The
// key is stable across retries of the *same* logical commit, which is what
// makes a lost response recoverable without a second paid inference.
function operationKey(body: Record<string, unknown>): string | null {
  return text(body.operation_key, 200) ? body.operation_key : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readOperation(env: Env, key: string): Promise<{ link_id: number; payload_hash: string; status: string; response: string } | null> {
  return env.DB.prepare(
    `SELECT link_id, payload_hash, status, response FROM classification_operations WHERE operation_key = ?`
  ).bind(key).first();
}

// Idempotent commit wrapper. If the key was already used with an identical
// payload, replay the stored response. If it was used with a different payload,
// refuse rather than silently overwriting. Otherwise run `commit` and persist
// its response in the same D1 batch so a crash cannot record a result without
// recording the operation.
async function idempotent<T extends { id: number }>(
  env: Env,
  key: string | null,
  payloadHash: string,
  commit: () => Promise<{ response: T; body: unknown } | { failure: ClassificationErrorCode }>
): Promise<Response> {
  // Legacy consumers do not send an operation key; they keep the pre-v2
  // lease-guarded commit with no idempotency record. v2 consumers supply a key
  // and get exactly-once completion semantics.
  if (key !== null) {
    const existing = await readOperation(env, key);
    if (existing) {
      if (existing.payload_hash !== payloadHash) return fail("operation_conflict");
      return reply(JSON.parse(existing.response), 200);
    }
  }
  const outcome = await commit();
  if ("failure" in outcome) {
    return fail(outcome.failure);
  }
  if (key) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO classification_operations(operation_key, link_id, payload_hash, status, response, created_at)
       VALUES (?, ?, ?, 'applied', ?, ?)`
    ).bind(key, outcome.response.id, payloadHash, JSON.stringify(outcome.body), new Date().toISOString()).run();
  }
  return reply(outcome.body, 200);
}

type Target = {
  generation: number;
  spec_id: string;
  spec_hash: string;
  taxonomy_version: string;
  policy_version: string;
  requested_model: string;
  protocol: string;
};

async function activeTarget(env: Env): Promise<Target | null> {
  return env.DB.prepare(
    `SELECT t.generation, t.spec_id, t.spec_hash, t.taxonomy_version, t.policy_version,
            t.requested_model, t.protocol
     FROM classification_target_state s JOIN classification_targets t ON t.generation = s.generation
     WHERE s.id = 1`
  ).first<Target>();
}

type Capabilities = {
  protocol?: unknown;
  taxonomy_version?: unknown;
  policy_version?: unknown;
  model?: unknown;
  spec_ids?: unknown;
  taxonomy_versions?: unknown;
  policy_versions?: unknown;
  models?: unknown;
};

function supports(caps: Capabilities, target: Target): boolean {
  const list = (v: unknown): string[] | null => Array.isArray(v) && v.every((x) => typeof x === "string") ? v as string[] : null;
  const protocol = typeof caps.protocol === "string" ? caps.protocol : "legacy";
  // Legacy compatibility: generation 0 keeps the pre-v2 claim contract, where
  // the consumer announces the taxonomy version it was compiled against and a
  // policy/model. This is only accepted while the authoritative target is the
  // legacy one; a v2 target requires the explicit capabilities handshake.
  if (target.protocol === "legacy") {
    return protocol === "legacy" &&
      caps.taxonomy_version === taxonomy.version &&
      text(caps.policy_version, 100) && text(caps.model, 200);
  }
  if (protocol === "legacy") return false;
  const specIDs = list(caps.spec_ids);
  const taxonomies = list(caps.taxonomy_versions);
  const policies = list(caps.policy_versions);
  const models = list(caps.models);
  if (!specIDs || !taxonomies || !policies || !models) return false;
  return specIDs.includes(target.spec_id) &&
    taxonomies.includes(target.taxonomy_version) &&
    policies.includes(target.policy_version) &&
    models.includes(target.requested_model);
}

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1 << 20) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return record(value) ? value : null;
  } catch { return null; }
}

// All routes are protected by the enricher token in index.ts.
export async function classificationRoute(request: Request, env: Env, path: string): Promise<Response> {
  // Handshake: consumers discover the authoritative target and whether their
  // declared capabilities are accepted. This never mutates the target.
  if (path === "/api/enrichment/classifications/target" && request.method === "GET") {
    const target = await activeTarget(env);
    if (!target) return fail("configuration_error");
    // Capabilities may be declared as a GET query (read-only discovery) or as a
    // JSON body (POST-style probing). Discovery never mutates the target.
    const url = new URL(request.url);
    const fromQuery: Capabilities = {};
    const csv = (key: string): string[] | undefined => {
      const value = url.searchParams.get(key);
      return value === null ? undefined : value.split(",").filter(Boolean);
    };
    fromQuery.protocol = url.searchParams.get("protocol") ?? undefined;
    fromQuery.taxonomy_version = url.searchParams.get("taxonomy_version") ?? undefined;
    fromQuery.policy_version = url.searchParams.get("policy_version") ?? undefined;
    fromQuery.model = url.searchParams.get("model") ?? undefined;
    fromQuery.spec_ids = csv("spec_ids");
    fromQuery.taxonomy_versions = csv("taxonomy_versions");
    fromQuery.policy_versions = csv("policy_versions");
    fromQuery.models = csv("models");
    return reply({ target, supported: supports(fromQuery, target) });
  }
  if (path === "/api/enrichment/classifications/target" && request.method === "POST") {
    // Management-only target switch. Guarded by the enricher token in index.ts;
    // App tokens never reach this route. A switch always creates a *new*
    // generation pointing at the requested spec so rollback cannot rewind.
    const body = await bodyOf(request);
    if (!body || !text(body.spec_id, 200) || !text(body.spec_hash, 200) ||
      !text(body.taxonomy_version, 100) || typeof body.policy_version !== "string" ||
      typeof body.requested_model !== "string" || !["legacy", "v2"].includes(String(body.protocol))) {
      return fail("invalid_classification_config");
    }
    const current = await activeTarget(env);
    if (!current) return fail("configuration_error");
    if (body.expected_generation !== undefined && body.expected_generation !== current.generation) {
      return fail("target_changed", { generation: current.generation });
    }
    if (current.spec_hash === body.spec_hash && current.policy_version === body.policy_version &&
      current.requested_model === body.requested_model && current.taxonomy_version === body.taxonomy_version) {
      return reply({ generation: current.generation, unchanged: true });
    }
    const generation = current.generation + 1;
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO classification_targets(generation, spec_id, spec_hash, taxonomy_version, policy_version, requested_model, protocol, created_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(generation, body.spec_id, body.spec_hash, body.taxonomy_version, body.policy_version,
        body.requested_model, body.protocol, now, typeof body.note === "string" ? body.note.slice(0, 500) : null),
      env.DB.prepare(`UPDATE classification_target_state SET generation = ?, updated_at = ? WHERE id = 1`)
        .bind(generation, now)
    ]);
    return reply({ generation, spec_id: body.spec_id, protocol: body.protocol });
  }

  const match = path.match(/^\/api\/enrichment\/classifications\/(\d+)(?:\/(complete|fail|retry))?$/);
  const id = match ? Number(match[1]) : 0;
  if (match && !match[2] && request.method === "GET") {
    const row = await env.DB.prepare(`SELECT link_id AS id, revision, input_revision, target_generation, spec_id,
      status, attempts, next_retry_at, taxonomy_version, policy_version, requested_model, error, result, updated_at
      FROM classification_jobs WHERE link_id = ?`).bind(id).first();
    return row ? reply(row) : fail("not_found");
  }
  if (request.method !== "POST") return fail("method_not_allowed");
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  const now = new Date().toISOString();
  if (path === "/api/enrichment/classifications/claim") {
    const target = await activeTarget(env);
    if (!target) return fail("configuration_error");
    // The consumer declares capabilities; it never defines the target. A
    // mismatch is a component-level condition and must not drain the queue or
    // burn attempts.
    if (!supports(body as Capabilities, target)) {
      return fail("capability_mismatch", { target_generation: target.generation, protocol: target.protocol });
    }
    const token = crypto.randomUUID();
    const until = new Date(Date.now() + 15 * 60_000).toISOString();
    await env.DB.prepare(`UPDATE classification_jobs SET status='exhausted', lease_token=NULL, lease_until=NULL,
      error='classification lease expired', updated_at=? WHERE status='processing' AND lease_until<=? AND attempts>=5`)
      .bind(now, now).run();
    // Claim only jobs that are due for the *active* target. A job already
    // completed against the active generation is never re-armed just because a
    // consumer announced a different policy; that was the version-competition
    // loop this batch removes. Jobs bound to an older generation are migrated
    // to the active target with a fresh attempt budget.
    const job = await env.DB.prepare(`UPDATE classification_jobs SET status='processing',
      attempts=CASE WHEN target_generation<>? THEN 1 ELSE attempts+1 END,
      lease_token=?, lease_until=?, next_retry_at=NULL, error=NULL,
      target_generation=?, spec_id=?, taxonomy_version=?, policy_version=?, requested_model=?, updated_at=?
      WHERE link_id=(SELECT j.link_id FROM classification_jobs j JOIN links l ON l.id=j.link_id
        WHERE COALESCE(l.original_text,'')<>'' AND l.curation_status<>'drop'
        AND (j.status<>'processing' OR j.lease_until<=?)
        AND (j.target_generation<>?
          OR (j.attempts<5 AND (j.status='pending' OR (j.status='failed' AND j.next_retry_at<=?)
            OR (j.status='processing' AND j.lease_until<=?))))
        ORDER BY COALESCE(j.updated_at,''), j.link_id LIMIT 1)
      RETURNING link_id AS id, revision, input_revision, attempts AS attempt, lease_token, lease_until,
                target_generation, spec_id`)
      .bind(target.generation, token, until,
        target.generation, target.spec_id, taxonomy.version, String(body.policy_version), String(body.model), now,
        now, target.generation, now, now).first<{ id: number; revision: number }>();
    if (!job) return new Response(null, { status: 204, headers });
    const source = await env.DB.prepare(`SELECT l.url,l.note,l.original_text,
      CASE WHEN s.original_text=l.original_text AND s.url=l.url THEN COALESCE(json_extract(s.payload,'$.context_text'),'') ELSE '' END AS context_text
      FROM links l LEFT JOIN enrichment_sources s ON s.link_id=l.id
      JOIN classification_jobs j ON j.link_id=l.id
      WHERE l.id=? AND j.lease_token=? AND j.revision=?`).bind(job.id, token, job.revision).first();
    return source ? reply({ ...job, ...source }) : conflict();
  }
  if (!match) return fail("not_found");
  if (match[2] === "retry") {
    // Retry re-arms the *active* target. It never changes the server target and
    // never preempts an active lease.
    const target = await activeTarget(env);
    if (!target) return fail("configuration_error");
    const row = await env.DB.prepare(`INSERT INTO classification_jobs(link_id)
      SELECT id FROM links WHERE id=? AND COALESCE(original_text,'')<>''
      ON CONFLICT(link_id) DO UPDATE SET status='pending',attempts=0,next_retry_at=NULL,
        lease_token=NULL,lease_until=NULL,error=NULL,revision=revision+1,
        target_generation=?,spec_id=?
        WHERE classification_jobs.status<>'processing' OR classification_jobs.lease_until<=?
      RETURNING link_id`).bind(id, target.generation, target.spec_id, now).first();
    return row ? reply({ id, status: "pending" }) : conflict();
  }
  // complete/fail must carry a matching lease, revision and target binding.
  if (!text(body.lease_token, 100) || !Number.isSafeInteger(body.revision)) return fail("invalid_classification");
  if (match[2] === "complete") {
    if (!record(body.result)) return fail("invalid_classification");
    const result = body.result;
    const classification = validateClassification(result.classification);
    if (!classification || !text(result.model, 200) || !text(result.policy_version, 100) || !record(result.answers)) {
      return fail("invalid_classification");
    }
    const key = operationKey(body);
    const payloadHash = await sha256Hex(JSON.stringify({ id, revision: body.revision, result }));
    return idempotent(env, key, payloadHash, async () => {
      const target = await activeTarget(env);
      if (!target) return { failure: "configuration_error" as const };
      // Reject completions that no longer match the active target *before*
      // touching storage, so a stale worker cannot overwrite the projection.
      const job = await env.DB.prepare(`SELECT status, target_generation, spec_id, taxonomy_version, revision, input_revision, lease_token, lease_until
        FROM classification_jobs WHERE link_id=?`).bind(id).first<{
          status: string; target_generation: number; spec_id: string; taxonomy_version: string; revision: number; input_revision: number;
          lease_token: string | null; lease_until: string | null;
        }>();
      if (!job) return { failure: "not_found" as const };
      if (job.status === "completed") return { failure: "already_completed" as const };
      // Legacy consumers (pre-v2 handshake) do not send target fields. Only
      // enforce them when the job is bound to a v2 target; the job is still
      // bound to the active generation, so a stale worker cannot win.
      const declaredGeneration = body.target_generation === undefined ? job.target_generation : Number(body.target_generation);
      const declaredSpec = result.spec_id === undefined ? job.spec_id : String(result.spec_id);
      if (declaredGeneration !== job.target_generation || declaredSpec !== job.spec_id ||
        job.target_generation !== target.generation) {
        return { failure: "target_changed" as const };
      }
      if (body.input_revision !== undefined && Number(body.input_revision) !== job.input_revision) {
        return { failure: "input_changed" as const };
      }
      if (job.lease_token !== body.lease_token || job.revision !== body.revision ||
        !job.lease_until || job.lease_until <= now) {
        return { failure: "lease_expired" as const };
      }
      const results = await env.DB.batch([
        env.DB.prepare(`UPDATE links SET classification=? WHERE id=? AND EXISTS(
          SELECT 1 FROM classification_jobs WHERE link_id=? AND status='processing' AND lease_token=?
          AND revision=? AND input_revision=? AND lease_until>? AND policy_version=? AND taxonomy_version=?
          AND target_generation=? AND spec_id=?) RETURNING id`)
          .bind(JSON.stringify(classification), id, id, body.lease_token, body.revision, job.input_revision, now,
            result.policy_version, job.taxonomy_version, target.generation, target.spec_id),
        env.DB.prepare(`UPDATE classification_jobs SET status='completed',result=?,error=NULL,
          lease_token=NULL,lease_until=NULL,updated_at=? WHERE link_id=? AND status='processing'
          AND lease_token=? AND revision=? AND input_revision=? AND lease_until>? AND policy_version=? AND taxonomy_version=?
          AND target_generation=? AND spec_id=? RETURNING link_id`)
          .bind(JSON.stringify({ ...result, classification }), now, id, body.lease_token, body.revision,
            job.input_revision, now, result.policy_version, job.taxonomy_version, target.generation, target.spec_id)
      ]);
      if (!results[0].results.length) return { failure: "lease_expired" as const };
      return { response: { id }, body: { id, status: "completed" } };
    });
  }
  if (match[2] === "fail") {
    if (!text(body.error, 1800)) return fail("invalid_classification");
    const job = await env.DB.prepare(`SELECT status, attempts, target_generation, spec_id, revision, input_revision, lease_token, lease_until
      FROM classification_jobs WHERE link_id=?`).bind(id).first<{
        status: string; attempts: number; target_generation: number; spec_id: string; revision: number; input_revision: number;
        lease_token: string | null; lease_until: string | null;
      }>();
    if (!job) return fail("not_found");
    if (job.status === "completed") return fail("already_completed");
    if (job.lease_token !== body.lease_token || job.revision !== body.revision ||
      !job.lease_until || job.lease_until <= now) {
      return fail("lease_expired");
    }
    // A job superseded by a newer input revision is not a model failure. Mark
    // it stale without spending the new target's attempt budget.
    if (body.input_revision !== undefined && Number(body.input_revision) !== job.input_revision) {
      await env.DB.prepare(`UPDATE classification_jobs SET status='pending', lease_token=NULL, lease_until=NULL,
        next_retry_at=NULL, updated_at=? WHERE link_id=? AND lease_token=?`).bind(now, id, body.lease_token).run();
      return reply({ id, status: "superseded" });
    }
    const status = job.attempts >= 5 ? "exhausted" : "failed";
    const delay = [60_000, 300_000, 1800_000, 7200_000][Math.min(job.attempts - 1, 3)];
    const retry = status === "exhausted" ? null : new Date(Date.now() + delay).toISOString();
    const row = await env.DB.prepare(`UPDATE classification_jobs SET status=?,error=?,next_retry_at=?,
      lease_token=NULL,lease_until=NULL,updated_at=? WHERE link_id=? AND status='processing'
      AND lease_token=? AND revision=? AND lease_until>? RETURNING link_id`)
      .bind(status, body.error, retry, now, id, body.lease_token, body.revision, now).first();
    return row ? reply({ id, status }) : fail("lease_expired");
  }
  return fail("not_found");
}

export async function sourceRoute(request: Request, env: Env, id: number): Promise<Response> {
  if (request.method === "GET") {
    const row = await env.DB.prepare(`SELECT s.payload FROM enrichment_sources s JOIN links l ON l.id=s.link_id
      WHERE l.id=? AND s.url=l.url AND s.original_text=l.original_text`).bind(id).first<{ payload: string }>();
    return row ? new Response(row.payload, { headers }) : new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") return fail("method_not_allowed");
  const body = await bodyOf(request);
  if (!body || !text(body.lease_token, 100) || !record(body.source)) return fail("invalid_source");
  const source = body.source;
  if (!text(source.original_text, 100_000) || !text(source.model, 200) ||
    typeof source.original_language !== "string" || source.original_language.length > 32 ||
    typeof source.context_text !== "string" || source.context_text.length > 100_000 ||
    !Array.isArray(source.related_links) || source.related_links.length > 50 ||
    !source.related_links.every((v) => safeURL(v, false)) ||
    !Array.isArray(source.image_urls) || source.image_urls.length > 8 || !source.image_urls.every((v) => safeURL(v, true))) {
    return fail("invalid_source");
  }
  const now = new Date().toISOString();
  const guard = "id=? AND enrichment_status='processing' AND enrichment_lease_token=? AND enrichment_lease_until>?";
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE links SET original_text=?,original_language=?,related_links=?,
      ai_title=NULL,translated_text=NULL,summary=NULL,images=CASE WHEN original_text IS ? THEN images ELSE '[]' END,
      enrichment_updated_at=? WHERE ${guard} RETURNING id`)
      .bind(source.original_text, source.original_language || null, JSON.stringify(source.related_links), source.original_text, now, id, body.lease_token, now),
    env.DB.prepare(`INSERT INTO enrichment_sources(link_id,url,original_text,payload,fetched_at)
      SELECT id,url,?,?,? FROM links WHERE ${guard}
      ON CONFLICT(link_id) DO UPDATE SET url=excluded.url,original_text=excluded.original_text,
        payload=excluded.payload,fetched_at=excluded.fetched_at`)
      .bind(source.original_text, JSON.stringify(source), now, id, body.lease_token, now)
  ]);
  return results[0].results.length ? reply({ id, status: "source_saved" }) : conflict();
}

function safeURL(value: unknown, image: boolean): boolean {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && (image
      ? url.protocol === "https:" && url.hostname === "pbs.twimg.com" && !url.port && url.pathname.startsWith("/media/")
      : ["http:", "https:"].includes(url.protocol));
  } catch { return false; }
}

export { LEGACY_ERROR_CODES };
