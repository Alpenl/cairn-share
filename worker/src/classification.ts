import { historicalCatalog, managedCatalog } from "./tag-catalog";
import { CLASSIFICATION_LIMITS, classificationBudgetAvailable, classificationWindow, validClassificationLimits } from "./classification-budget";
import { validEnrichmentSource } from "./source-validation";
import { validRunProvenance } from "./run-provenance";
import type { Env } from "./index";
import { personalUse, record, taxonomy, validateClassification, type Classification } from "./curation";
import { classificationTaxonomy, taxonomyV2, type TermDefinition } from "./taxonomy-v2";
import { contentHash, objectivePayload, objectiveUseAllowed, validAssessment,
  type AutomaticView, type EvidenceSnapshot } from "./domain";
import { completionProjectionPlan, decisionInsertStatement, rebuildProjection, runInsertStatement, type WriteGuard } from "./domain-routes";

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
export type ClassificationGateEvent = { action: "opened" | "probe_started" | "closed" };
const X_LINK_SQL = `(
  lower(url) LIKE 'https://x.com/%' OR lower(url) LIKE 'http://x.com/%'
  OR lower(url) LIKE 'https://www.x.com/%' OR lower(url) LIKE 'http://www.x.com/%'
  OR lower(url) LIKE 'https://twitter.com/%' OR lower(url) LIKE 'http://twitter.com/%'
  OR lower(url) LIKE 'https://www.twitter.com/%' OR lower(url) LIKE 'http://www.twitter.com/%'
)`;

// Typed failure classes. The consumer must not have to guess from a bare HTTP
// status: a 409 could be a lost lease, a changed target, a stale input or a
// duplicate completion, and those need different recovery. Each code maps to
// exactly one class and one HTTP status.
export type ClassificationErrorCode =
  | "budget_exhausted"
  | "component_paused"
  | "capability_mismatch"
  | "target_changed"
  | "input_changed"
  | "lease_expired"
  | "already_completed"
  | "operation_conflict"
  | "invalid_classification"
  | "invalid_classification_config"
  | "invalid_source"
  | "manual_queue_full"
  | "invalid_operation_key"
  | "configuration_error"
  | "lease_conflict"
  | "provider_result_unknown"
  | "not_found"
  | "method_not_allowed"
  | "invalid_json";

const ERROR_STATUS: Record<ClassificationErrorCode, number> = {
  budget_exhausted: 429,
  component_paused: 503,
  capability_mismatch: 409,
  target_changed: 409,
  input_changed: 409,
  lease_expired: 409,
  already_completed: 409,
  operation_conflict: 409,
  invalid_classification: 400,
  invalid_classification_config: 400,
  invalid_source: 400,
  manual_queue_full: 429,
  invalid_operation_key: 400,
  configuration_error: 500,
  lease_conflict: 409,
  provider_result_unknown: 409,
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
  gateTransitionIndex?: number;
  onGateTransition?: () => void;
};

