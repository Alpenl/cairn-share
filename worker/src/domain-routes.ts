import type { Env } from "./index";
import {
  canonicalJSON, contentHash, effectiveView, objectivePayload, snapshotCompleteness,
  validOverride, validQuestionSpec, validSnapshot,
  type EvidenceSnapshot, type Override, type OverrideAction, type OverrideField, type QuestionSpec
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

async function saveSnapshot(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body || !validSnapshot(body.snapshot)) return fail("invalid_snapshot");
  const snapshot = body.snapshot as EvidenceSnapshot;
  const hash = await contentHash(snapshot);
  const now = new Date().toISOString();
  // A snapshot is keyed by content revision. If the objective payload is
  // unchanged the existing revision is reused rather than advancing, so a note
  // edit or a re-fetch of identical bytes cannot multiply revisions.
  const link = await env.DB.prepare(`SELECT content_revision FROM links WHERE id = ?`).bind(id)
    .first<{ content_revision: number }>();
  if (!link) return fail("not_found", 404);
  const existing = await env.DB.prepare(
    `SELECT content_revision, content_hash FROM evidence_snapshots WHERE link_id = ? ORDER BY content_revision DESC LIMIT 1`
  ).bind(id).first<{ content_revision: number; content_hash: string }>();
  if (existing && existing.content_hash === hash) {
    return reply({ id, content_revision: existing.content_revision, content_hash: hash, unchanged: true });
  }
  const revision = Math.max(link.content_revision, (existing?.content_revision ?? 0)) + 1;
  await env.DB.batch([
    env.DB.prepare(`UPDATE links SET content_revision = ? WHERE id = ?`).bind(revision, id),
    env.DB.prepare(
      `INSERT INTO evidence_snapshots(link_id, content_revision, content_hash, payload, truncated, completeness, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(link_id, content_revision) DO UPDATE SET content_hash=excluded.content_hash, payload=excluded.payload,
         truncated=excluded.truncated, completeness=excluded.completeness`
    ).bind(id, revision, hash, objectivePayload(snapshot), snapshot.truncation.truncated ? 1 : 0, snapshotCompleteness(snapshot), now)
  ]);
  return reply({ id, content_revision: revision, content_hash: hash, unchanged: false });
}

async function listSpecs(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT spec_id, spec_hash, spec_version, requested_model, display_only, created_at FROM question_specs ORDER BY spec_id`).all();
  return reply({ specs: rows.results });
}

async function getSpec(env: Env, specID: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT spec_id, spec_hash, spec_version, payload, requested_model, display_only, created_at FROM question_specs WHERE spec_id = ?`).bind(specID).first();
  return row ? reply(row) : fail("not_found", 404);
}

async function putSpec(request: Request, env: Env): Promise<Response> {
  const body = await bodyOf(request);
  if (!body || !validQuestionSpec(body)) return fail("invalid_spec");
  const spec = body as unknown as QuestionSpec;
  const payload = canonicalJSON(spec);
  const hash = await sha256Hex(payload);
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

async function listRuns(env: Env, id: number): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, content_revision, spec_id, spec_hash, target_generation, requested_model, resolved_model,
            policy_version, answers, usage, attempt, operation_key, coverage, status, created_at
     FROM classification_runs WHERE link_id = ? ORDER BY id`).bind(id).all();
  return reply({ runs: rows.results });
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
  // Idempotent: the same operation key returns the stored run, and a differing
  // payload is a conflict. A lost response must not create a second run.
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
       resolved_model, policy_version, answers, usage, attempt, operation_key, coverage, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(id, body.content_revision, body.spec_id, body.spec_hash, body.target_generation,
    text(body.requested_model, 200) ? body.requested_model : "",
    text(body.resolved_model, 200) ? body.resolved_model : "",
    body.policy_version, canonicalJSON(body.answers), canonicalJSON(body.usage ?? {}),
    Number.isSafeInteger(body.attempt) ? body.attempt : 1, operationKey, coverage,
    coverage === "complete" ? "succeeded" : "partial", now).first<{ id: number }>();
  return reply({ id, run: { id: row?.id, coverage, status: coverage === "complete" ? "succeeded" : "partial", created_at: now }, replayed: false });
}

async function submitDecision(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  const runIDs = body.run_ids;
  if (!Array.isArray(runIDs) || runIDs.length === 0 || !runIDs.every((value) => Number.isSafeInteger(value))) {
    return fail("invalid_decision");
  }
  if (!text(body.policy_version, 100) || typeof body.effective !== "object" || body.effective === null) {
    return fail("invalid_decision");
  }
  const now = new Date().toISOString();
  // A decision never creates a model run; it records a pure recomputation over
  // the referenced runs and the current overrides.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO current_projections(link_id, content_revision, effective, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(link_id) DO UPDATE SET content_revision=excluded.content_revision,
         effective=excluded.effective, updated_at=excluded.updated_at`
    ).bind(id, Number.isSafeInteger(body.content_revision) ? body.content_revision : 0, canonicalJSON(body.effective), now)
  ]);
  return reply({ id, run_ids: runIDs, policy_version: body.policy_version, updated_at: now });
}

