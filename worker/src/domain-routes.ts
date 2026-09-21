import type { Env } from "./index";
import { taxonomyV2 } from "./taxonomy-v2";
import {
  canonicalJSON, contentHash, effectiveView, EMPTY_AUTOMATIC, normalizeField, objectivePayload,
  semanticSpecHash, snapshotCompleteness, validOverride, validQuestionSpec, validSnapshot,
  type AutomaticView, type EvidenceSnapshot, type EffectiveView, type Override, type OverrideAction,
  type OverrideField, type QuestionSpec
} from "./domain";

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const fail = (code: string, status = 400, extra: Record<string, unknown> = {}) => reply({ error: code, ...extra }, status);

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) return null;
  try {
    const value: unknown = JSON.parse(await request.text());
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Internal v2 API. Every route requires the enricher token (enforced by the
// caller); management-only mutations are additionally documented as such.
export async function domainRoute(request: Request, env: Env, path: string): Promise<Response> {
  // --- Evidence snapshots -------------------------------------------------
  let match = path.match(/^\/api\/v2\/links\/(\d+)\/evidence$/);
  if (match) {
    const id = Number(match[1]);
    if (request.method === "GET") return latestSnapshot(env, id);
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return saveSnapshot(request, env, id);
  }

  // --- Question specs (immutable) -----------------------------------------
  match = path.match(/^\/api\/v2\/question-specs(?:\/([a-z][a-z0-9_-]{0,63}))?$/);
  if (match) {
    if (request.method === "GET") return match[1] ? getSpec(env, match[1]) : listSpecs(env);
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return putSpec(request, env);
  }

  // --- Runs and decisions -------------------------------------------------
  match = path.match(/^\/api\/v2\/links\/(\d+)\/runs$/);
  if (match) {
    if (request.method === "GET") return listRuns(env, Number(match[1]));
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return submitRun(request, env, Number(match[1]));
  }

  match = path.match(/^\/api\/v2\/links\/(\d+)\/decisions$/);
  if (match) {
    if (request.method === "GET") return latestDecision(env, Number(match[1]));
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return submitDecision(request, env, Number(match[1]));
  }

  // --- Human overrides and curation operations ----------------------------
  match = path.match(/^\/api\/v2\/links\/(\d+)\/overrides$/);
  if (match) {
    if (request.method === "GET") return listOverrides(env, Number(match[1]));
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return applyOverride(request, env, Number(match[1]));
  }

  match = path.match(/^\/api\/v2\/links\/(\d+)\/effective$/);
  if (match && request.method === "GET") return effective(env, Number(match[1]));
  if (match) return fail("method_not_allowed", 405);

  return fail("not_found", 404);
}

// --- Evidence snapshots -----------------------------------------------------

async function latestSnapshot(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT s.id, s.content_revision, s.content_hash, s.payload, s.truncated, s.completeness, s.created_at,
            l.content_revision AS current_revision
     FROM evidence_snapshots s JOIN links l ON l.id = s.link_id
     WHERE s.link_id = ? ORDER BY s.content_revision DESC LIMIT 1`
  ).bind(id).first<{ id: number; content_revision: number; content_hash: string; payload: string; truncated: number; completeness: string; created_at: string; current_revision: number }>();
  if (!row) return fail("not_found", 404);
  return reply({
    id: row.id, content_revision: row.content_revision, content_hash: row.content_hash,
    snapshot: JSON.parse(row.payload), truncated: row.truncated === 1, completeness: row.completeness,
    created_at: row.created_at, current: row.content_revision === row.current_revision
  });
}

// A snapshot identity is (link_id, content_revision). It is append-only: the
// same identity may never be rewritten with different bytes, because a stored
// run references exactly those bytes. If a concurrent writer already created
// the revision, the guarded UPDATE and the insert both no-op, and the stored
// hash is compared instead of blindly overwriting (F08).
async function saveSnapshot(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body || !validSnapshot(body.snapshot)) return fail("invalid_snapshot");
  const snapshot = body.snapshot as EvidenceSnapshot;
  const hash = await contentHash(snapshot);
  const now = new Date().toISOString();
  const link = await env.DB.prepare(`SELECT content_revision FROM links WHERE id = ?`).bind(id)
    .first<{ content_revision: number }>();
  if (!link) return fail("not_found", 404);
  const existing = await env.DB.prepare(
    `SELECT content_revision, content_hash FROM evidence_snapshots WHERE link_id = ? ORDER BY content_revision DESC LIMIT 1`
  ).bind(id).first<{ content_revision: number; content_hash: string }>();
  if (existing && existing.content_hash === hash) {
    return reply({ id, content_revision: existing.content_revision, content_hash: hash, unchanged: true });
  }
  // The source-save trigger may already have advanced the link revision for
  // this same content change, so the snapshot takes the link's revision when it
  // is newer instead of skipping past it (which would make every decision look
  // immediately stale).
  const revision = Math.max(link.content_revision, (existing?.content_revision ?? 0) + 1);
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE links SET content_revision = ? WHERE id = ? AND content_revision < ?`)
      .bind(revision, id, revision),
    env.DB.prepare(
      `INSERT INTO evidence_snapshots(link_id, content_revision, content_hash, payload, truncated, completeness, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(link_id, content_revision) DO NOTHING`
    ).bind(id, revision, hash, objectivePayload(snapshot), snapshot.truncation.truncated ? 1 : 0, snapshotCompleteness(snapshot), now)
  ]);
  const stored = await env.DB.prepare(
    `SELECT content_revision, content_hash FROM evidence_snapshots WHERE link_id = ? ORDER BY content_revision DESC LIMIT 1`
  ).bind(id).first<{ content_revision: number; content_hash: string }>();
  if (!stored) return fail("snapshot_write_failed", 500);
  if (stored.content_hash !== hash) {
    // Another writer won the same revision with different bytes. The identity
    // is immutable, so this write is a conflict rather than an overwrite.
    return fail("snapshot_conflict", 409, { content_revision: stored.content_revision, content_hash: stored.content_hash });
  }
  void results;
  return reply({ id, content_revision: stored.content_revision, content_hash: hash, unchanged: false });
}