async function idempotent<T extends { id: number }>(
  env: Env,
  key: string | null,
  payloadHash: string,
  linkID: number,
  commit: () => Promise<CommitOutcome<T> | { failure: ClassificationErrorCode }>,
  repairReplay?: () => Promise<void>
): Promise<Response> {
  const replayExisting = async (): Promise<Response | null> => {
    if (key === null) return null;
    const existing = await readOperation(env, key, linkID);
    if (existing) {
      if (existing.link_id !== linkID) return fail("operation_conflict", { reason: "operation_key belongs to another bookmark" });
      if (existing.payload_hash !== payloadHash) return fail("operation_conflict");
      if (repairReplay) await repairReplay();
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
    if (outcome.gateTransitionIndex !== undefined &&
      Number(results[outcome.gateTransitionIndex]?.meta.changes) === 1) {
      try { outcome.onGateTransition?.(); } catch { /* optional telemetry cannot change a committed result */ }
    }
  } catch (error) {
    // The only expected failure is the operation-key UNIQUE constraint from a
    // concurrent duplicate. Re-read it: an identical payload replays, a
    // different payload or link is a conflict, and any other error is re-raised.
    if (key === null) throw error;
    const existing = await readOperation(env, key, linkID);
    if (existing && existing.link_id === linkID && existing.payload_hash === payloadHash) {
      if (repairReplay) await repairReplay();
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
    return entry.every((item) => typeof item === "string" && item.length > 0 && item.length <= 80) &&
      new Set(entry).size === entry.length ? entry as string[] : null;
  };
  const topics = list(value.topics, 64);
  const contentFunctions = list(value.content_functions, 8);
  const carriers = list(value.carriers, 1);
  const affordances = list(value.affordances, 8);
  const resources = value.resource_kinds === undefined ? undefined : list(value.resource_kinds, 6);
  const entities = list(value.entities, 10);
  if (!topics || !contentFunctions || !carriers || !affordances || !entities) return null;
  if (resources === null) return null;
  if (value.assessment !== undefined && !validAssessment(value.assessment)) return null;
  return {
    ...(value.assessment === undefined ? {} : { assessment: value.assessment }),
    topics, content_functions: contentFunctions, carriers, affordances, entities,
    ...(resources ? { resource_kinds: resources } : {}),
    form: typeof value.form === "string" && value.form.length <= 40 ? value.form : "",
    use: typeof value.use === "string" && value.use.length <= 40 ? value.use : ""
  };
}

// The legacy fields are a projection of this same automatic decision, never a
// second model result. Check against the target's vocabulary, including its
// historical active status, rather than today's display catalog.
async function validAutomaticProjection(env: Env, classification: Classification, automatic: AutomaticView, version: string): Promise<boolean> {
  if (JSON.stringify(classification.topics) !== JSON.stringify(automatic.topics.slice(0, 3)) ||
    classification.form !== automatic.form || classification.use !== automatic.use) return false;
  const catalog = await historicalCatalog(env, version);
  if (!catalog) return false;
  const active = (terms: TermDefinition[] | undefined, ids: string[]) => ids.every(id =>
    terms?.some(term => term.id === id && term.active && !term.deprecated && term.ai_enabled !== false));
  return active(catalog.topics, automatic.topics) && active(catalog.resource_kinds, automatic.resource_kinds ?? []) &&
    active(catalog.content_functions, automatic.content_functions) && active(catalog.carriers, automatic.carriers) &&
    active(catalog.affordances, automatic.affordances) && active(catalog.forms, automatic.form ? [automatic.form] : []) &&
    active(catalog.uses, automatic.use ? [automatic.use] : []);
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
  new_items_only: number;
};

async function activeTarget(env: Env): Promise<Target | null> {
  return env.DB.prepare(
    `SELECT t.generation, t.spec_id, t.spec_hash, t.taxonomy_version, t.policy_version,
            t.requested_model, t.protocol, t.new_items_only
     FROM classification_target_state s JOIN classification_targets t ON t.generation = s.generation
     WHERE s.id = 1`
  ).first<Target>();
}

async function registeredTargetSpec(env: Env, target: Target): Promise<boolean> {
  if (target.protocol !== "v2") return true;
  const row = await env.DB.prepare("SELECT spec_hash FROM question_specs WHERE spec_id=?")
    .bind(target.spec_id).first<{ spec_hash: string }>();
  return row?.spec_hash === target.spec_hash;
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
export async function classificationRoute(request: Request, env: Env, path: string,
  onGate?: (event: ClassificationGateEvent) => void): Promise<Response> {
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
    const response = reply({ target, supported: request.headers.get("X-Cairn-Classification-Budget") === "1" &&
      supports(fromQuery, target) && await registeredTargetSpec(env, target) });
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
    if (body.protocol === "v2" && (!text(body.policy_version, 100) || !text(body.requested_model, 200) ||
      !await registeredTargetSpec(env, body as Target))) return fail("invalid_classification_config");
    if (body.new_items_only !== undefined && typeof body.new_items_only !== "boolean") return fail("invalid_classification_config");
    if (body.taxonomy_version.startsWith("managed-") && ((await managedCatalog(env)).catalog.version !== body.taxonomy_version || body.new_items_only !== true)) return fail("invalid_classification_config");
    const current = await activeTarget(env);
    if (!current) return fail("configuration_error");
    if (body.expected_generation !== undefined && body.expected_generation !== current.generation) {
      return fail("target_changed", { generation: current.generation });
    }
    if (current.spec_id === body.spec_id && current.spec_hash === body.spec_hash &&
      current.protocol === body.protocol && current.policy_version === body.policy_version &&
      current.requested_model === body.requested_model && current.taxonomy_version === body.taxonomy_version) {
      return reply({ generation: current.generation, unchanged: true });
    }
    const generation = current.generation + 1;
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO classification_targets(generation, spec_id, spec_hash, taxonomy_version, policy_version, requested_model, protocol, created_at, note, new_items_only)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT generation FROM classification_target_state WHERE id=1)=?`
      ).bind(generation, body.spec_id, body.spec_hash, body.taxonomy_version, body.policy_version,
        body.requested_model, body.protocol, now, typeof body.note === "string" ? body.note.slice(0, 500) : null, body.new_items_only === true ? 1 : 0, current.generation),
      env.DB.prepare(`UPDATE classification_target_state SET generation = ?, updated_at = ? WHERE id = 1 AND generation=? AND EXISTS(SELECT 1 FROM classification_targets WHERE generation=?)`)
        .bind(generation, now, current.generation, generation)
    ]);
    const saved = await activeTarget(env);
    if (saved?.generation !== generation || saved.spec_id !== body.spec_id) return fail("target_changed", { generation: saved?.generation });
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
    const gateAware = request.headers.get("X-Cairn-Classification-Gate") === "1";
    const target = await activeTarget(env);
    if (!target) return fail("configuration_error");
    if (!await registeredTargetSpec(env, target)) return fail("configuration_error");
    if (body.expected_generation !== undefined && body.expected_generation !== target.generation) {
      return fail("target_changed", { generation: target.generation });
    }
    // The consumer declares capabilities; it never defines the target. A
    // mismatch is a component-level condition and must not drain the queue or
    // burn attempts.
    if (request.headers.get("X-Cairn-Classification-Budget") !== "1" || !supports(body as Capabilities, target)) {
      return fail("capability_mismatch", { target_generation: target.generation, protocol: target.protocol });
    }
    const budgetLimits = body.budget_limits ?? CLASSIFICATION_LIMITS;
    if (!validClassificationLimits(budgetLimits, env)) return fail("invalid_classification_config");
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
    const jobStatement = env.DB.prepare(`UPDATE classification_jobs SET status='processing',
      attempts=CASE WHEN target_generation<>? THEN 1 ELSE attempts+1 END,
      lease_token=?, lease_until=?, next_retry_at=NULL, error=NULL,
      target_generation=?, spec_id=?, taxonomy_version=?, policy_version=?, requested_model=?, updated_at=?,
      component_epoch=(SELECT epoch FROM enrichment_component_gates WHERE component='classification'),
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
        AND (j.target_generation<>? AND (?=0 OR j.status<>'completed')
          OR (j.attempts<5 AND (j.status='pending' OR (j.status='failed' AND j.next_retry_at<=?)
            OR (j.status='processing' AND j.lease_until<=?))))
        ORDER BY COALESCE(j.updated_at,''), j.link_id LIMIT 1)
      AND (SELECT generation FROM classification_target_state WHERE id=1)=?
      AND (SELECT COUNT(*) FROM budget_ledger b WHERE b.scope='classification_global' AND b.created_at>=? AND b.created_at<?) < ?
      AND (SELECT COALESCE(SUM(json_extract(b.units,'$.tokens')),0) FROM budget_ledger b WHERE b.scope='classification_global' AND b.created_at>=? AND b.created_at<?)+65536 <= ?
      AND EXISTS(SELECT 1 FROM enrichment_component_gates g WHERE g.component='classification'
        AND (g.state='closed' OR (g.state='open' AND g.retry_at<=?)
          OR (g.state='probing' AND g.probe_until<=?)))
      RETURNING link_id AS id, revision, input_revision, attempts AS attempt, lease_token, lease_until,
                target_generation, spec_id, content_revision, evidence_snapshot_id, evidence_hash,
                component_epoch, (SELECT state FROM enrichment_component_gates WHERE component='classification') AS gate_state`)
      .bind(target.generation, token, until,
        target.generation, target.spec_id, boundTaxonomy, boundPolicy, boundModel, now,
        budgetWindow.start, budgetWindow.end, budgetLimits.max_calls_per_item, budgetWindow.start, budgetWindow.end, budgetLimits.max_tokens_per_item,
        isLegacy ? 1 : 0, now, target.generation, target.new_items_only ?? 0, now, now, target.generation,
        budgetWindow.start, budgetWindow.end, budgetLimits.max_calls_total, budgetWindow.start, budgetWindow.end, budgetLimits.max_tokens,
        now, now);
    // D1 batch is one SQLite transaction: a half-open job claim and its probe
    // ownership become visible together. An empty queue does not acquire a
    // probe, and another instance cannot claim while this probe owns the gate.
    // Go bounds a classification to five minutes, with the final thirty
    // seconds reserved for its completion write. A live probe must not be
    // replaced while that write can still arrive.
    const gateProbe = env.DB.prepare(`UPDATE enrichment_component_gates SET state='probing',
      probe_token=?,probe_until=?,updated_at=? WHERE component='classification' AND state<>'closed'
      AND EXISTS(SELECT 1 FROM classification_jobs WHERE status='processing' AND lease_token=?)`)
      .bind(token, new Date(Date.now() + 6 * 60_000).toISOString(), now, token);
    const claimResults = await env.DB.batch([jobStatement, gateProbe]);
    if (Number(claimResults[1].meta.changes) === 1) {
      try { onGate?.({ action: "probe_started" }); } catch { /* optional telemetry */ }
    }
    const job = claimResults[0].results[0] as ({ id: number; revision: number; content_revision: number;
      evidence_snapshot_id: number | null; evidence_hash: string; gate_state: string; component_epoch: number }) | undefined;
    if (!job) {
      const gate = await env.DB.prepare(`SELECT state,retry_at,probe_until FROM enrichment_component_gates
        WHERE component='classification'`).first<{ state: string; retry_at: string | null; probe_until: string | null }>();
      const until = gate?.state === 'open' ? gate.retry_at : gate?.state === 'probing' ? gate.probe_until : null;
      if (until && Date.parse(until) > Date.now()) {
        const delay = Date.parse(until) - Date.now();
        const response = fail('component_paused', { retry_after_ms: delay });
        response.headers.set('Retry-After', String(Math.ceil(delay / 1000)));
        return response;
      }
      return new Response(null, { status: 204, headers });
    }
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
    const { gate_state: gateState, ...leased } = job;
    if (!gateAware) {
      const { component_epoch: _componentEpoch, ...legacy } = leased;
      return reply({ ...legacy, ...source, related_links: relatedLinks });
    }
    return reply({ ...leased, component_probe: gateState !== 'closed', ...source, related_links: relatedLinks });
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
    if (record(result.raw_judgments) && result.raw_judgments.metadata_version === 2 &&
      request.headers.get("X-Cairn-Candidate-Manifest") !== "2") return fail("capability_mismatch");
    const isV2 = v2ResultShape(result);
    // A negotiated v2 projection uses its immutable target vocabulary; the old
    // v1 executable taxonomy cannot validate the new stable topic identities.
    const classification = validateClassification(result.classification, isV2);
    if (!classification || (isV2 && personalUse(classification.use)) || !text(result.model, 200) || !text(result.policy_version, 100) || !record(result.answers)) {
      return fail("invalid_classification");
    }
    // A v2 completion must carry its immutable identity and the typed answers,
    // because those are what the replayable run is built from.
    const automatic = isV2 ? automaticView(result.automatic) : null;
    if (isV2 && (!text(result.spec_id, 64) || !text(result.spec_hash, 128) || automatic === null)) {
      return fail("invalid_classification");
    }
    if (isV2 && !await validRunProvenance(env, id, result.raw_judgments, {
      specId: String(result.spec_id), specHash: String(result.spec_hash),
      requestedModel: String(result.requested_model ?? result.model), resolvedModel: String(result.model),
      coverage: result.coverage === "partial" ? "partial" : "complete", answers: result.answers, usage: result.usage ?? { missing: true }, automatic
    })) return fail("invalid_classification");
    const key = operationKey(body);
    // The logical payload identity covers the link, the lease epoch and the
    // full result, so a replayed key with a different payload is a conflict
    // instead of a silent success (R2-12).
    const payloadHash = await sha256Hex(JSON.stringify({ id, revision: body.revision, result }));
    const response = await idempotent(env, key, payloadHash, id, async () => {
      const target = await activeTarget(env);
      if (!target) return { failure: "configuration_error" as const };
      if (isV2 && (classification.taxonomy_version !== target.taxonomy_version ||
        result.spec_id !== target.spec_id || result.spec_hash !== target.spec_hash ||
        (result.requested_model ?? result.model) !== target.requested_model ||
        result.policy_version !== target.policy_version)) return { failure: "target_changed" as const };
      if ((await historicalCatalog(env, target.taxonomy_version))?.resource_kinds !== undefined && (!isV2 ||
        !record(result.raw_judgments) || (result.raw_judgments.metadata_version !== 1 && result.raw_judgments.metadata_version !== 2) ||
        automatic?.resource_kinds === undefined)) return { failure: "invalid_classification" as const };
      if (isV2 && automatic && !await validAutomaticProjection(env, classification, automatic, target.taxonomy_version)) {
        return { failure: "invalid_classification" as const };
      }
      // Reject completions that no longer match the active target *before*
      // touching storage, so a stale worker cannot overwrite the projection.
      const job = await env.DB.prepare(`SELECT status, target_generation, spec_id, taxonomy_version, revision, input_revision, lease_token, lease_until, content_revision, evidence_hash, evidence_snapshot_id, attempts, component_epoch
        FROM classification_jobs WHERE link_id=?`).bind(id).first<{
          status: string; target_generation: number; spec_id: string; taxonomy_version: string; revision: number; input_revision: number;
          lease_token: string | null; lease_until: string | null; content_revision: number; evidence_hash: string; evidence_snapshot_id: number | null; attempts: number; component_epoch: number;
        }>();
      if (!job) return { failure: "not_found" as const };
      if (job.status === "completed") return { failure: "already_completed" as const };
      // Legacy consumers (pre-v2 handshake) do not send target fields. Only
      // enforce them when the job is bound to a v2 target; the job is still
      // bound to the active generation, so a stale worker cannot win.
      const declaredGeneration = body.target_generation === undefined ? job.target_generation : Number(body.target_generation);
      const declaredSpec = body.spec_id === undefined ? job.spec_id : String(body.spec_id);
      if (declaredGeneration !== job.target_generation || declaredSpec !== job.spec_id ||
        job.target_generation !== target.generation || (isV2 && job.spec_id !== result.spec_id)) {
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
      const completeKey = key ?? `complete-${id}-${body.revision}`;
      const runKey = `${completeKey}:run`;
      const decisionKey = `${completeKey}:decision`;
      const plan = await completionProjectionPlan(env, id, classification, automatic,
        isV2 ? decisionKey : null, payloadHash, guard);
      if (!plan) return { failure: "not_found" as const };
      const statements: D1PreparedStatement[] = [
        // The read-only first statement records whether all precomputed inputs
        // still match. Every write uses the same pre- or post-decision guard.
        env.DB.prepare(`SELECT ? AS id WHERE ${plan.preGuard.sql}`).bind(id, ...plan.preGuard.bindings)
      ];
      if (isV2 && automatic) {
        const createdAt = new Date().toISOString();
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
        }, plan.preGuard));
        statements.push(decisionInsertStatement(env, {
          linkId: id, runOperationKey: runKey, contentRevision: job.content_revision,
          policyVersion: String(result.policy_version), policy: result.policy ?? {}, automatic,
          operationKey: decisionKey, createdAt, payloadHash
        }, plan.preGuard, false));
      }
      statements.push(...plan.statements);
      // A successful model result closes only the half-open probe that owns
      // this exact lease and epoch. A success from an older in-flight job must
      // never clear a newer provider outage.
      statements.push(env.DB.prepare(`UPDATE enrichment_component_gates SET state='closed',
        epoch=epoch+1,failures=0,retry_at=NULL,probe_token=NULL,probe_until=NULL,reason=NULL,updated_at=?
        WHERE component='classification' AND state='probing' AND probe_token=? AND epoch=?
          AND ${plan.postGuard.sql}`).bind(now, String(body.lease_token), job.component_epoch, ...plan.postGuard.bindings));
      const gateTransitionIndex = statements.length - 1;
      const finalize = env.DB.prepare(`UPDATE classification_jobs SET status='completed',result=?,error=NULL,
        lease_token=NULL,lease_until=NULL,updated_at=? WHERE link_id=? AND ${plan.postGuard.sql} RETURNING link_id`)
        .bind(JSON.stringify({ ...result, classification }), now, id, ...plan.postGuard.bindings);
      return { statements, finalize, guardIndex: 0, operationGuard: plan.postGuard,
        response: { id }, body: { id, status: "completed" }, gateTransitionIndex,
        onGateTransition: () => onGate?.({ action: "closed" }) };
    }, () => rebuildProjection(env, id));
    return response;
  }
  if (match[2] === "fail") {
    if (!text(body.error, 1800)) return fail("invalid_classification");
    if (body.component_fault !== undefined && body.component_fault !== "provider_transient") return fail("invalid_classification");
    const retryAfterMS = body.retry_after_ms;
    if (retryAfterMS !== undefined &&
      (typeof retryAfterMS !== "number" || !Number.isSafeInteger(retryAfterMS) || retryAfterMS < 0)) return fail("invalid_classification");
    const job = await env.DB.prepare(`SELECT status, attempts, target_generation, spec_id, revision, input_revision, lease_token, lease_until, component_epoch
      FROM classification_jobs WHERE link_id=?`).bind(id).first<{
        status: string; attempts: number; target_generation: number; spec_id: string; revision: number; input_revision: number;
        lease_token: string | null; lease_until: string | null; component_epoch: number;
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
      await env.DB.batch([
        env.DB.prepare(`UPDATE enrichment_component_gates SET state='open',probe_token=NULL,probe_until=NULL,
          retry_at=CASE WHEN retry_at>? THEN retry_at ELSE ? END,updated_at=?
          WHERE component='classification' AND state='probing' AND probe_token=? AND epoch=?`)
          .bind(now, now, now, body.lease_token, job.component_epoch),
        env.DB.prepare(`UPDATE classification_jobs SET status='pending', lease_token=NULL, lease_until=NULL,
          next_retry_at=NULL, updated_at=? WHERE link_id=? AND lease_token=?`)
          .bind(now, id, body.lease_token)
      ]);
      return reply({ id, status: "superseded" });
    }
    const status = job.attempts >= 5 ? "exhausted" : "failed";
    const baseDelay = [60_000, 300_000, 1800_000, 7200_000][Math.min(job.attempts - 1, 3)];
    // Persist a bounded, spread-out retry time. TypeSafe may send either
    // Retry-After header; Go converts it to milliseconds before reporting.
    // The provider hint cannot reduce the queue's existing attempt backoff.
    const jitter = Math.floor(baseDelay * 0.2 * crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000);
    const providerDelay = Math.min(typeof retryAfterMS === "number" ? retryAfterMS : 0, 600_000);
    const delay = Math.min(7200_000, Math.max(baseDelay + jitter, providerDelay));
    const retry = status === "exhausted" ? null : new Date(Date.now() + delay).toISOString();
    const jobFailure = env.DB.prepare(`UPDATE classification_jobs SET status=?,error=?,next_retry_at=?,
      lease_token=NULL,lease_until=NULL,updated_at=? WHERE link_id=? AND status='processing'
      AND lease_token=? AND revision=? AND lease_until>? RETURNING link_id`)
      .bind(status, body.error, retry, now, id, body.lease_token, body.revision, now);
    let row: unknown;
    const gate = await env.DB.prepare(`SELECT state,epoch,failures,probe_token FROM enrichment_component_gates
      WHERE component='classification'`).first<{ state: string; epoch: number; failures: number; probe_token: string | null }>();
    const probeFailed = gate?.state === "probing" && gate.probe_token === body.lease_token &&
      gate.epoch === job.component_epoch;
    if (body.component_fault === "provider_transient" || probeFailed) {
      const backoff = Math.min(600_000, 30_000 * 2 ** Math.min(gate?.failures ?? 0, 5));
      const gateRetry = new Date(Date.now() + Math.max(backoff, providerDelay)).toISOString();
      const results = await env.DB.batch([
        env.DB.prepare(`UPDATE enrichment_component_gates SET state='open',epoch=epoch+1,failures=MIN(failures+1,6),
          retry_at=?,probe_token=NULL,probe_until=NULL,reason=?,updated_at=?
          WHERE component='classification' AND epoch=?
          AND EXISTS(SELECT 1 FROM classification_jobs WHERE link_id=? AND status='processing'
            AND lease_token=? AND revision=? AND lease_until>?
            AND target_generation=(SELECT generation FROM classification_target_state WHERE id=1))`)
          .bind(gateRetry, body.component_fault === "provider_transient" ? "provider_transient" : "probe_failed",
            now, job.component_epoch, id, body.lease_token, body.revision, now),
        jobFailure
      ]);
      if (Number(results[0].meta.changes) === 1) {
        try { onGate?.({ action: "opened" }); } catch { /* optional telemetry */ }
      }
      row = results[1].results[0];
    } else {
      row = await jobFailure.first();
    }
    return row ? reply({ id, status }) : fail("lease_expired");
  }
  return fail("not_found");
}

// Kept as a tombstone for legacy clients. Source updates must come from a
// browser capture (or the existing explicit manual repair route).
export async function refreshSource(_request: Request, _env: Env, _id: number): Promise<Response> {
  return new Response(JSON.stringify({ error: "capture_required" }), { status: 410, headers });
}

// ackSourceRefresh consumes an unsuccessful one-shot fetch intent. A successful
// source checkpoint clears that intent in its own write transaction, so a lost
// ack response cannot schedule another paid retrieval (R2-06).
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
     WHERE id=? AND refresh_epoch=? AND refresh_requested_at IS NOT NULL RETURNING id`
  ).bind(String(body.status), reason, id, epoch).first();
  if (row) return reply({ id, status: body.status, epoch });
  // The ack response may have been lost, or the source checkpoint may have
  // consumed the intent first. Neither case may rewrite a completed refresh.
  const current = await env.DB.prepare(
    `SELECT refresh_epoch,refresh_requested_at FROM links WHERE id=?`
  ).bind(id).first<{ refresh_epoch: number; refresh_requested_at: string | null }>();
  if (current?.refresh_epoch === epoch && current.refresh_requested_at === null) {
    return reply({ id, status: "already_consumed", epoch });
  }
  return fail("not_found");
}

