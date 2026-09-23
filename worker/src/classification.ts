import { CLASSIFICATION_LIMITS, classificationBudgetAvailable, classificationWindow, validClassificationLimits } from "./classification-budget";
import { validRunProvenance } from "./run-provenance";
import type { Env } from "./index";
import { record, taxonomy, validateClassification } from "./curation";
import { objectiveUseAllowed, validAssessment, type AutomaticView } from "./domain";
import { decisionInsertStatement, rebuildProjection, runInsertStatement, type WriteGuard } from "./domain-routes";

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;

// Typed failure classes. The consumer must not have to guess from a bare HTTP
// status: a 409 could be a lost lease, a changed target, a stale input or a
// duplicate completion, and those need different recovery. Each code maps to
// exactly one class and one HTTP status.
export type ClassificationErrorCode =
  | "budget_exhausted"
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
  | "lease_conflict"
  | "not_found"
  | "method_not_allowed"
  | "invalid_json";

const ERROR_STATUS: Record<ClassificationErrorCode, number> = {
  budget_exhausted: 429,
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
  lease_conflict: 409,
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

async function readOperation(env: Env, key: string, linkID: number): Promise<{ link_id: number; payload_hash: string; status: string; response: string } | null> {
  const row = await env.DB.prepare(
    `SELECT link_id, payload_hash, status, response FROM classification_operations WHERE operation_key = ?`
  ).bind(key).first<{ link_id: number; payload_hash: string; status: string; response: string }>();
  if (!row) return null;
  // An operation key is scoped to one bookmark. A key from another link must
  // never replay that link's result for this one (R2-12).
  if (row.link_id !== linkID) return { ...row, link_id: -1 };
  return row;
}

// Idempotent commit wrapper. If the key was already used with an identical
// payload for the same link, replay the stored response. A different link or
// payload is a conflict. Otherwise every dependent write shares one in-batch
// validity predicate: when the guard does not hold, no success run, decision or
// operation record is written at all (R2-01). A post-batch check is only a
// report of that atomic outcome, never a substitute for it.
type CommitOutcome<T extends { id: number }> = {
  statements: D1PreparedStatement[];
  // Finalization clears the lease, so it must run after all other writes that
  // share the processing-state guard (including the operation receipt).
  finalize: D1PreparedStatement;
  // guardIndex is the statement whose zero-row result means the guarded write
  // did not land; the whole batch then had no effect.
  guardIndex: number;
  operationGuard: WriteGuard;
  response: T;
  body: unknown;
};

async function idempotent<T extends { id: number }>(
  env: Env,
  key: string | null,
  payloadHash: string,
  linkID: number,
  commit: () => Promise<CommitOutcome<T> | { failure: ClassificationErrorCode }>
): Promise<Response> {
  const replayExisting = async (): Promise<Response | null> => {
    if (key === null) return null;
    const existing = await readOperation(env, key, linkID);
    if (existing) {
      if (existing.link_id !== linkID) return fail("operation_conflict", { reason: "operation_key belongs to another bookmark" });
      if (existing.payload_hash !== payloadHash) return fail("operation_conflict");
      return reply(JSON.parse(existing.response), 200);
    }
    return null;
  };
  const existing = await replayExisting();
  if (existing) return existing;
  const outcome = await commit();
  // A concurrent identical commit can finish between the first operation read
  // and preflight. Confirm that exact operation before reporting its stale lease.
  if ("failure" in outcome) return await replayExisting() ?? fail(outcome.failure);
  const operation = key === null ? null : env.DB.prepare(
    `INSERT INTO classification_operations(operation_key, link_id, payload_hash, status, response, created_at)
     SELECT ?, ?, ?, 'applied', ?, ? WHERE ${outcome.operationGuard.sql}
     RETURNING operation_key`
  ).bind(key, linkID, payloadHash, JSON.stringify(outcome.body), new Date().toISOString(),
    ...outcome.operationGuard.bindings);
  const statements = [...outcome.statements, ...(operation === null ? [] : [operation]), outcome.finalize];
  try {
    const results = await env.DB.batch(statements);
    if (!results[outcome.guardIndex]?.results.length) {
      // The guard did not hold, so every dependent insert was skipped by the
      // same predicate; report the lost lease and leave no success record.
      return await replayExisting() ?? fail("lease_expired");
    }
    if (operation !== null && !results[statements.length - 2]?.results.length) {
      // The guarded write landed but the operation record did not, which means
      // the predicate was false for it; treat it as a lost lease.
      return fail("lease_expired");
    }
  } catch (error) {
    // The only expected failure is the operation-key UNIQUE constraint from a
    // concurrent duplicate. Re-read it: an identical payload replays, a
    // different payload or link is a conflict, and any other error is re-raised.
    if (key === null) throw error;
    const existing = await readOperation(env, key, linkID);
    if (existing && existing.link_id === linkID && existing.payload_hash === payloadHash) {
      return reply(JSON.parse(existing.response), 200);
    }
    if (existing) return fail("operation_conflict");
    throw error;
  }
  return reply(outcome.body, 200);
}

// automaticView validates the pure decision's per-dimension proposals that the
// v2 consumer computed. The server never treats this as the effective view: it
// stores it as the automatic baseline and re-applies the stored human
// overrides deterministically (F07).
function automaticView(value: unknown): AutomaticView | null {
  if (!record(value) || !objectiveUseAllowed(value)) return null;
  const list = (entry: unknown, max: number): string[] | null => {
    if (entry === undefined) return [];
    if (!Array.isArray(entry) || entry.length > max) return null;
    return entry.every((item) => typeof item === "string" && item.length > 0 && item.length <= 80) ? entry as string[] : null;
  };
  const topics = list(value.topics, 64);
  const contentFunctions = list(value.content_functions, 8);
  const carriers = list(value.carriers, 1);
  const affordances = list(value.affordances, 8);
  const entities = list(value.entities, 10);
  if (!topics || !contentFunctions || !carriers || !affordances || !entities) return null;
  if (value.assessment !== undefined && !validAssessment(value.assessment)) return null;
  return {
    ...(value.assessment === undefined ? {} : { assessment: value.assessment }),
    topics, content_functions: contentFunctions, carriers, affordances, entities,
    form: typeof value.form === "string" && value.form.length <= 40 ? value.form : "",
    use: typeof value.use === "string" && value.use.length <= 40 ? value.use : ""
  };
}

// v2ResultShape reports whether a completion carries the multidimensional
// records. A legacy consumer sends only the v1 projection and is still
// accepted; a v2 consumer sends the immutable identity and the automatic view.
function v2ResultShape(result: Record<string, unknown>): boolean {
  return result.spec_id !== undefined || result.automatic !== undefined || result.spec_hash !== undefined;
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
    const response = reply({ target, supported: request.headers.get("X-Cairn-Classification-Budget") === "1" && supports(fromQuery, target) });
    response.headers.set("X-Cairn-Classification-Budget", "1");
    return response;
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
    if (request.headers.get("X-Cairn-Classification-Budget") !== "1" || !supports(body as Capabilities, target)) {
      return fail("capability_mismatch", { target_generation: target.generation, protocol: target.protocol });
    }
    const budgetLimits = body.budget_limits ?? CLASSIFICATION_LIMITS;
    if (!validClassificationLimits(budgetLimits)) return fail("invalid_classification_config");
    if (!await classificationBudgetAvailable(env, budgetLimits)) return fail("budget_exhausted");
    const budgetWindow = classificationWindow();
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
    //
    // Every v2 bound value comes from the authoritative target row, never from
    // the consumer's claim body. A v2 consumer sends plural `policy_versions`
    // and `models` capability arrays; reading the legacy singular fields from
    // that body used to store the literal string "undefined" and made the
    // completion match zero rows. The legacy protocol keeps the pre-v2 contract
    // (the consumer announces the policy/model it was compiled with) because
    // generation 0 exists exactly for those consumers.
    //
    // The subquery in the WHERE clause makes the read and the write one atomic
    // boundary: if the target pointer moved between activeTarget() and this
    // UPDATE, no job is claimed.
    const isLegacy = target.protocol === "legacy";
    const boundPolicy = isLegacy ? String(body.policy_version) : target.policy_version;
    const boundModel = isLegacy ? String(body.model) : target.requested_model;
    const boundTaxonomy = isLegacy ? taxonomy.version : target.taxonomy_version;
    // The lease binds the exact evidence identity the inference will see: the
    // content revision and its matching snapshot id/hash. A completion can then
    // never re-stamp an old inference with a newer revision (R2-02). A v2 job
    // waits without consuming attempts until its current source is checkpointed.
    const job = await env.DB.prepare(`UPDATE classification_jobs SET status='processing',
      attempts=CASE WHEN target_generation<>? THEN 1 ELSE attempts+1 END,
      lease_token=?, lease_until=?, next_retry_at=NULL, error=NULL,
      target_generation=?, spec_id=?, taxonomy_version=?, policy_version=?, requested_model=?, updated_at=?,
      content_revision=(SELECT content_revision FROM links WHERE id=classification_jobs.link_id),
      evidence_snapshot_id=(SELECT id FROM evidence_snapshots WHERE link_id=classification_jobs.link_id
        AND content_revision=(SELECT content_revision FROM links WHERE id=classification_jobs.link_id)),
      evidence_hash=COALESCE((SELECT content_hash FROM evidence_snapshots WHERE link_id=classification_jobs.link_id
        AND content_revision=(SELECT content_revision FROM links WHERE id=classification_jobs.link_id)),'')
      WHERE link_id=(SELECT j.link_id FROM classification_jobs j JOIN links l ON l.id=j.link_id
        WHERE COALESCE(l.original_text,'')<>'' AND l.curation_status<>'drop'
        AND (SELECT COUNT(*) FROM budget_ledger b WHERE b.scope='classification_item' AND b.link_id=j.link_id AND b.created_at>=? AND b.created_at<?) < ?
        AND (SELECT COALESCE(SUM(json_extract(b.units,'$.tokens')),0) FROM budget_ledger b WHERE b.scope='classification_item' AND b.link_id=j.link_id AND b.created_at>=? AND b.created_at<?)+65536 <= ?
        AND (?=1 OR EXISTS (SELECT 1 FROM evidence_snapshots s
          WHERE s.link_id=l.id AND s.content_revision=l.content_revision AND s.completeness<>'empty'
          AND EXISTS (SELECT 1 FROM json_each(s.payload,'$.blocks') b
            WHERE json_extract(b.value,'$.role')='primary' AND json_extract(b.value,'$.text')=l.original_text)))
        AND (j.status<>'processing' OR j.lease_until<=?)
        AND (j.target_generation<>?
          OR (j.attempts<5 AND (j.status='pending' OR (j.status='failed' AND j.next_retry_at<=?)
            OR (j.status='processing' AND j.lease_until<=?))))
        ORDER BY COALESCE(j.updated_at,''), j.link_id LIMIT 1)
      AND (SELECT generation FROM classification_target_state WHERE id=1)=?
      AND (SELECT COUNT(*) FROM budget_ledger b WHERE b.scope='classification_global' AND b.created_at>=? AND b.created_at<?) < ?
      AND (SELECT COALESCE(SUM(json_extract(b.units,'$.tokens')),0) FROM budget_ledger b WHERE b.scope='classification_global' AND b.created_at>=? AND b.created_at<?)+65536 <= ?
      RETURNING link_id AS id, revision, input_revision, attempts AS attempt, lease_token, lease_until,
                target_generation, spec_id, content_revision, evidence_snapshot_id, evidence_hash`)
      .bind(target.generation, token, until,
        target.generation, target.spec_id, boundTaxonomy, boundPolicy, boundModel, now,
        budgetWindow.start, budgetWindow.end, budgetLimits.max_calls_per_item, budgetWindow.start, budgetWindow.end, budgetLimits.max_tokens_per_item,
        isLegacy ? 1 : 0, now, target.generation, now, now, target.generation,
        budgetWindow.start, budgetWindow.end, budgetLimits.max_calls_total, budgetWindow.start, budgetWindow.end, budgetLimits.max_tokens)
      .first<{ id: number; revision: number; content_revision: number; evidence_snapshot_id: number | null; evidence_hash: string }>();
    if (!job) return new Response(null, { status: 204, headers });
    const source = await env.DB.prepare(`SELECT l.url,l.note,l.original_text,l.related_links,
      CASE WHEN s.original_text=l.original_text AND s.url=l.url THEN COALESCE(json_extract(s.payload,'$.context_text'),'') ELSE '' END AS context_text
      FROM links l LEFT JOIN enrichment_sources s ON s.link_id=l.id
      JOIN classification_jobs j ON j.link_id=l.id
      WHERE l.id=? AND j.lease_token=? AND j.revision=?`).bind(job.id, token, job.revision).first<{ related_links: string | null }>();
    if (!source) return conflict();
    let relatedLinks: string[] = [];
    try {
      const parsed: unknown = JSON.parse(source.related_links ?? "[]");
      if (Array.isArray(parsed)) relatedLinks = parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 50);
    } catch { relatedLinks = []; }
    return reply({ ...job, ...source, related_links: relatedLinks });
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
    // A v2 completion must carry its immutable identity and the typed answers,
    // because those are what the replayable run is built from.
    const isV2 = v2ResultShape(result);
    const automatic = isV2 ? automaticView(result.automatic) : null;
    if (isV2 && (!text(result.spec_id, 64) || !text(result.spec_hash, 128) || automatic === null)) {
      return fail("invalid_classification");
    }
    if (isV2 && !await validRunProvenance(env, id, result.raw_judgments, {
      specId: String(result.spec_id), specHash: String(result.spec_hash),
      requestedModel: String(result.requested_model ?? result.model), resolvedModel: String(result.model),
      coverage: result.coverage === "partial" ? "partial" : "complete", answers: result.answers, usage: result.usage ?? { missing: true }
    })) return fail("invalid_classification");
    const key = operationKey(body);
    // The logical payload identity covers the link, the lease epoch and the
    // full result, so a replayed key with a different payload is a conflict
    // instead of a silent success (R2-12).
    const payloadHash = await sha256Hex(JSON.stringify({ id, revision: body.revision, result }));
    const response = await idempotent(env, key, payloadHash, id, async () => {
      const target = await activeTarget(env);
      if (!target) return { failure: "configuration_error" as const };
      // Reject completions that no longer match the active target *before*
      // touching storage, so a stale worker cannot overwrite the projection.
      const job = await env.DB.prepare(`SELECT status, target_generation, spec_id, taxonomy_version, revision, input_revision, lease_token, lease_until, content_revision, evidence_hash, evidence_snapshot_id, attempts
        FROM classification_jobs WHERE link_id=?`).bind(id).first<{
          status: string; target_generation: number; spec_id: string; taxonomy_version: string; revision: number; input_revision: number;
          lease_token: string | null; lease_until: string | null; content_revision: number; evidence_hash: string; evidence_snapshot_id: number | null; attempts: number;
        }>();
      if (!job) return { failure: "not_found" as const };
      if (job.status === "completed") return { failure: "already_completed" as const };
      // Legacy consumers (pre-v2 handshake) do not send target fields. Only
      // enforce them when the job is bound to a v2 target; the job is still
      // bound to the active generation, so a stale worker cannot win.
      const declaredGeneration = body.target_generation === undefined ? job.target_generation : Number(body.target_generation);
      const declaredSpec = body.spec_id === undefined ? job.spec_id : String(body.spec_id);
      if (declaredGeneration !== job.target_generation || declaredSpec !== job.spec_id ||
        job.target_generation !== target.generation) {
        return { failure: "target_changed" as const };
      }
      if (body.input_revision !== undefined && Number(body.input_revision) !== job.input_revision) {
        return { failure: "input_changed" as const };
      }
      // The consumer echoes the evidence identity it was leased against; a
      // mismatch means the inference saw different material than the job
      // records (R2-02).
      if (body.content_revision !== undefined && Number(body.content_revision) !== job.content_revision) {
        return { failure: "input_changed" as const };
      }
      if (text(body.evidence_hash, 128) && body.evidence_hash !== job.evidence_hash) {
        return { failure: "input_changed" as const };
      }
      if (job.lease_token !== body.lease_token || job.revision !== body.revision ||
        !job.lease_until || job.lease_until <= now) {
        return { failure: "lease_expired" as const };
      }
      const link = await env.DB.prepare(`SELECT content_revision, personal_revision FROM links WHERE id=?`).bind(id)
        .first<{ content_revision: number; personal_revision: number }>();
      if (!link) return { failure: "not_found" as const };
      // One predicate guards every dependent write. It repeats the lease, the
      // bound input identity and the *current* target pointer, so a change
      // between this preflight and the commit cannot produce a success record.
      const guard: WriteGuard = {
        sql: `EXISTS (SELECT 1 FROM classification_jobs WHERE link_id=? AND status='processing' AND lease_token=?
            AND revision=? AND input_revision=? AND lease_until>? AND policy_version=? AND taxonomy_version=?
            AND target_generation=? AND spec_id=?
            AND content_revision=(SELECT content_revision FROM links WHERE id=classification_jobs.link_id))
          AND (SELECT generation FROM classification_target_state WHERE id=1)=?`,
        bindings: [id, String(body.lease_token), Number(body.revision), job.input_revision, now,
          String(result.policy_version), job.taxonomy_version, target.generation, target.spec_id, target.generation]
      };
      const statements: D1PreparedStatement[] = [
        // The guarded writes run first: the predicate requires the job to still
        // be processing, and the job completion below clears that state. All of
        // them share one predicate inside one transaction, so either every
        // dependent write lands or none of them does (R2-01).
        env.DB.prepare(`UPDATE links SET classification=? WHERE id=? AND ${guard.sql} RETURNING id`)
          .bind(JSON.stringify(classification), id, ...guard.bindings)
      ];
      if (isV2 && automatic) {
        const createdAt = new Date().toISOString();
        const runKey = `${key ?? `complete-${id}-${body.revision}`}:run`;
        statements.push(runInsertStatement(env, {
          // The run records the revision bound at claim time, never a newer one
          // read at completion.
          linkId: id, contentRevision: job.content_revision, specId: String(result.spec_id),
          specHash: String(result.spec_hash), targetGeneration: target.generation,
          requestedModel: text(result.requested_model, 200) ? result.requested_model : String(result.model),
          resolvedModel: String(result.model), policyVersion: String(result.policy_version),
          policy: result.policy ?? {}, answers: result.answers, rawJudgments: result.raw_judgments ?? null,
          evidenceSnapshotId: job.evidence_snapshot_id, sourceHash: job.evidence_hash || null,
          usage: result.usage ?? { missing: true },
          attempt: job.attempts,
          operationKey: runKey, coverage: result.coverage === "partial" ? "partial" : "complete",
          evidenceCoverage: text(result.evidence_coverage, 40) ? result.evidence_coverage : "",
          aliasDrift: result.alias_drift === true, createdAt, payloadHash
        }, guard));
        statements.push(decisionInsertStatement(env, {
          linkId: id, runOperationKey: runKey, contentRevision: job.content_revision,
          policyVersion: String(result.policy_version), policy: result.policy ?? {}, automatic,
          operationKey: `${key ?? `complete-${id}-${body.revision}`}:decision`, createdAt, payloadHash
        }, guard));
      }
      const finalize = env.DB.prepare(`UPDATE classification_jobs SET status='completed',result=?,error=NULL,
        lease_token=NULL,lease_until=NULL,updated_at=? WHERE link_id=? AND ${guard.sql} RETURNING link_id`)
        .bind(JSON.stringify({ ...result, classification }), now, id, ...guard.bindings);
      return { statements, finalize, guardIndex: 0, operationGuard: guard, response: { id }, body: { id, status: "completed" } };
    });
    // The derived projection converges immediately after the atomic commit;
    // it is a cache, never a source of truth.
    if (response.status === 200) await rebuildProjection(env, id);
    return response;
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

// refreshSource explicitly re-arms the *retrieval* queue for a link. It is
// deliberately different from a classification retry and from a policy replay:
// it schedules a bounded fetch, keeps the old readable content and all human
// curation until a new source actually arrives, and does not call a model
// itself (F13).
export async function refreshSource(env: Env, id: number): Promise<Response> {
  const link = await env.DB.prepare(`SELECT id, content_revision, enrichment_status FROM links WHERE id = ?`).bind(id)
    .first<{ id: number; content_revision: number; enrichment_status: string }>();
  if (!link) return fail("not_found");
  if (link.enrichment_status === "processing") {
    // Never preempt an active retrieval lease; the caller can retry later.
    return fail("lease_conflict");
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE links SET enrichment_status='pending', enrichment_attempts=0, enrichment_next_retry_at=NULL,
       enrichment_lease_token=NULL, enrichment_lease_until=NULL, enrichment_error=NULL, enrichment_updated_at=?
     WHERE id=? AND enrichment_status<>'processing'`
  ).bind(now, id).run();
  return reply({
    id, status: "pending", action: "refresh_source", content_revision: link.content_revision,
    preserves: ["original_text", "translated_text", "summary", "images", "curation", "why", "classification"]
  });
}

// ackSourceRefresh consumes the one-shot refresh intent. It is called by the
// processor after the fetch attempt, so a failed fetch cannot loop forever
// while the old readable content and human data are kept (R2-06).
export async function ackSourceRefresh(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body || !Number.isSafeInteger(body.epoch) || !["completed", "failed", "blocked"].includes(String(body.status))) {
    return fail("invalid_source");
  }
  const epoch = Number(body.epoch);
  const reason = text(body.reason, 500) ? body.reason : null;
  const row = await env.DB.prepare(
    `UPDATE links SET refresh_requested_at=NULL,
       enrichment_error=CASE WHEN ?='completed' THEN enrichment_error ELSE ? END
     WHERE id=? AND refresh_epoch=? RETURNING id`
  ).bind(String(body.status), reason, id, epoch).first();
  if (!row) return fail("not_found");
  return reply({ id, status: body.status, epoch });
}

// (the evidence read by snapshot id lives in domain-routes; see latestSnapshot)

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
    env.DB.prepare(`UPDATE links SET original_text=?,original_language=?,source_context_text=?,related_links=?,
      ai_title=NULL,translated_text=NULL,summary=NULL,images=CASE WHEN original_text IS ? THEN images ELSE '[]' END,
      enrichment_updated_at=? WHERE ${guard} RETURNING id`)
      .bind(source.original_text, source.original_language || null, source.context_text, JSON.stringify(source.related_links), source.original_text, now, id, body.lease_token, now),
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