// --- Question specs ---------------------------------------------------------

async function listSpecs(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT spec_id, spec_hash, spec_version, requested_model, display_only, created_at FROM question_specs ORDER BY spec_id`).all();
  return reply({ specs: rows.results });
}

async function getSpec(env: Env, specID: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT spec_id, spec_hash, spec_version, payload, requested_model, display_only, created_at FROM question_specs WHERE spec_id = ?`).bind(specID).first<{ spec_id: string; payload: string }>();
  if (!row) return fail("not_found", 404);
  // `payload` is a TEXT column. It is returned as structured JSON so a strict
  // consumer decoder receives the spec object, not a quoted string (F06).
  return reply({ ...row, payload: parseJSON(row.payload, {}), spec: parseJSON(row.payload, {}) });
}

async function putSpec(request: Request, env: Env): Promise<Response> {
  const body = await bodyOf(request);
  if (!body || !validQuestionSpec(body)) return fail("invalid_spec");
  const spec = body as unknown as QuestionSpec;
  // The identity is the shared semantic hash over the provider-visible
  // questions, not a hash of the transport envelope: the consumer's internal
  // handles and display metadata must not change it (F14).
  const hash = await semanticSpecHash(spec);
  if (body.spec_hash !== undefined && body.spec_hash !== hash) {
    return fail("spec_hash_mismatch", 409, { spec_hash: hash });
  }
  // `spec_hash` is a transport sibling, not part of the immutable definition:
  // the stored payload must decode as the spec alone.
  const { spec_hash: _suppliedHash, ...storedSpec } = body;
  void _suppliedHash;
  const payload = canonicalJSON(storedSpec);
  const existing = await env.DB.prepare(`SELECT spec_hash, payload FROM question_specs WHERE spec_id = ?`).bind(spec.spec_id)
    .first<{ spec_hash: string; payload: string }>();
  if (existing) {
    // The same id must not describe different bytes: a changed question meaning
    // requires a new id so old decisions remain interpretable.
    if (existing.spec_hash !== hash) return fail("spec_conflict", 409, { spec_id: spec.spec_id });
    return reply({ spec_id: spec.spec_id, spec_hash: hash, unchanged: true });
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO question_specs(spec_id, spec_hash, spec_version, payload, requested_model, display_only, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(spec.spec_id, hash, spec.spec_version, payload,
    text(body.requested_model, 200) ? body.requested_model : "", spec.display_only ? 1 : 0, now).run();
  return reply({ spec_id: spec.spec_id, spec_hash: hash, unchanged: false });
}

// --- Runs -------------------------------------------------------------------

type RunRow = {
  id: number; content_revision: number; spec_id: string; spec_hash: string; target_generation: number;
  requested_model: string; resolved_model: string; policy_version: string; policy: string;
  answers: string; usage: string; attempt: number; operation_key: string; coverage: string;
  evidence_coverage: string; alias_drift: number; status: string; created_at: string;
};

function parseJSON(value: string | null | undefined, fallback: unknown): unknown {
  if (value === null || value === undefined || value === "") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// Stored answers are JSON text. The API returns them as structured JSON so a
// strict Go decoder receives the same provider answer shape that was stored,
// not a quoted string (F06).
function runView(row: RunRow): Record<string, unknown> {
  return {
    id: row.id, content_revision: row.content_revision, spec_id: row.spec_id, spec_hash: row.spec_hash,
    target_generation: row.target_generation, requested_model: row.requested_model,
    resolved_model: row.resolved_model, policy_version: row.policy_version,
    policy: parseJSON(row.policy, {}),
    answers: parseJSON(row.answers, {}),
    usage: parseJSON(row.usage, {}),
    attempt: row.attempt, operation_key: row.operation_key, coverage: row.coverage,
    evidence_coverage: row.evidence_coverage, alias_drift: row.alias_drift === 1,
    status: row.status, created_at: row.created_at
  };
}

async function listRuns(env: Env, id: number): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, content_revision, spec_id, spec_hash, target_generation, requested_model, resolved_model,
            policy_version, policy, answers, usage, attempt, operation_key, coverage, evidence_coverage,
            alias_drift, status, created_at
     FROM classification_runs WHERE link_id = ? ORDER BY id`).bind(id).all<RunRow>();
  return reply({ runs: rows.results.map(runView) });
}

async function submitRun(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  const operationKey = body.operation_key;
  if (!text(operationKey, 200)) return fail("invalid_operation_key");
  if (!text(body.spec_id, 64) || !text(body.spec_hash, 128) || !Number.isSafeInteger(body.content_revision) ||
    !Number.isSafeInteger(body.target_generation) || !text(body.policy_version, 100) ||
    typeof body.answers !== "object" || body.answers === null) {
    return fail("invalid_run");
  }
  if (body.policy !== undefined && (typeof body.policy !== "object" || body.policy === null || Array.isArray(body.policy))) {
    return fail("invalid_run");
  }
  const existing = await env.DB.prepare(`SELECT id, coverage, status, created_at FROM classification_runs WHERE operation_key = ?`)
    .bind(operationKey).first();
  if (existing) return reply({ id, run: existing, replayed: true });
  const spec = await env.DB.prepare(`SELECT spec_hash FROM question_specs WHERE spec_id = ?`).bind(body.spec_id)
    .first<{ spec_hash: string }>();
  if (!spec) return fail("unknown_spec", 409);
  if (spec.spec_hash !== body.spec_hash) return fail("spec_hash_mismatch", 409);
  const now = new Date().toISOString();
  const coverage = body.coverage === "partial" ? "partial" : "complete";
  const row = await env.DB.prepare(
    `INSERT INTO classification_runs(link_id, content_revision, spec_id, spec_hash, target_generation, requested_model,
       resolved_model, policy_version, policy, answers, usage, attempt, operation_key, coverage, evidence_coverage,
       alias_drift, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(id, body.content_revision, body.spec_id, body.spec_hash, body.target_generation,
    text(body.requested_model, 200) ? body.requested_model : "",
    text(body.resolved_model, 200) ? body.resolved_model : "",
    body.policy_version, canonicalJSON(body.policy ?? {}), canonicalJSON(body.answers), canonicalJSON(body.usage ?? {}),
    Number.isSafeInteger(body.attempt) ? body.attempt : 1, operationKey, coverage,
    text(body.evidence_coverage, 40) ? body.evidence_coverage : "",
    body.alias_drift === true ? 1 : 0,
    coverage === "complete" ? "succeeded" : "partial", now).first<{ id: number }>();
  return reply({ id, run: { id: row?.id, coverage, status: coverage === "complete" ? "succeeded" : "partial", created_at: now }, replayed: false });
}

// runInsertStatement is the statement form used inside an atomic completion so
// the run is committed in the same transaction as the job and the operation.
export function runInsertStatement(env: Env, run: {
  linkId: number; contentRevision: number; specId: string; specHash: string; targetGeneration: number;
  requestedModel: string; resolvedModel: string; policyVersion: string; policy: unknown; answers: unknown;
  usage: unknown; attempt: number; operationKey: string; coverage: string; evidenceCoverage: string;
  aliasDrift: boolean; createdAt: string;
}): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO classification_runs(link_id, content_revision, spec_id, spec_hash, target_generation, requested_model,
       resolved_model, policy_version, policy, answers, usage, attempt, operation_key, coverage, evidence_coverage,
       alias_drift, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(operation_key) DO NOTHING`
  ).bind(run.linkId, run.contentRevision, run.specId, run.specHash, run.targetGeneration, run.requestedModel,
    run.resolvedModel, run.policyVersion, canonicalJSON(run.policy), canonicalJSON(run.answers),
    canonicalJSON(run.usage), run.attempt, run.operationKey, run.coverage, run.evidenceCoverage,
    run.aliasDrift ? 1 : 0, run.coverage === "complete" ? "succeeded" : "partial", run.createdAt);
}

export function decisionInsertStatement(env: Env, decision: {
  linkId: number; runOperationKey: string; contentRevision: number; policyVersion: string; policy: unknown;
  automatic: AutomaticView; operationKey: string; createdAt: string;
}): D1PreparedStatement {
  // The run is appended in the same batch, so its id is resolved by the
  // operation key rather than by a pre-read that a concurrent writer could
  // invalidate.
  return env.DB.prepare(
    `INSERT INTO classification_decisions(link_id, run_id, content_revision, policy_version, policy, automatic, operation_key, created_at)
     SELECT ?, id, ?, ?, ?, ?, ?, ? FROM classification_runs WHERE operation_key = ?
     ON CONFLICT(operation_key) DO NOTHING`
  ).bind(decision.linkId, decision.contentRevision, decision.policyVersion,
    canonicalJSON(decision.policy), canonicalJSON(decision.automatic), decision.operationKey,
    decision.createdAt, decision.runOperationKey);
}

// --- Decisions --------------------------------------------------------------

async function latestDecision(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT d.id, d.run_id, d.content_revision, d.policy_version, d.policy, d.automatic, d.created_at,
            r.spec_id, r.spec_hash, r.requested_model, r.resolved_model, r.coverage
     FROM classification_decisions d JOIN classification_runs r ON r.id = d.run_id
     WHERE d.link_id = ? ORDER BY d.id DESC LIMIT 1`).bind(id)
    .first<Record<string, unknown>>();
  if (!row) return fail("not_found", 404);
  return reply({
    ...row, policy: parseJSON(String(row.policy), {}), automatic: parseJSON(String(row.automatic), EMPTY_AUTOMATIC)
  });
}

// submitDecision records a pure recomputation over stored runs. The caller may
// propose an automatic view, but the server validates it against the stored
// runs and then derives the effective view from the stored overrides itself.
// A caller-supplied `effective` is never trusted (F07).
async function submitDecision(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  const runIDs = body.run_ids;
  if (!Array.isArray(runIDs) || runIDs.length === 0 || !runIDs.every((value) => Number.isSafeInteger(value))) {
    return fail("invalid_decision");
  }
  if (!text(body.policy_version, 100) || typeof body.automatic !== "object" || body.automatic === null) {
    return fail("invalid_decision");
  }
  const automatic = normalizeAutomatic(body.automatic as Record<string, unknown>);
  if (!automatic) return fail("invalid_automatic");
  const link = await env.DB.prepare(`SELECT content_revision, personal_revision FROM links WHERE id = ?`).bind(id)
    .first<{ content_revision: number; personal_revision: number }>();
  if (!link) return fail("not_found", 404);
  // Every referenced run must exist, belong to this link, match the requested
  // spec/model and still correspond to the current content revision.
  const runs = await env.DB.prepare(
    `SELECT id, content_revision, spec_id, spec_hash, requested_model, resolved_model, coverage, status, operation_key
     FROM classification_runs WHERE link_id = ? AND id IN (${runIDs.map(() => "?").join(",")})`
  ).bind(id, ...runIDs).all<{ id: number; content_revision: number; spec_id: string; spec_hash: string; requested_model: string; resolved_model: string; coverage: string; status: string; operation_key: string }>();
  if (runs.results.length !== runIDs.length) return fail("unknown_run", 409, { found: runs.results.map((run) => run.id) });
  for (const run of runs.results) {
    if (run.status !== "succeeded") return fail("run_not_succeeded", 409, { run_id: run.id, status: run.status });
    if (run.content_revision !== link.content_revision) return fail("run_stale", 409, { run_id: run.id, content_revision: link.content_revision });
    if (text(body.spec_id, 64) && body.spec_id !== run.spec_id) return fail("run_spec_mismatch", 409, { run_id: run.id });
    if (text(body.requested_model, 200) && body.requested_model !== run.requested_model) return fail("run_model_mismatch", 409, { run_id: run.id });
  }
  const operationKey = text(body.operation_key, 200) ? body.operation_key : `decision-${id}-${runIDs.join("-")}-${body.policy_version}`;
  const existing = await env.DB.prepare(`SELECT id, operation_key FROM classification_decisions WHERE operation_key = ?`).bind(operationKey)
    .first<{ id: number }>();
  if (existing) {
    if (body.expected_revision !== undefined && body.expected_revision !== link.personal_revision) {
      return fail("revision_conflict", 409, { revision: link.personal_revision });
    }
    const view = await computeEffective(env, id);
    return reply({ id, run_ids: runIDs, policy_version: body.policy_version, decision_id: existing.id, effective: view.view, replayed: true });
  }
  const now = new Date().toISOString();
  const primaryRun = runs.results[0];
  const statements = [
    decisionInsertStatement(env, {
      linkId: id, runOperationKey: primaryRun.operation_key ?? "", contentRevision: link.content_revision,
      policyVersion: body.policy_version, policy: body.policy ?? {}, automatic,
      operationKey, createdAt: now
    })
  ];
  const decision = await env.DB.batch(statements);
  const decisionID = Number((decision[0].results[0] as { id?: number } | undefined)?.id ?? 0);
  await persistEffective(env, id, link.personal_revision);
  const view = await computeEffective(env, id);
  return reply({ id, run_ids: runIDs, policy_version: body.policy_version, decision_id: decisionID, effective: view.view, replayed: false });
}

function normalizeAutomatic(value: Record<string, unknown>): AutomaticView | null {
  const list = (entry: unknown): string[] | null =>
    Array.isArray(entry) && entry.every((item) => typeof item === "string") ? entry as string[] : null;
  const topics = list(value.topics ?? []);
  const contentFunctions = list(value.content_functions ?? []);
  const carriers = list(value.carriers ?? []);
  const affordances = list(value.affordances ?? []);
  const entities = list(value.entities ?? []);
  if (!topics || !contentFunctions || !carriers || !affordances || !entities) return null;
  if (topics.length > 64 || contentFunctions.length > 8 || carriers.length > 1 || affordances.length > 8) return null;
  return {
    topics, content_functions: contentFunctions, carriers, affordances, entities,
    form: typeof value.form === "string" ? value.form : "",
    use: typeof value.use === "string" ? value.use : ""
  };
}

// --- Overrides --------------------------------------------------------------

async function listOverrides(env: Env, id: number): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, field, term, action, source, confirmed, revision, operation_key, created_at FROM curation_overrides WHERE link_id = ? ORDER BY id`
  ).bind(id).all();
  return reply({ overrides: rows.results });
}

async function applyOverride(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  const operationKey = body.operation_key;
  const field = normalizeField(body.field);
  const action = body.action as OverrideAction;
  const term = typeof body.term === "string" ? body.term : "";
  if (!text(operationKey, 200)) return fail("invalid_operation_key");
  if (!field || !validOverride(field, action, term)) return fail("invalid_override");
  const existing = await env.DB.prepare(`SELECT id, field, term, action, revision FROM curation_overrides WHERE operation_key = ?`)
    .bind(operationKey).first();
  if (existing) return reply({ override: existing, replayed: true });
  const link = await env.DB.prepare(`SELECT personal_revision FROM links WHERE id = ?`).bind(id)
    .first<{ personal_revision: number }>();
  if (!link) return fail("not_found", 404);
  // CAS: the caller's expected revision must match the current personal
  // revision. The check and the write live in one atomic batch: every statement
  // is guarded by the same revision, so a stale client cannot interleave a
  // read-then-write and two concurrent writers cannot both succeed (F08).
  const expected = body.expected_revision === undefined ? link.personal_revision : Number(body.expected_revision);
  if (expected !== link.personal_revision) {
    return fail("revision_conflict", 409, { revision: link.personal_revision });
  }
  const now = new Date().toISOString();
  const revision = link.personal_revision + 1;
  const guard = `SELECT 1 FROM links WHERE id = ? AND personal_revision = ?`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO curation_overrides(link_id, field, term, action, source, confirmed, revision, operation_key, created_at)
       SELECT ?, ?, ?, ?, 'human', 1, ?, ?, ? WHERE EXISTS (${guard})`
    ).bind(id, field, term, action, revision, operationKey, now, id, link.personal_revision),
    env.DB.prepare(
      `INSERT INTO curation_events(link_id, kind, payload, revision, operation_key, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard})`
    ).bind(id, action, canonicalJSON({ field, term }), revision, operationKey + ":event", now, id, link.personal_revision),
    env.DB.prepare(`UPDATE links SET personal_revision = personal_revision + 1 WHERE id = ? AND personal_revision = ? RETURNING personal_revision`)
      .bind(id, link.personal_revision)
  ]);
  const updated = results[2].results as unknown[];
  if (updated.length === 0) {
    // The guarded writes all no-op'd: another writer advanced the revision
    // between our read and the batch. No side effects were applied.
    const current = await env.DB.prepare(`SELECT personal_revision FROM links WHERE id = ?`).bind(id)
      .first<{ personal_revision: number }>();
    return fail("revision_conflict", 409, { revision: current?.personal_revision ?? link.personal_revision });
  }
  await persistEffective(env, id, revision);
  return reply({ id, field, term, action, revision, replayed: false });
}