const MAX_PENDING_MANUAL = 100;
const pendingManualCount = `SELECT COUNT(*) FROM links INDEXED BY links_manual_priority_idx
  WHERE manual_priority=1 AND enrichment_status IN ('pending','failed','processing')
    AND enrichment_status='pending'`;
const manualQueueFull = () => new Response(JSON.stringify({ error: "manual_queue_full" }), {
  status: 429, headers: { ...headers, "Retry-After": "5" }
});

// A manual rerun is durable queue state. Repeated requests for the same link
// coalesce; the common scheduler takes capacity before it claims the lease.
export async function manualEnqueueRoute(request: Request, env: Env, id: number,
  onResolved?: (outcome: "accepted" | "replay") => void): Promise<Response> {
  const body = await bodyOf(request);
  if (!body || !text(body.operation_key, 200)) return fail("invalid_operation_key");
  const key = body.operation_key;
  const readReceipt = async () => env.DB.prepare(`SELECT link_id,kind FROM manual_request_operations
    WHERE operation_key=?`).bind(key).first<{ link_id: number; kind: string }>();
  const replay = (receipt: { link_id: number; kind: string } | null) => receipt
    ? receipt.link_id === id && receipt.kind === "process"
      ? reply({ id, status: "pending", action: "manual_process" })
      : fail("operation_conflict")
    : null;
  const prior = replay(await readReceipt());
  if (prior) {
    if (prior.status === 200) onResolved?.("replay");
    return prior;
  }
  const now = new Date().toISOString();
  let results: D1Result<Record<string, unknown>>[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO manual_request_operations(operation_key,link_id,kind,created_at)
        SELECT ?,id,'process',? FROM links WHERE id=? AND ${X_LINK_SQL}
          AND original_text IS NOT NULL AND original_text<>''
          AND enrichment_paid_uncertain=0
          AND NOT (enrichment_status='processing' AND enrichment_lease_token IS NOT NULL
            AND enrichment_lease_until>?)
          AND (manual_priority=1 OR (${pendingManualCount})<?)
        RETURNING operation_key`).bind(key, now, id, now, MAX_PENDING_MANUAL),
      env.DB.prepare(`UPDATE links SET enrichment_status='pending',
        enrichment_attempts=0,enrichment_next_retry_at=NULL,enrichment_lease_token=NULL,
        enrichment_lease_until=NULL,enrichment_error=NULL,enrichment_updated_at=?,manual_priority=1
        WHERE id=? AND enrichment_paid_uncertain=0 AND EXISTS (SELECT 1 FROM manual_request_operations
          WHERE operation_key=? AND link_id=? AND kind='process')
        RETURNING id`).bind(now, id, key, id)
    ]);
  } catch (error) {
    const raced = replay(await readReceipt());
    if (raced) {
      if (raced.status === 200) onResolved?.("replay");
      return raced;
    }
    throw error;
  }
  if (results[0].results.length && results[1].results.length) {
    onResolved?.("accepted");
    return reply({ id, status: "pending", action: "manual_process" });
  }
  if (results[0].results.length || results[1].results.length) {
    throw Error("manual enqueue transaction was incomplete");
  }
  const link = await env.DB.prepare(`SELECT CASE WHEN ${X_LINK_SQL} THEN 1 ELSE 0 END AS processable,
    enrichment_status, enrichment_lease_token, enrichment_lease_until,
    enrichment_paid_uncertain,original_text FROM links WHERE id=?`)
    .bind(id).first<{ processable: number; enrichment_status: string;
      enrichment_lease_token: string | null; enrichment_lease_until: string | null;
      enrichment_paid_uncertain: number; original_text: string | null }>();
  if (!link) return fail("not_found");
  if (!link.processable) return fail("input_changed");
  if (!link.original_text) return new Response(JSON.stringify({error:"capture_required"}), {status:409,headers});
  if (link.enrichment_status === "processing" && link.enrichment_lease_token &&
    link.enrichment_lease_until && link.enrichment_lease_until > now) return fail("lease_conflict");
  if (link.enrichment_paid_uncertain === 1) return fail("provider_result_unknown");
  return manualQueueFull();
}

// Manual text becomes a durable source before the caller receives success. The
// active retrieval lease is left alone. An expired lease is fenced in the same
// transaction; reading can claim the new source later, and classification can
// start from the saved evidence without waiting for reading.
export async function manualSourceRoute(request: Request, env: Env, id: number,
  onResolved?: (outcome: "accepted" | "replay") => void): Promise<Response> {
  const body = await bodyOf(request);
  if (!body || !text(body.operation_key, 200) || !Number.isSafeInteger(body.expected_revision) ||
    Number(body.expected_revision) < 0 || !text(body.original_text, 100_000)) return fail("invalid_source");
  // bodyOf bounds the incoming JSON to 1 MiB. This endpoint has the smaller
  // dashboard request limit and uses byte length, not JavaScript characters.
  const sourceText = body.original_text;
  if (!sourceText.trim() || new TextEncoder().encode(sourceText).byteLength > 100_000 ||
    new TextEncoder().encode(JSON.stringify(body)).byteLength > (128 << 10)) return fail("invalid_source");
  const key = body.operation_key;
  const expected = Number(body.expected_revision);
  const payloadHash = await sha256Hex(JSON.stringify({ id, expected, sourceText }));
  const existing = async () => env.DB.prepare(
    `SELECT link_id, payload_hash, result_revision FROM manual_source_operations WHERE operation_key=?`
  ).bind(key).first<{ link_id: number; payload_hash: string; result_revision: number | null }>();
  const replay = (row: { link_id: number; payload_hash: string; result_revision: number | null } | null) => {
    if (!row) return null;
    if (row.link_id !== id || row.payload_hash !== payloadHash || row.result_revision === null) return fail("operation_conflict");
    return reply({ id, status: "source_saved", content_revision: row.result_revision });
  };
  const prior = replay(await existing());
  if (prior) {
    if (prior.status === 200) onResolved?.("replay");
    return prior;
  }

  const now = new Date().toISOString();
  const source = { original_text: sourceText, original_language: "", context_text: "",
    related_links: [] as string[], image_urls: [] as string[], model: "manual" };
  const snapshot: EvidenceSnapshot = {
    blocks: [{ id: "primary-1", role: "primary", text: sourceText, acquired: "manual" }],
    fetched_at: now, retrieval: "manual", truncation: { truncated: false }
  };
  const evidenceHash = await contentHash(snapshot);
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO manual_source_operations(operation_key,link_id,payload_hash,expected_revision,created_at)
        SELECT ?,id,?,?,? FROM links WHERE id=? AND content_revision=? AND ${X_LINK_SQL}
          AND NOT (enrichment_status='processing' AND enrichment_lease_token IS NOT NULL
            AND enrichment_lease_until>?)
          AND (manual_priority=1 OR (${pendingManualCount})<?)
        RETURNING operation_key`).bind(key, payloadHash, expected, now, id, expected, now, MAX_PENDING_MANUAL),
      env.DB.prepare(`UPDATE links SET original_text=?,original_language=NULL,source_context_text='',related_links='[]',
          ai_title=NULL,translated_text=NULL,summary=NULL,images='[]',enrichment_model=NULL,enriched_at=NULL,
          enrichment_status='pending',enrichment_attempts=0,enrichment_next_retry_at=NULL,
          enrichment_lease_token=NULL,enrichment_lease_until=NULL,enrichment_error=NULL,
          enrichment_paid_uncertain=0,enrichment_paid_stage=NULL,
          enrichment_updated_at=?,refresh_epoch=refresh_epoch+1,refresh_requested_at=NULL,
          manual_priority=1
        WHERE id=? AND content_revision=? AND EXISTS
          (SELECT 1 FROM manual_source_operations WHERE operation_key=? AND link_id=?)
        RETURNING id`).bind(sourceText, now, id, expected, key, id),
      // A deliberate manual submission changes objective provenance even when
      // the primary bytes match. The regular content trigger already bumps a
      // changed text/context/links; this statement bumps only the equal case.
      env.DB.prepare(`UPDATE links SET content_revision=content_revision+1
        WHERE id=? AND content_revision=? AND EXISTS
          (SELECT 1 FROM manual_source_operations WHERE operation_key=? AND link_id=?)`)
        .bind(id, expected, key, id),
      env.DB.prepare(`INSERT INTO enrichment_sources(link_id,url,original_text,payload,fetched_at)
        SELECT l.id,l.url,?,?,? FROM links l JOIN manual_source_operations o ON o.link_id=l.id
        WHERE o.operation_key=? AND l.id=?
        ON CONFLICT(link_id) DO UPDATE SET url=excluded.url,original_text=excluded.original_text,
          payload=excluded.payload,fetched_at=excluded.fetched_at`)
        .bind(sourceText, JSON.stringify(source), now, key, id),
      env.DB.prepare(`INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,truncated,completeness,created_at)
        SELECT l.id,l.content_revision,?,?,0,'complete',? FROM links l
        JOIN manual_source_operations o ON o.link_id=l.id
        WHERE o.operation_key=? AND l.id=? RETURNING id`)
        .bind(evidenceHash, objectivePayload(snapshot), now, key, id),
      env.DB.prepare(`UPDATE manual_source_operations SET result_revision=
        (SELECT content_revision FROM links WHERE id=?) WHERE operation_key=? AND link_id=?
        RETURNING result_revision`).bind(id, key, id)
    ]);
    if (!results[0].results.length) {
      const link = await env.DB.prepare(`SELECT content_revision,
        CASE WHEN ${X_LINK_SQL} THEN 1 ELSE 0 END AS processable,
        enrichment_status, enrichment_lease_token,
        enrichment_lease_until FROM links WHERE id=?`).bind(id).first<{
          content_revision: number; processable: number;
          enrichment_status: string; enrichment_lease_token: string | null;
          enrichment_lease_until: string | null;
        }>();
      if (!link) return fail("not_found");
      if (link.enrichment_status === "processing" && link.enrichment_lease_token &&
        link.enrichment_lease_until && link.enrichment_lease_until > now) return fail("lease_conflict");
      if (link.content_revision !== expected || !link.processable) return fail("input_changed");
      return manualQueueFull();
    }
    if (!results[1].results.length || !results[3].success || !results[4].results.length || !results[5].results.length) {
      throw Error("manual source transaction was incomplete");
    }
    const revision = (results[5].results[0] as { result_revision: number }).result_revision;
    onResolved?.("accepted");
    return reply({ id, status: "source_saved", content_revision: revision });
  } catch (error) {
    const raced = replay(await existing());
    if (raced) {
      if (raced.status === 200) onResolved?.("replay");
      return raced;
    }
    throw error;
  }
}