async function listOverrides(env: Env, id: number): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, field, term, action, source, confirmed, revision, created_at FROM curation_overrides WHERE link_id = ? ORDER BY id`
  ).bind(id).all();
  return reply({ overrides: rows.results });
}

async function applyOverride(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  const operationKey = body.operation_key;
  const field = body.field as OverrideField;
  const action = body.action as OverrideAction;
  const term = typeof body.term === "string" ? body.term : "";
  if (!text(operationKey, 200)) return fail("invalid_operation_key");
  if (!validOverride(field, action, term)) return fail("invalid_override");
  const existing = await env.DB.prepare(`SELECT id, field, term, action, revision FROM curation_overrides WHERE operation_key = ?`)
    .bind(operationKey).first();
  if (existing) return reply({ override: existing, replayed: true });
  const link = await env.DB.prepare(`SELECT personal_revision FROM links WHERE id = ?`).bind(id)
    .first<{ personal_revision: number }>();
  if (!link) return fail("not_found", 404);
  // CAS: the caller's expected revision must match, so a stale client cannot
  // overwrite a newer human decision.
  if (body.expected_revision !== undefined && body.expected_revision !== link.personal_revision) {
    return fail("revision_conflict", 409, { revision: link.personal_revision });
  }
  const now = new Date().toISOString();
  const revision = link.personal_revision + 1;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO curation_overrides(link_id, field, term, action, source, confirmed, revision, operation_key, created_at)
       VALUES (?, ?, ?, ?, 'human', 1, ?, ?, ?)`
    ).bind(id, field, term, action, revision, operationKey, now),
    env.DB.prepare(
      `INSERT INTO curation_events(link_id, kind, payload, revision, operation_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, action, canonicalJSON({ field, term }), revision, operationKey + ":event", now),
    env.DB.prepare(`UPDATE links SET personal_revision = ? WHERE id = ?`).bind(revision, id)
  ]);
  await rebuildProjection(env, id);
  return reply({ id, field, term, action, revision, replayed: false });
}

// rebuildProjection recomputes the effective view from the latest run and the
// stored overrides. It is the only writer of current_projections, so the
// projection cannot drift from its inputs.
export async function rebuildProjection(env: Env, id: number): Promise<void> {
  const run = await env.DB.prepare(
    `SELECT answers FROM classification_runs WHERE link_id = ? AND status = 'succeeded' ORDER BY id DESC LIMIT 1`
  ).bind(id).first<{ answers: string }>();
  const overrides = await loadOverrides(env, id);
  const automatic = automaticFromRun(run?.answers ?? null);
  const view = effectiveView(automatic, overrides);
  const link = await env.DB.prepare(`SELECT content_revision FROM links WHERE id = ?`).bind(id)
    .first<{ content_revision: number }>();
  await env.DB.prepare(
    `INSERT INTO current_projections(link_id, content_revision, effective, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(link_id) DO UPDATE SET content_revision=excluded.content_revision,
       effective=excluded.effective, updated_at=excluded.updated_at`
  ).bind(id, link?.content_revision ?? 0, canonicalJSON(view), new Date().toISOString()).run();
}

function automaticFromRun(answers: string | null): { topics: string[]; form: string; use: string; entities: string[] } {
  const empty = { topics: [] as string[], form: "", use: "", entities: [] as string[] };
  if (!answers) return empty;
  try {
    const parsed = JSON.parse(answers) as Record<string, unknown>;
    const topics = Array.isArray(parsed.topics) ? parsed.topics.filter((v): v is string => typeof v === "string") : [];
    const entities = Array.isArray(parsed.entities) ? parsed.entities.filter((v): v is string => typeof v === "string") : [];
    return {
      topics, entities,
      form: typeof parsed.form === "string" ? parsed.form : "",
      use: typeof parsed.use === "string" ? parsed.use : ""
    };
  } catch {
    return empty;
  }
}

async function loadOverrides(env: Env, id: number): Promise<Override[]> {
  const rows = await env.DB.prepare(
    `SELECT field, term, action, source, confirmed, revision FROM curation_overrides WHERE link_id = ? ORDER BY id`
  ).bind(id).all<{ field: string; term: string; action: string; source: string; confirmed: number; revision: number }>();
  return rows.results.map((row) => ({
    field: row.field as Override["field"], term: row.term, action: row.action as Override["action"],
    source: row.source as Override["source"], confirmed: row.confirmed === 1, revision: row.revision
  }));
}

async function effective(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare(`SELECT content_revision, effective, updated_at FROM current_projections WHERE link_id = ?`)
    .bind(id).first<{ content_revision: number; effective: string; updated_at: string }>();
  if (row) return reply({ id, content_revision: row.content_revision, effective: JSON.parse(row.effective), updated_at: row.updated_at, projected: true });
  // Fall back to the v1 projection so old links remain readable.
  const link = await env.DB.prepare(`SELECT curation, classification, why, curation_status FROM links WHERE id = ?`).bind(id)
    .first<{ curation: string | null; classification: string | null; why: string | null; curation_status: string | null }>();
  if (!link) return fail("not_found", 404);
  return reply({ id, effective: automaticFromRun(link.curation ?? link.classification), why: link.why, curation_status: link.curation_status, projected: false });
}