// persistSelectionOverrides translates a whole-selection write into the
// field-level override actions the effective view is built from. It is the
// bridge that lets a legacy whole-object client and the new field-level UI
// write through the same, single truth (F04).
export async function persistSelectionOverrides(
  env: Env,
  id: number,
  desired: { topics: string[]; content_functions: string[]; carriers: string[]; affordances: string[]; form: string; use: string },
  options: { source: "human" | "legacy_unknown"; operationPrefix: string; expectedRevision?: number }
): Promise<{ revision: number } | { conflict: number }> {
  const link = await env.DB.prepare(`SELECT personal_revision FROM links WHERE id = ?`).bind(id)
    .first<{ personal_revision: number }>();
  if (!link) return { conflict: 0 };
  if (options.expectedRevision !== undefined && options.expectedRevision !== link.personal_revision) {
    return { conflict: link.personal_revision };
  }
  const { view } = await computeEffective(env, id);
  const actions: Array<{ field: OverrideField; term: string; action: OverrideAction }> = [];
  const multi: Array<[OverrideField, string[], string[]]> = [
    ["topics", view.topics, desired.topics],
    ["content_functions", view.content_functions, desired.content_functions],
    ["affordances", view.affordances, desired.affordances]
  ];
  for (const [field, current, wanted] of multi) {
    if (wanted.length === 0) {
      if (current.length > 0 && !view.empty[field as keyof typeof view.empty]) actions.push({ field, term: "", action: "set_empty" });
      continue;
    }
    for (const term of wanted) if (!current.includes(term)) actions.push({ field, term, action: "accept" });
    for (const term of current) if (!wanted.includes(term)) actions.push({ field, term, action: "reject" });
  }
  const single: Array<[OverrideField, string, string]> = [
    ["carriers", view.carriers[0] ?? "", desired.carriers[0] ?? ""],
    ["form", view.form, desired.form],
    ["use", view.use, desired.use]
  ];
  for (const [field, current, wanted] of single) {
    if (wanted === current) continue;
    if (wanted === "") actions.push({ field, term: "", action: "set_empty" });
    else actions.push({ field, term: wanted, action: "accept" });
  }
  if (actions.length === 0) return { revision: link.personal_revision };
  const now = new Date().toISOString();
  const revision = link.personal_revision + 1;
  const guard = `SELECT 1 FROM links WHERE id = ? AND personal_revision = ?`;
  const statements: D1PreparedStatement[] = [];
  for (const entry of actions) {
    const key = `${options.operationPrefix}:${entry.field}:${entry.action}:${entry.term}`;
    statements.push(env.DB.prepare(
      `INSERT INTO curation_overrides(link_id, field, term, action, source, confirmed, revision, operation_key, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard})
       ON CONFLICT(operation_key) DO NOTHING`
    ).bind(id, entry.field, entry.term, entry.action, options.source, options.source === "human" ? 1 : 0,
      revision, key, now, id, link.personal_revision));
    statements.push(env.DB.prepare(
      `INSERT INTO curation_events(link_id, kind, payload, revision, operation_key, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard})
       ON CONFLICT(operation_key) DO NOTHING`
    ).bind(id, entry.action, canonicalJSON({ field: entry.field, term: entry.term, source: options.source }),
      revision, `${key}:event`, now, id, link.personal_revision));
  }
  statements.push(env.DB.prepare(`UPDATE links SET personal_revision = personal_revision + 1 WHERE id = ? AND personal_revision = ? RETURNING personal_revision`)
    .bind(id, link.personal_revision));
  const results = await env.DB.batch(statements);
  const updated = results[results.length - 1].results as unknown[];
  if (updated.length === 0) {
    const current = await env.DB.prepare(`SELECT personal_revision FROM links WHERE id = ?`).bind(id)
      .first<{ personal_revision: number }>();
    return { conflict: current?.personal_revision ?? link.personal_revision };
  }
  await persistEffective(env, id, revision);
  return { revision };
}