// (the evidence read by snapshot id lives in domain-routes; see latestSnapshot)

export async function sourceRoute(request: Request, env: Env, id: number,
  onStored?: () => void, onGateClosed?: () => void): Promise<Response> {
  if (request.method === "GET") {
    const row = await env.DB.prepare(`SELECT s.payload FROM enrichment_sources s JOIN links l ON l.id=s.link_id
      WHERE l.id=? AND s.url=l.url AND s.original_text=l.original_text`).bind(id).first<{ payload: string }>();
    return row ? new Response(row.payload, { headers }) : new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") return fail("method_not_allowed");
  const body = await bodyOf(request);
  if (!body || !text(body.lease_token, 100) || !record(body.source)) return fail("invalid_source");
  const source = body.source;
  if (!validEnrichmentSource(source)) {
    return fail("invalid_source");
  }
  const current = await env.DB.prepare("SELECT original_text FROM links WHERE id=?")
    .bind(id).first<{ original_text: string | null }>();
  if (!current) return fail("not_found");
  if (source.model !== "manual" && current.original_text !== source.original_text) {
    return new Response(JSON.stringify({error:"capture_required"}), {status:410,headers});
  }
  const now = new Date().toISOString();
  const leaseHash = await sha256Hex(body.lease_token);
  const guard = "id=? AND enrichment_status='processing' AND enrichment_lease_token=? AND enrichment_lease_until>?";
  const paidGuard = `${guard} AND (enrichment_paid_stage IS NULL OR
    (enrichment_paid_stage='fetch' AND EXISTS
      (SELECT 1 FROM enrichment_provider_attempts a WHERE a.link_id=links.id
       AND a.lease_hash=? AND a.content_revision=links.content_revision
       AND a.stage='fetch' AND a.state='responded' AND a.http_status=200)
     AND NOT EXISTS (SELECT 1 FROM enrichment_provider_attempts a WHERE a.link_id=links.id
       AND a.lease_hash=? AND a.stage='fetch' AND a.state='reserved')))`;
  // The successful source write also consumes the matching refresh intent.
  // A newer refresh cannot be accepted during this live lease; both the source
  // and this state transition roll back if the following source upsert fails.
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE links SET original_text=?,original_language=?,source_context_text=?,related_links=?,
      ai_title=NULL,translated_text=NULL,summary=NULL,images=CASE WHEN original_text IS ? THEN images ELSE '[]' END,
      enrichment_paid_uncertain=0,enrichment_paid_stage=NULL,
      refresh_requested_at=NULL,enrichment_updated_at=? WHERE ${paidGuard} RETURNING id`)
      .bind(source.original_text, source.original_language || null, source.context_text, JSON.stringify(source.related_links), source.original_text, now, id, body.lease_token, now, leaseHash, leaseHash),
    env.DB.prepare(`INSERT INTO enrichment_sources(link_id,url,original_text,payload,fetched_at)
      SELECT id,url,?,?,? FROM links WHERE ${guard}
        AND enrichment_paid_stage IS NULL AND original_text IS ?
        AND source_context_text IS ? AND json(related_links)=json(?)
      ON CONFLICT(link_id) DO UPDATE SET url=excluded.url,original_text=excluded.original_text,
        payload=excluded.payload,fetched_at=excluded.fetched_at`)
      .bind(source.original_text, JSON.stringify(source), now, id, body.lease_token, now,
        source.original_text, source.context_text, JSON.stringify(source.related_links)),
    env.DB.prepare(`UPDATE enrichment_component_gates SET state='closed',epoch=epoch+1,
      failures=0,retry_at=NULL,probe_token=NULL,probe_until=NULL,reason=NULL,updated_at=?
      WHERE component='source' AND state='probing' AND probe_token=?
        AND EXISTS(SELECT 1 FROM links l JOIN enrichment_sources s ON s.link_id=l.id
          WHERE l.id=? AND l.enrichment_status='processing' AND l.enrichment_lease_token=?
            AND l.enrichment_lease_until>? AND l.original_text=? AND s.url=l.url
            AND s.original_text=l.original_text)
        AND EXISTS(SELECT 1 FROM enrichment_provider_attempts a WHERE a.link_id=?
          AND a.lease_hash=? AND a.stage='fetch' AND a.state='responded' AND a.http_status=200)`)
      .bind(now, body.lease_token, id, body.lease_token, now, source.original_text,
        id, leaseHash),
    // A pasted or adopted source proves only that the checkpoint works. It
    // cannot prove the external fetch recovered, so release this probe for
    // another eligible fetch without clearing the provider fault.
    env.DB.prepare(`UPDATE enrichment_component_gates SET state='open',epoch=epoch+1,
      retry_at=?,probe_token=NULL,probe_until=NULL,updated_at=?
      WHERE component='source' AND state='probing' AND probe_token=?
        AND EXISTS(SELECT 1 FROM links l JOIN enrichment_sources s ON s.link_id=l.id
          WHERE l.id=? AND l.enrichment_status='processing' AND l.enrichment_lease_token=?
            AND l.enrichment_lease_until>? AND l.original_text=? AND s.url=l.url
            AND s.original_text=l.original_text)
        AND NOT EXISTS(SELECT 1 FROM enrichment_provider_attempts a WHERE a.link_id=?
          AND a.lease_hash=? AND a.stage='fetch' AND a.state='responded' AND a.http_status=200)`)
      .bind(now, now, body.lease_token, id, body.lease_token, now, source.original_text,
        id, leaseHash)
  ]);
  if (results[0].results.length) {
    if (Number(results[2].meta.changes) === 1) onGateClosed?.();
    onStored?.();
    return reply({ id, status: "source_saved" });
  }
  return conflict();
}


export { LEGACY_ERROR_CODES };