// --- Effective view ---------------------------------------------------------

async function loadOverrides(env: Env, id: number): Promise<Override[]> {
  const rows = await env.DB.prepare(
    `SELECT field, term, action, source, confirmed, revision FROM curation_overrides WHERE link_id = ? ORDER BY revision, id`
  ).bind(id).all<{ field: string; term: string; action: string; source: string; confirmed: number; revision: number }>();
  return rows.results.map((row) => ({
    field: (normalizeField(row.field) ?? "topics") as OverrideField, term: row.term,
    action: row.action as Override["action"], source: row.source as Override["source"],
    confirmed: row.confirmed === 1, revision: row.revision
  }));
}

// legacyAutomatic recovers the pre-decision values so an old link still reads.
// It is explicitly not a decision: the caller reports projected=false for it.
async function legacyAutomatic(env: Env, id: number): Promise<AutomaticView> {
  const selection = await env.DB.prepare(
    `SELECT topics, content_functions, carriers, affordances, form, use FROM link_selections_v2 WHERE link_id = ?`
  ).bind(id).first<Record<string, unknown>>();
  if (selection) {
    const list = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
      return [];
    };
    return {
      topics: list(parseJSON(String(selection.topics ?? "[]"), [])),
      content_functions: list(parseJSON(String(selection.content_functions ?? "[]"), [])),
      carriers: list(parseJSON(String(selection.carriers ?? "[]"), [])),
      affordances: list(parseJSON(String(selection.affordances ?? "[]"), [])),
      form: String(selection.form ?? ""), use: String(selection.use ?? ""), entities: []
    };
  }
  const link = await env.DB.prepare(`SELECT curation, classification FROM links WHERE id = ?`).bind(id)
    .first<{ curation: string | null; classification: string | null }>();
  const legacy = parseJSON(link?.curation ?? link?.classification ?? "{}", {}) as Record<string, unknown>;
  const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    ...EMPTY_AUTOMATIC, topics: list(legacy.topics),
    form: typeof legacy.form === "string" ? legacy.form : "",
    use: typeof legacy.use === "string" ? legacy.use : ""
  };
}

// computeEffective derives the single effective view from the latest decision
// (or the legacy stored selection) plus the override log. It never trusts a
// stored projection or a caller-supplied effective object.
export async function computeEffective(env: Env, id: number): Promise<{ view: EffectiveView; projected: boolean; stale: boolean; contentRevision: number }> {
  const decision = await env.DB.prepare(
    `SELECT content_revision, automatic FROM classification_decisions WHERE link_id = ? ORDER BY id DESC LIMIT 1`
  ).bind(id).first<{ content_revision: number; automatic: string }>();
  const overrides = await loadOverrides(env, id);
  const link = await env.DB.prepare(`SELECT content_revision FROM links WHERE id = ?`).bind(id)
    .first<{ content_revision: number }>();
  if (decision) {
    const automatic = parseJSON(decision.automatic, EMPTY_AUTOMATIC) as AutomaticView;
    return {
      view: effectiveView(automatic, overrides), projected: true,
      stale: link !== null && decision.content_revision !== link.content_revision,
      contentRevision: link?.content_revision ?? decision.content_revision
    };
  }
  const automatic = await legacyAutomatic(env, id);
  return { view: effectiveView(automatic, overrides), projected: false, stale: false, contentRevision: link?.content_revision ?? 0 };
}

// persistEffective writes the query projections (current_projections and
// link_selections_v2) from the computed view. Both are derived caches; a CAS
// guard on the personal revision keeps a concurrent override from being
// overwritten by a stale projection.
// projectionStatements builds the guarded projection writes. They are exported
// so an atomic completion can commit the run, the decision and the projection
// in one transaction (F05/F10) instead of rebuilding after the fact.
export function projectionStatements(env: Env, id: number, personalRevision: number, view: EffectiveView, projected: boolean, contentRevision: number, stale = false): D1PreparedStatement[] {
  const now = new Date().toISOString();
  const guard = `SELECT 1 FROM links WHERE id = ? AND personal_revision = ?`;
  return [
    env.DB.prepare(
      `INSERT INTO current_projections(link_id, content_revision, effective, updated_at)
       SELECT ?, ?, ?, ? WHERE EXISTS (${guard})
       ON CONFLICT(link_id) DO UPDATE SET content_revision=excluded.content_revision,
         effective=excluded.effective, updated_at=excluded.updated_at`
    ).bind(id, contentRevision, canonicalJSON({ ...view, projected, stale }), now, id, personalRevision),
    env.DB.prepare(
      `INSERT INTO link_selections_v2(link_id, taxonomy_version, definition_version, topics, content_functions, carriers, affordances, form, use, provenance, revised_at)
       SELECT ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard})
       ON CONFLICT(link_id) DO UPDATE SET topics=excluded.topics, content_functions=excluded.content_functions,
         carriers=excluded.carriers, affordances=excluded.affordances, form=excluded.form, use=excluded.use,
         provenance=excluded.provenance, revised_at=excluded.revised_at`
    ).bind(id, taxonomyV2().version, JSON.stringify(view.topics), JSON.stringify(view.content_functions),
      JSON.stringify(view.carriers), JSON.stringify(view.affordances), view.form, view.use,
      canonicalJSON({ source: projected ? "decision" : "legacy", overrides: view.reviewed, revision: view.revision }),
      now, id, personalRevision)
  ];
}

async function persistEffective(env: Env, id: number, personalRevision: number): Promise<void> {
  const { view, projected, stale, contentRevision } = await computeEffective(env, id);
  await env.DB.batch(projectionStatements(env, id, personalRevision, view, projected, contentRevision, stale));
}

async function currentTaxonomyVersion(): Promise<string> {
  return taxonomyV2().version;
}

// rebuildProjection is kept as the single entry point used by the completion
// path and legacy writers.
export async function rebuildProjection(env: Env, id: number, personalRevision?: number): Promise<void> {
  const link = await env.DB.prepare(`SELECT personal_revision FROM links WHERE id = ?`).bind(id)
    .first<{ personal_revision: number }>();
  await persistEffective(env, id, personalRevision ?? link?.personal_revision ?? 0);
}

async function effective(env: Env, id: number): Promise<Response> {
  const link = await env.DB.prepare(`SELECT why, curation_status FROM links WHERE id = ?`).bind(id)
    .first<{ why: string | null; curation_status: string | null }>();
  if (!link) return fail("not_found", 404);
  const { view, projected, stale, contentRevision } = await computeEffective(env, id);
  return reply({
    id, content_revision: contentRevision, effective: view, projected, stale,
    why: link.why, curation_status: link.curation_status
  });
}
