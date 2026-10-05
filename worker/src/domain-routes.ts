import { historicalCatalog, managedCatalog } from "./tag-catalog";
import { readJSONObject } from "./json-body";
import { entityCacheRoute } from "./entity-cache";
import {validEntityObservations,type EntityBlock} from "./entity-judgments";
import { classificationBudgetRoute } from "./classification-budget";
import { classificationAttemptsRoute } from "./classification-attempts";
import { readSelectionSnapshot, readSelectionSnapshots } from "./selection-state";
import type { RequestD1Stats } from "./observability";
import { extensionBudgetRoute } from "./extension-budget";
import { rerankCacheRoute } from "./rerank-cache";
import { createOwnedEvidenceRequest, evidenceExecutionRoute } from "./evidence-requests";
import { validRunProvenance } from "./run-provenance";
import { validCandidateAutomatic } from "./candidate-manifest";
import { hydrateRunPayload, type ArchivedPayloadRow } from "./run-archive";
import type { Env } from "./index";
import { taxonomyV2, classificationTaxonomy, type V2Selection } from "./taxonomy-v2";
import { storedClassification, taxonomy, record, type Classification } from "./curation";
import {
  canonicalJSON, contentHash, effectiveView, EMPTY_AUTOMATIC, normalizeField, objectivePayload,
  semanticSpecHash, snapshotCompleteness, objectiveUseAllowed, validOverride, validQuestionSpec, validSnapshot, validAssessment,
  type AutomaticView, type EvidenceSnapshot, type EffectiveView, type Override, type OverrideAction,
  type OverrideField, type QuestionSpec
} from "./domain";

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const fail = (code: string, status = 400, extra: Record<string, unknown> = {}) => reply({ error: code, ...extra }, status);

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  return readJSONObject(request, new URL(request.url).pathname.endsWith("/evidence") ? 8 << 20 : 1 << 20);
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Internal v2 API. Every route requires the enricher token (enforced by the
// caller); management-only mutations are additionally documented as such.
type QueryObserver = {
  measure<T>(name: string, operation: () => Promise<T>): Promise<T>;
  setD1Stats(stats: RequestD1Stats): void;
};

export async function domainRoute(request: Request, env: Env, path: string, observer?: QueryObserver): Promise<Response> {
  if (path === "/api/v2/links/effective-batch") {
    return request.method === "POST" ? effectiveBatch(request, env, observer) : fail("method_not_allowed", 405);
  }
  const entityCached = await entityCacheRoute(request, env, path);
  if (entityCached) return entityCached;
  const classificationBudget = await classificationBudgetRoute(request, env, path);
  if (classificationBudget) return classificationBudget;
  const attempts = await classificationAttemptsRoute(request, env, path);
  if (attempts) return attempts;
  const cache = await rerankCacheRoute(request, env, path);
  if (cache) return cache;
  const reservation = await extensionBudgetRoute(request, env, path);
  if (reservation) return reservation;
  const execution = await evidenceExecutionRoute(request, env, path);
  if (execution) return execution;
  // --- Evidence snapshots -------------------------------------------------
  let match = path.match(/^\/api\/v2\/links\/(\d+)\/evidence$/);
  if (match) {
    const id = Number(match[1]);
    if (request.method === "GET") {
      const snapshotID = new URL(request.url).searchParams.get("snapshot_id");
      return latestSnapshot(env, id, snapshotID === null ? null : Number(snapshotID));
    }
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
    if (request.method === "GET") return listRuns(request, env, Number(match[1]));
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return submitRun(request, env, Number(match[1]));
  }

  match = path.match(/^\/api\/v2\/links\/(\d+)\/runs\/(\d+)$/);
  if (match) return request.method === "GET" ? runDetail(request, env, Number(match[1]), Number(match[2])) : fail("method_not_allowed", 405);

  match = path.match(/^\/api\/v2\/links\/(\d+)\/decisions$/);
  if (match) {
    if (request.method === "GET") return latestDecision(env, Number(match[1]));
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return submitDecision(request, env, Number(match[1]));
  }

  match = path.match(/^\/api\/v2\/links\/(\d+)\/policy-replays$/);
  if (match) return request.method === "POST" ? submitDecision(request, env, Number(match[1]), true) : fail("method_not_allowed", 405);

  // --- Human overrides and curation operations ----------------------------
  match = path.match(/^\/api\/v2\/links\/(\d+)\/overrides$/);
  if (match) {
    if (request.method === "GET") return listOverrides(env, Number(match[1]));
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return applyOverride(request, env, Number(match[1]));
  }

  // --- Entity state and evidence requests (B05-T10/B09) --------------------
  match = path.match(/^\/api\/v2\/links\/(\d+)\/entities$/);
  if (match) {
    if (request.method === "GET") return entitiesView(env, Number(match[1]));
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return applyEntityOverride(request, env, Number(match[1]));
  }

  match = path.match(/^\/api\/v2\/links\/(\d+)\/entity-state$/);
  if (match) {
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return submitEntityState(request, env, Number(match[1]));
  }

  match = path.match(/^\/api\/v2\/links\/(\d+)\/evidence-requests$/);
  if (match) {
    if (request.method === "GET") return listEvidenceRequests(env, Number(match[1]));
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return createEvidenceRequest(request, env, Number(match[1]));
  }

  match = path.match(/^\/api\/v2\/evidence-requests\/([A-Za-z0-9_-]{1,64})$/);
  if (match) {
    if (request.method === "GET") return getEvidenceRequest(env, match[1]);
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return decideEvidenceRequest(request, env, match[1]);
  }

  match = path.match(/^\/api\/v2\/links\/(\d+)\/effective$/);
  if (match && request.method === "GET") return effective(env, Number(match[1]));
  if (match) return fail("method_not_allowed", 405);

  return fail("not_found", 404);
}

// entitiesView reports the independent entity lifecycle plus the human-corrected
// effective entity list. not_run/failed/stale are distinct from a completed
// empty result, and the human correction is the same override log the field UI
// writes, so there is one truth (B05-T10).
async function entitiesView(env: Env, id: number): Promise<Response> {
  const link = await env.DB.prepare(`SELECT id, personal_revision FROM links WHERE id = ?`).bind(id)
    .first<{ id: number; personal_revision: number }>();
  if (!link) return fail("not_found", 404);
  const state = await env.DB.prepare(
    `SELECT state, content_revision, content_hash, evidence_snapshot_id, entities, observations, updated_at FROM entity_states WHERE link_id = ?`
  ).bind(id).first<{ state: string; content_revision: number; content_hash: string; evidence_snapshot_id: number; entities: string; observations:string; updated_at: string }>();
  const { view } = await computeEffective(env, id);
  const linkRevision = await env.DB.prepare(`SELECT content_revision FROM links WHERE id = ?`).bind(id)
    .first<{ content_revision: number }>();
  const overrides = await env.DB.prepare(
    `SELECT id, term, action, source, revision, created_at FROM curation_overrides WHERE link_id = ? AND field = 'entities' ORDER BY id`
  ).bind(id).all();
  const accepted = new Set<string>();
  for (const entry of overrides.results as Array<{ term: string; action: string }>) {
    if (entry.action === "set_empty" || (entry.action === "reset" && entry.term === "")) accepted.clear();
    else if (entry.action === "accept") accepted.add(entry.term);
    else accepted.delete(entry.term);
  }
  const stale=state !== null && (state.evidence_snapshot_id === 0 || (linkRevision?.content_revision ?? 0) !== state.content_revision);
  const observations=(state?parseJSON(state.observations,[]):[]) as Array<{candidate:{surface:string};decision:string}>;
  return reply({
    id,
    state: state?.state ?? "not_run",
    state_content_revision: state?.content_revision ?? 0,
    evidence_snapshot_id: state?.evidence_snapshot_id ?? 0,
    content_hash: state?.content_hash ?? "",
    // Entity staleness is judged against the entity input revision, never
    // against an unrelated classification decision (R2-08).
    stale,
    updated_at: state?.updated_at ?? null,
    automatic: await entityAutomatic(env, id),
    archived_entities: state ? parseJSON(state.entities, []) : [],
    observations,
    effective_observations:stale?[]:observations.filter(v=>v.decision==="relevant"&&view.entities.includes(v.candidate.surface)),
    entities: view.entities,
    human: view.entities.filter((entity) => accepted.has(entity)),
    overrides: overrides.results,
    revision: link.personal_revision
  });
}

async function applyEntityOverride(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  const operationKey = body.operation_key;
  const action = body.action as OverrideAction;
  const term = typeof body.term === "string" ? body.term : "";
  if (!text(operationKey, 200)) return fail("invalid_operation_key");
  if (!validOverride("entities", action, term)) return fail("invalid_override");
  return recordOverride(env, id, "entities", action, term, operationKey, body.expected_revision);
}

// Every entity result identifies the immutable snapshot actually analyzed.
// The receipt and state transition share one D1 transaction; checking a link
// before the write is insufficient when material changes concurrently.
async function submitEntityState(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  const operationKey = body.operation_key;
  const state = String(body.state);
  if (!text(operationKey, 200)) return fail("invalid_operation_key");
  if (!["not_run", "failed", "completed_empty", "completed_nonempty", "stale"].includes(state)) return fail("invalid_entity_state");
  const entities = body.entities;
  if (!Array.isArray(entities) || entities.length > 50 || entities.some(entry => !text(entry, 120)) ||
      new Set(entities).size !== entities.length ||
      (state === "completed_nonempty" ? entities.length === 0 : entities.length !== 0)) return fail("invalid_entity_state");
  if (!Number.isSafeInteger(body.content_revision) || Number(body.content_revision) < 1 ||
      !Number.isSafeInteger(body.evidence_snapshot_id) || Number(body.evidence_snapshot_id) < 1 ||
      typeof body.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(body.content_hash)) return fail("invalid_evidence_identity");
  const observations=body.observations??[];
  if(!Array.isArray(observations)||observations.length>40)return fail("invalid_entity_observations");
  const requestHash = await sha256Hex(canonicalJSON({ link_id: id, ...body }));
  type Receipt = { link_id: number; request_hash: string; content_revision: number; outcome: string };
  const receipt = () => env.DB.prepare(`SELECT link_id,request_hash,content_revision,outcome FROM entity_operations WHERE operation_key=?`)
    .bind(operationKey).first<Receipt>();
  const acknowledge = (stored: Receipt, replayed: boolean) => stored.link_id !== id || stored.request_hash !== requestHash
    ? fail("operation_conflict", 409)
    : reply({ id, status: stored.outcome, revision: stored.content_revision, replayed });
  const existing = await receipt();
  if (existing) {
    if (existing.link_id === id && existing.request_hash === requestHash) await rebuildProjection(env, id);
    return acknowledge(existing, true);
  }
  const link = await env.DB.prepare(`SELECT id FROM links WHERE id=?`).bind(id).first();
  if (!link) return fail("not_found", 404);
  if(body.observations!==undefined){
    const material=await env.DB.prepare(`SELECT s.payload,l.related_links FROM evidence_snapshots s JOIN links l ON l.id=s.link_id
      WHERE l.id=? AND s.id=? AND s.content_revision=? AND s.content_hash=? AND l.content_revision=s.content_revision`)
      .bind(id,body.evidence_snapshot_id,body.content_revision,body.content_hash).first<{payload:string;related_links:string|null}>();
    if(!material)return fail("run_stale",409);
    const blocks=(parseJSON(material.payload,{blocks:[]}) as {blocks:EntityBlock[]}).blocks;
    if(!validEntityObservations(observations,entities as string[],blocks,parseJSON(material.related_links??"[]",[]) as string[]))return fail("invalid_entity_observations");
  }
  const projection = await readSelectionSnapshot(env, id);
  if (!projection) return fail("not_found", 404);
  const inputGuard = projectionInputGuard(id, projection);
  const storedAutomatic = { ...projection.automatic,
    entities: state === "completed_nonempty" ? entities as string[] : [] };
  const storedView = effectiveView(storedAutomatic, projection.projectionInput.overrides);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO entity_operations(operation_key,link_id,request_hash,evidence_snapshot_id,content_revision,content_hash,payload,outcome,created_at)
      SELECT ?,l.id,?,s.id,s.content_revision,s.content_hash,?,
        CASE WHEN EXISTS (
          SELECT 1 FROM entity_states e WHERE e.link_id=l.id AND e.content_revision=s.content_revision
            AND e.content_hash=s.content_hash AND e.evidence_snapshot_id=s.id
            AND e.state IN ('completed_empty','completed_nonempty')
            AND (? IN ('failed','not_run') OR (?=1 AND json_array_length(e.observations)>0))
        ) THEN 'ignored_stale' ELSE 'stored' END,?
      FROM links l JOIN evidence_snapshots s ON s.link_id=l.id AND s.content_revision=l.content_revision
      WHERE l.id=? AND s.id=? AND s.content_revision=? AND s.content_hash=? AND ${inputGuard.sql}
      ON CONFLICT(operation_key) DO NOTHING`)
      .bind(operationKey, requestHash, canonicalJSON(body), state,body.observations===undefined?1:0, now,
        id, body.evidence_snapshot_id, body.content_revision, body.content_hash, ...inputGuard.bindings),
    env.DB.prepare(`INSERT INTO entity_states(link_id,state,content_revision,content_hash,evidence_snapshot_id,entities,observations,updated_at,operation_key,revision)
      SELECT link_id,?,content_revision,content_hash,evidence_snapshot_id,?,?,?,operation_key,1 FROM entity_operations
      WHERE operation_key=? AND request_hash=? AND applied=0 AND outcome='stored'
      ON CONFLICT(link_id) DO UPDATE SET state=excluded.state,content_revision=excluded.content_revision,
        content_hash=excluded.content_hash,evidence_snapshot_id=excluded.evidence_snapshot_id,
        entities=excluded.entities,observations=excluded.observations,updated_at=excluded.updated_at,operation_key=excluded.operation_key,revision=entity_states.revision+1`)
      .bind(state, canonicalJSON(entities),canonicalJSON(observations), now, operationKey, requestHash),
    env.DB.prepare(`UPDATE entity_operations SET applied=1 WHERE operation_key=? AND request_hash=? AND applied=0`)
      .bind(operationKey, requestHash),
    ...projectionWrites(env, id, projection.link.personal_revision, storedView, storedAutomatic,
      projection.projected, projection.contentRevision, projection.stale, projection.decisionId,
      projection.projectionInput.classification,
      entityProjectionGuard(id, projection, operationKey, requestHash, "stored")),
    ...projectionWrites(env, id, projection.link.personal_revision, projection.view, projection.automatic,
      projection.projected, projection.contentRevision, projection.stale, projection.decisionId,
      projection.projectionInput.classification,
      entityProjectionGuard(id, projection, operationKey, requestHash, "ignored_stale"))
  ]);
  const committed = await receipt();
  if (!committed) return fail("run_stale", 409);
  return acknowledge(committed, false);
}

// --- Evidence escalation requests (B09-T05) ---------------------------------

async function listEvidenceRequests(env: Env, id: number): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, content_revision, scope, status, budget, dedupe_key, created_at, decided_at, result
     FROM evidence_requests WHERE link_id = ? ORDER BY created_at DESC LIMIT 100`
  ).bind(id).all();
  return reply({ requests: rows.results });
}

async function getEvidenceRequest(env: Env, requestID: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, link_id, content_revision, scope, status, budget, dedupe_key, created_at, decided_at, result
     FROM evidence_requests WHERE id = ?`
  ).bind(requestID).first();
  return row ? reply(row) : fail("not_found", 404);
}

// createEvidenceRequest records a bounded, de-duplicated escalation. It never
// fetches anything itself: the consumer performs the fetch under its own
// network policy and reports the appended blocks back (B09-T05/T06).
async function createEvidenceRequest(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  if (body.protocol !== undefined) return createOwnedEvidenceRequest(env, id, body);
  if (!text(body.scope, 40) || !["external_link", "image_text", "truncation"].includes(String(body.scope))) {
    return fail("invalid_evidence_request");
  }
  const link = await env.DB.prepare(`SELECT content_revision FROM links WHERE id = ?`).bind(id)
    .first<{ content_revision: number }>();
  if (!link) return fail("not_found", 404);
  const dedupe = text(body.dedupe_key, 200) ? body.dedupe_key : `${id}:${body.scope}:${link.content_revision}`;
  const existing = await env.DB.prepare(`SELECT id, link_id, status FROM evidence_requests WHERE dedupe_key = ?`).bind(dedupe)
    .first<{ id: string; link_id: number; status: string }>();
  if (existing) {
    if (existing.link_id !== id) return fail("operation_conflict", 409);
    return reply({ id: existing.id, status: existing.status, replayed: true });
  }
  const requestID = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO evidence_requests(id, link_id, content_revision, scope, status, budget, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).bind(requestID, id, link.content_revision, body.scope,
    canonicalJSON(body.budget ?? {}), dedupe, now).run();
  return reply({ id: requestID, status: "pending", replayed: false });
}

// decideEvidenceRequest records the consumer's bounded outcome. A failed or
// blocked fetch is explicit and never overwrites the stored source.
async function decideEvidenceRequest(request: Request, env: Env, requestID: string): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  const status = String(body.status);
  if (!["completed", "failed", "blocked", "rejected"].includes(status)) return fail("invalid_evidence_request");
  const existing = await env.DB.prepare(`SELECT status,protocol FROM evidence_requests WHERE id = ?`).bind(requestID)
    .first<{ status: string; protocol: number }>();
  if (!existing) return fail("not_found", 404);
  if (existing.protocol !== 0) return fail("execution_protocol_required", 409);
  if (existing.status !== "pending") return fail("already_decided", 409, { status: existing.status });
  await env.DB.prepare(
    `UPDATE evidence_requests SET status = ?, decided_at = ?, result = ? WHERE id = ? AND status = 'pending'`
  ).bind(status, new Date().toISOString(), canonicalJSON(body.result ?? {}), requestID).run();
  return reply({ id: requestID, status });
}

// --- Evidence snapshots -----------------------------------------------------

async function latestSnapshot(env: Env, id: number, snapshotID: number | null): Promise<Response> {
  // A claim binds a specific snapshot id, so the consumer can read exactly the
  // material it was leased against instead of the latest revision (R2-07).
  const query = snapshotID === null
    ? `SELECT s.id, s.content_revision, s.content_hash, s.payload, s.truncated, s.completeness, s.created_at,
            l.content_revision AS current_revision
     FROM evidence_snapshots s JOIN links l ON l.id = s.link_id
     WHERE s.link_id = ? ORDER BY s.content_revision DESC LIMIT 1`
    : `SELECT s.id, s.content_revision, s.content_hash, s.payload, s.truncated, s.completeness, s.created_at,
            l.content_revision AS current_revision
     FROM evidence_snapshots s JOIN links l ON l.id = s.link_id
     WHERE s.link_id = ? AND s.id = ?`;
  const statement = env.DB.prepare(query);
  const row = await (snapshotID === null ? statement.bind(id) : statement.bind(id, snapshotID))
    .first<{ id: number; content_revision: number; content_hash: string; payload: string; truncated: number; completeness: string; created_at: string; current_revision: number }>();
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
  if (existing && existing.content_hash === hash && existing.content_revision === link.content_revision) {
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

type RunRow = ArchivedPayloadRow & {
  id: number; content_revision: number; spec_id: string; spec_hash: string; target_generation: number;
  requested_model: string; resolved_model: string; policy_version: string; policy: string;
  answers: string; usage: string; attempt: number; operation_key: string; coverage: string;
  evidence_coverage: string; alias_drift: number; status: string; created_at: string;
  raw_judgments: string | null; evidence_snapshot_id: number | null; source_hash: string | null;
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
    status: row.status, created_at: row.created_at, raw_judgments: parseJSON(row.raw_judgments, null),
    evidence_snapshot_id: row.evidence_snapshot_id, source_hash: row.source_hash
  };
}

const runColumns = `id, content_revision, spec_id, spec_hash, target_generation, requested_model, resolved_model,
  policy_version, attempt, operation_key, coverage, evidence_coverage, alias_drift, status, created_at, evidence_snapshot_id, source_hash`;
function runSummary(row: RunRow) {
  const value = runView(row);
  for (const key of ["policy", "answers", "usage", "raw_judgments", "operation_key"]) delete value[key];
  return { ...value, archived: !!row.archive_key };
}
async function runDetail(request: Request, env: Env, id: number, runId: number): Promise<Response> {
  if (request.headers.get("X-Cairn-Run-History") !== "1") return fail("capability_mismatch", 409);
  if (new URL(request.url).searchParams.size) return fail("invalid_query");
  const row = await env.DB.prepare(`SELECT ${runColumns},policy,answers,usage,raw_judgments,archive_key,archive_hash,archive_bytes
    FROM classification_runs WHERE link_id=? AND id=?`).bind(id, runId).first<RunRow>();
  if (!row) return fail("not_found", 404);
  try {
    const response = reply({ ...runView(await hydrateRunPayload(env, row)), archived: !!row.archive_key });
    response.headers.set("X-Cairn-Run-History", "1"); return response;
  } catch { return fail("run_archive_unavailable", 503); }
}
async function listRuns(request: Request, env: Env, id: number): Promise<Response> {
  const params = new URL(request.url).searchParams, modern = request.headers.get("X-Cairn-Run-History") === "1";
  if (params.size && !modern) return fail("capability_mismatch", 409);
  if (modern && ([...params.keys()].some(k => !["view", "limit", "after_id"].includes(k) || params.getAll(k).length !== 1) ||
    params.get("view") !== "summary")) return fail("invalid_query");
  const limit = params.has("limit") ? Number(params.get("limit")) : 50;
  const after = params.has("after_id") ? Number(params.get("after_id")) : null;
  if (modern && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || after !== null && (!Number.isSafeInteger(after) || after < 1))) return fail("invalid_query");
  const payload = modern ? "'{}' AS policy,'{}' AS answers,'{}' AS usage,NULL AS raw_judgments" : "policy,answers,usage,raw_judgments";
  const rows = await env.DB.prepare(
    `SELECT * FROM (SELECT ${runColumns},${payload},archive_key,archive_hash,archive_bytes
     FROM classification_runs WHERE link_id = ?
     UNION ALL
     SELECT run_id AS id, content_revision, spec_id, spec_hash, target_generation, requested_model, resolved_model,
            policy_version,attempt,operation_key,coverage,evidence_coverage,alias_drift,'expired' AS status,created_at,
            NULL AS evidence_snapshot_id,source_hash,'{}' AS policy,'{}' AS answers,'{}' AS usage,NULL AS raw_judgments,
            NULL AS archive_key,NULL AS archive_hash,NULL AS archive_bytes
     FROM classification_run_tombstones WHERE link_id = ?) ${modern && after !== null ? "WHERE id<?" : ""}
     ORDER BY id ${modern ? "DESC" : "ASC"} LIMIT ?`).bind(id, id, ...(modern && after !== null ? [after] : []), modern ? limit + 1 : 1001).all<RunRow>();
  if (modern) {
    const page = rows.results.slice(0, limit), response = reply({ runs: page.map(runSummary),
      next_after_id: rows.results.length > limit ? page[page.length - 1].id : null });
    response.headers.set("X-Cairn-Run-History", "1"); return response;
  }
  if (rows.results.length > 1000) return fail("history_requires_pagination", 413);
  try { return reply({ runs: await Promise.all(rows.results.map(async row => runView(await hydrateRunPayload(env, row)))) }); }
  catch { return fail("run_archive_unavailable", 503); }
}

async function submitRun(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  if (record(body.raw_judgments) && body.raw_judgments.metadata_version === 2 &&
    request.headers.get("X-Cairn-Candidate-Manifest") !== "2") return fail("capability_mismatch", 409);
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
  const payloadHash = await sha256Hex(canonicalJSON({
    ...(body.raw_judgments === undefined ? {} : { raw_judgments: body.raw_judgments }),
    ...(typeof body.raw_judgments === "object" && body.raw_judgments !== null && "metadata_version" in body.raw_judgments ? { policy: body.policy ?? {}, usage: body.usage ?? {} } : {}),
    ...(body.evidence_snapshot_id === undefined ? {} : { evidence_snapshot_id: body.evidence_snapshot_id }),
    ...(body.source_hash === undefined ? {} : { source_hash: body.source_hash }),
    link_id: id, content_revision: body.content_revision, spec_id: body.spec_id, spec_hash: body.spec_hash,
    target_generation: body.target_generation, policy_version: body.policy_version, answers: body.answers,
    requested_model: body.requested_model ?? null, resolved_model: body.resolved_model ?? null,
    coverage: body.coverage ?? "complete"
  }));
  const existing = await env.DB.prepare(`SELECT id, link_id, payload_hash, coverage, status, created_at, 0 AS expired
    FROM classification_runs WHERE operation_key = ?
    UNION ALL
    SELECT run_id AS id, link_id, payload_hash, coverage, 'expired' AS status, created_at, 1 AS expired
    FROM classification_run_tombstones WHERE operation_key = ? LIMIT 1`)
    .bind(operationKey, operationKey).first<{ id: number; link_id: number; payload_hash: string; coverage: string; status: string; created_at: string; expired: number }>();
  if (existing) {
    if (existing.link_id !== id || existing.payload_hash !== payloadHash) return fail("operation_conflict", 409);
    if (existing.expired === 1) return fail("run_expired", 410, { run_id: existing.id });
    return reply({ id, run: { id: existing.id, coverage: existing.coverage, status: existing.status, created_at: existing.created_at }, replayed: true });
  }
  // A known operation can be acknowledged without revalidating an evidence
  // snapshot that may have aged out. A new run still needs full provenance.
  if (!await validRunProvenance(env, id, body.raw_judgments, {
    specId: String(body.spec_id), specHash: String(body.spec_hash), requestedModel: String(body.requested_model ?? ""),
    resolvedModel: String(body.resolved_model ?? ""), coverage: body.coverage === "partial" ? "partial" : "complete", answers: body.answers as Record<string, unknown>, usage: body.usage ?? {}
  })) return fail("invalid_run_provenance");
  const link = await env.DB.prepare(`SELECT content_revision FROM links WHERE id = ?`).bind(id)
    .first<{ content_revision: number }>();
  if (!link) return fail("not_found", 404);
  // A run must describe the current input revision; a stale run is refused
  // rather than stored as if it were current (R2-02).
  if (Number(body.content_revision) !== link.content_revision) {
    return fail("run_stale", 409, { content_revision: link.content_revision });
  }
  const spec = await env.DB.prepare(`SELECT spec_hash FROM question_specs WHERE spec_id = ?`).bind(body.spec_id)
    .first<{ spec_hash: string }>();
  if (!spec) return fail("unknown_spec", 409);
  if (spec.spec_hash !== body.spec_hash) return fail("spec_hash_mismatch", 409);
  if (body.evidence_snapshot_id !== undefined || body.source_hash !== undefined) {
    const snapshot = await env.DB.prepare("SELECT id FROM evidence_snapshots WHERE id=? AND link_id=? AND content_revision=? AND content_hash=?")
      .bind(body.evidence_snapshot_id ?? null, id, body.content_revision, body.source_hash ?? null).first();
    if (!snapshot) return fail("run_evidence_mismatch", 409);
  }
  const now = new Date().toISOString();
  const coverage = body.coverage === "partial" ? "partial" : "complete";
  const row = await env.DB.prepare(
    `INSERT INTO classification_runs(link_id, content_revision, spec_id, spec_hash, target_generation, requested_model,
       resolved_model, policy_version, policy, answers, usage, attempt, operation_key, coverage, evidence_coverage,
       alias_drift, status, created_at, payload_hash, raw_judgments, evidence_snapshot_id, source_hash,wire_evidence_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?) RETURNING id`
  ).bind(id, body.content_revision, body.spec_id, body.spec_hash, body.target_generation,
    text(body.requested_model, 200) ? body.requested_model : "",
    text(body.resolved_model, 200) ? body.resolved_model : "",
    body.policy_version, canonicalJSON(body.policy ?? {}), canonicalJSON(body.answers), canonicalJSON(body.usage ?? {}),
    Number.isSafeInteger(body.attempt) ? body.attempt : 1, operationKey, coverage,
    text(body.evidence_coverage, 40) ? body.evidence_coverage : "",
    body.alias_drift === true ? 1 : 0,
    coverage === "complete" ? "succeeded" : "partial", now, payloadHash, body.raw_judgments == null ? null : canonicalJSON(body.raw_judgments),
    body.evidence_snapshot_id ?? null, body.source_hash ?? null, runWireHash(body.raw_judgments)).first<{ id: number }>();
  return reply({ id, run: { id: row?.id, coverage, status: coverage === "complete" ? "succeeded" : "partial", created_at: now }, replayed: false });
}

// guardClause is the single in-transaction validity predicate shared by every
// dependent write of one completion. If it does not hold, no success run,
// decision, operation record or projection update is written at all (R2-01).
export interface WriteGuard {
  sql: string;
  bindings: Array<string | number | null>;
}

function runWireHash(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return (value.metadata_version === 1 || value.metadata_version === 2) && text(value.evidence_hash, 64) ? value.evidence_hash : null;
}

// runInsertStatement is the statement form used inside an atomic completion so
// the run is committed in the same transaction as the job and the operation.
export function runInsertStatement(env: Env, run: {
  linkId: number; contentRevision: number; specId: string; specHash: string; targetGeneration: number;
  requestedModel: string; resolvedModel: string; policyVersion: string; policy: unknown; answers: unknown;
  usage: unknown; attempt: number; operationKey: string; coverage: string; evidenceCoverage: string;
  aliasDrift: boolean; createdAt: string; payloadHash: string;
  rawJudgments: unknown; evidenceSnapshotId: number | null; sourceHash: string | null;
}, guard: WriteGuard): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO classification_runs(link_id, content_revision, spec_id, spec_hash, target_generation, requested_model,
       resolved_model, policy_version, policy, answers, usage, attempt, operation_key, coverage, evidence_coverage,
       alias_drift, status, created_at, payload_hash, raw_judgments, evidence_snapshot_id, source_hash,wire_evidence_hash)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,? WHERE ${guard.sql}`
  ).bind(run.linkId, run.contentRevision, run.specId, run.specHash, run.targetGeneration, run.requestedModel,
    run.resolvedModel, run.policyVersion, canonicalJSON(run.policy), canonicalJSON(run.answers),
    canonicalJSON(run.usage), run.attempt, run.operationKey, run.coverage, run.evidenceCoverage,
    run.aliasDrift ? 1 : 0, run.coverage === "complete" ? "succeeded" : "partial", run.createdAt,
    run.payloadHash, run.rawJudgments == null ? null : canonicalJSON(run.rawJudgments), run.evidenceSnapshotId, run.sourceHash,
    runWireHash(run.rawJudgments), ...guard.bindings);
}

export function decisionInsertStatement(env: Env, decision: {
  linkId: number; runOperationKey: string; contentRevision: number; policyVersion: string; policy: unknown;
  automatic: AutomaticView; operationKey: string; createdAt: string; payloadHash: string;
  runIDs?: number[]; personalRevision?: number;
  policyHash?: string; replayTargetGeneration?: number;
}, guard: WriteGuard, ignoreConflict = true): D1PreparedStatement {
  // The run is appended in the same batch, so its id is resolved by the
  // operation key rather than by a pre-read that a concurrent writer could
  // invalidate; the same guard proves the run actually landed.
  return env.DB.prepare(
    `INSERT INTO classification_decisions(link_id, run_id, content_revision, policy_version, policy, automatic, operation_key, created_at, payload_hash,
       run_ids, run_references_complete, expected_personal_revision, payload_version,policy_hash,replay_target_generation)
     SELECT ?, r.id, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, json_array(r.id)), 1, ?, 1,?,?
     FROM classification_runs r WHERE r.operation_key = ? AND ${guard.sql}
     ${ignoreConflict ? "ON CONFLICT(operation_key) DO NOTHING" : ""} RETURNING id`
  ).bind(decision.linkId, decision.contentRevision, decision.policyVersion,
    canonicalJSON(decision.policy), canonicalJSON(decision.automatic), decision.operationKey,
    decision.createdAt, decision.payloadHash, decision.runIDs ? JSON.stringify(decision.runIDs) : null,
    decision.personalRevision ?? null, decision.policyHash ?? null, decision.replayTargetGeneration ?? null, decision.runOperationKey, ...guard.bindings);
}

// --- Decisions --------------------------------------------------------------

async function latestDecision(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT d.id, d.run_id, COALESCE(d.run_ids, json_array(d.run_id)) AS run_ids, d.run_references_complete,
            d.expected_personal_revision, d.content_revision, d.policy_version, d.policy, d.automatic, d.created_at,
            r.spec_id, r.spec_hash, r.requested_model, r.resolved_model, r.coverage
     FROM classification_decisions d JOIN classification_runs r ON r.id = d.run_id
     WHERE d.link_id = ? ORDER BY d.id DESC LIMIT 1`).bind(id)
    .first<Record<string, unknown>>();
  if (!row) return fail("not_found", 404);
  return reply({
    ...row, run_ids: parseJSON(String(row.run_ids), []), run_references_complete: row.run_references_complete === 1,
    policy: parseJSON(String(row.policy), {}), automatic: parseJSON(String(row.automatic), EMPTY_AUTOMATIC)
  });
}

// submitDecision records a pure recomputation over stored runs. The caller may
// propose an automatic view, but the server validates every referenced run,
// re-derives the effective view from the stored overrides itself and writes the
// decision under the same in-transaction guard as the rest of the domain
// (R2-01/R2-02/R2-12). A caller-supplied `effective` is never trusted.
interface DecisionRun extends ArchivedPayloadRow {
  id: number; content_revision: number; spec_id: string; spec_hash: string; requested_model: string;
  resolved_model: string; coverage: string; status: string; operation_key: string; target_generation: number;
  evidence_snapshot_id: number | null; source_hash: string | null; raw_judgments: string | null;
  wire_evidence_hash: string | null;
}

function validReplayPolicy(value: Record<string, unknown>): boolean {
  const allowed = ["version", "calibrated", "topic_accept", "topic_reject", "choice_accept", "choice_margin", "max_display_topics",
    "max_effective_topics", "allow_alias_drift", "block_personal_use", "min_primary_tags", "max_primary_tags", "function_support_accept", "prefer_specific_topics"];
  if (Object.keys(value).some(k => !allowed.includes(k)) || typeof value.calibrated !== "boolean" || typeof value.allow_alias_drift !== "boolean" ||
    value.block_personal_use !== true || !["topic_accept", "topic_reject", "choice_accept", "choice_margin"].every(k =>
      typeof value[k] === "number" && Number(value[k]) >= 0 && Number(value[k]) <= 1) ||
    Number(value.topic_reject) > Number(value.topic_accept) ||
    !["max_display_topics", "max_effective_topics"].every(k => Number.isSafeInteger(value[k]) && Number(value[k]) >= 1 && Number(value[k]) <= 64) ||
    Number(value.max_display_topics) > Number(value.max_effective_topics)) return false;
  const density = ["min_primary_tags", "max_primary_tags", "function_support_accept"].some(k => value[k] !== undefined && value[k] !== 0);
  if (value.prefer_specific_topics !== undefined && typeof value.prefer_specific_topics !== "boolean" ||
    ["jev-policy-v2", "jev-policy-v3", "jev-policy-v4"].includes(String(value.version)) && value.prefer_specific_topics === true ||
    value.version === "jev-policy-v5" && value.prefer_specific_topics !== true) return false;
  if (["jev-policy-v2", "jev-policy-v3"].includes(String(value.version)) && density) return false;
  return !(["jev-policy-v4", "jev-policy-v5"].includes(String(value.version)) || density) ||
    Number.isSafeInteger(value.min_primary_tags) && Number.isSafeInteger(value.max_primary_tags) && Number(value.min_primary_tags) >= 1 &&
    Number(value.max_primary_tags) >= 2 && Number(value.min_primary_tags) <= Number(value.max_primary_tags) && Number(value.max_primary_tags) <= 64 &&
    typeof value.function_support_accept === "number" && value.function_support_accept > Number(value.topic_reject) && value.function_support_accept <= Number(value.topic_accept);
}

async function submitDecision(request: Request, env: Env, id: number, policyReplay = false): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  if (!Array.isArray(body.run_ids) || body.run_ids.length === 0 || body.run_ids.length > 64 ||
      !body.run_ids.every((value) => Number.isSafeInteger(value) && value > 0) ||
      new Set(body.run_ids).size !== body.run_ids.length || !text(body.policy_version, 100) ||
      typeof body.automatic !== "object" || body.automatic === null || Array.isArray(body.automatic)) {
    return fail("invalid_decision");
  }
  for (const field of ["expected_revision", "content_revision"] as const) {
    if (body[field] !== undefined && (!Number.isSafeInteger(body[field]) || Number(body[field]) < 0)) return fail("invalid_decision");
  }
  for (const [field, max] of [["spec_id", 64], ["spec_hash", 128], ["requested_model", 200], ["resolved_model", 200], ["operation_key", 200]] as const) {
    if (body[field] !== undefined && !text(body[field], max)) return fail("invalid_decision");
  }
  const runIDs = [...body.run_ids].sort((a, b) => a - b) as number[];
  const automatic = normalizeAutomatic(body.automatic as Record<string, unknown>);
  if (!automatic) return fail("invalid_automatic");
  if (policyReplay && (!text(body.operation_key, 200) || !Number.isSafeInteger(body.expected_revision) ||
    !Number.isSafeInteger(body.content_revision) || !Number.isSafeInteger(body.expected_target_generation) || Number(body.expected_target_generation) < 0 ||
    !text(body.spec_id, 64) || !text(body.spec_hash, 128) || !text(body.requested_model, 200) || !text(body.resolved_model, 200) ||
    !body.policy || typeof body.policy !== "object" || Array.isArray(body.policy) ||
    (body.policy as Record<string, unknown>).version !== body.policy_version || !validReplayPolicy(body.policy as Record<string, unknown>) ||
    body.policy_hash !== await sha256Hex(canonicalJSON(body.policy)))) return fail("invalid_policy_replay");
  const operationKey = text(body.operation_key, 200) ? body.operation_key : `decision-${id}-${runIDs.join("-")}-${body.policy_version}`;
  const legacyPayload = {
    link_id: id, run_ids: runIDs, policy_version: body.policy_version, policy: body.policy ?? {},
    automatic, spec_id: body.spec_id ?? null, requested_model: body.requested_model ?? null
  };
  const payloadHash = await sha256Hex(canonicalJSON({ ...legacyPayload,
    spec_hash: body.spec_hash ?? null, resolved_model: body.resolved_model ?? null,
    content_revision: body.content_revision ?? null,
    ...(policyReplay ? { policy_hash: body.policy_hash, expected_target_generation: body.expected_target_generation }
      : { expected_revision: body.expected_revision ?? null })
  }));
  // Confirm a successful logical operation BEFORE testing mutable current state.
  // The acknowledgement describes its stored decision; effective is today's view.
  const existingResponse = async (): Promise<Response | null> => {
    const row = await env.DB.prepare(`SELECT id,link_id,payload_hash,payload_version,run_id,run_ids,
      run_references_complete,expected_personal_revision,policy_version,policy_hash,replay_target_generation FROM classification_decisions WHERE operation_key=?`)
      .bind(operationKey).first<{ id: number; link_id: number; payload_hash: string; payload_version: number;
        run_id: number; run_ids: string | null; run_references_complete: number; expected_personal_revision: number | null; policy_version: string;
        policy_hash: string | null; replay_target_generation: number | null }>();
    if (!row) return null;
    const hash = row.payload_version === 0 ? await sha256Hex(canonicalJSON(legacyPayload)) : payloadHash;
    if (row.link_id !== id || row.payload_hash !== hash) return fail("operation_conflict", 409);
    // An older successful operation may have committed before its separate
    // projection update. Exact replay repairs the current projection without
    // appending another decision or applying the old view over newer writes.
    await rebuildProjection(env, id);
    const view = await computeEffective(env, id);
    return reply({ id, run_ids: parseJSON(row.run_ids ?? JSON.stringify([row.run_id]), []),
      run_references_complete: row.run_references_complete === 1, revision: row.expected_personal_revision,
      policy_version: row.policy_version, decision_id: row.id, effective: view.view, replayed: true,
      ...(policyReplay ? { policy_hash: row.policy_hash, target_generation: row.replay_target_generation } : {}) });
  };
  const existing = await existingResponse();
  if (existing) return existing;
  const link = await env.DB.prepare(`SELECT content_revision, personal_revision FROM links WHERE id = ?`).bind(id)
    .first<{ content_revision: number; personal_revision: number }>();
  if (!link) return fail("not_found", 404);
  if (body.expected_revision !== undefined && body.expected_revision !== link.personal_revision) {
    return fail("revision_conflict", 409, { revision: link.personal_revision });
  }
  if (body.content_revision !== undefined && body.content_revision !== link.content_revision) return fail("run_stale", 409);
  const runs = await env.DB.prepare(`SELECT id,content_revision,spec_id,spec_hash,requested_model,resolved_model,
    coverage,status,operation_key,target_generation,evidence_snapshot_id,source_hash,raw_judgments,wire_evidence_hash,
    policy,answers,usage,archive_key,archive_hash,archive_bytes
    FROM classification_runs WHERE link_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id`)
    .bind(id, JSON.stringify(runIDs)).all<DecisionRun>();
  if (runs.results.length !== runIDs.length) return fail("unknown_run", 409, { found: runs.results.map((run) => run.id) });
  try {
    for (let index = 0; index < runs.results.length; index++) runs.results[index] = await hydrateRunPayload(env, runs.results[index]);
  } catch { return fail("run_archive_unavailable", 503); }
  for (const run of runs.results) {
    if (run.status !== "succeeded") return fail("run_not_succeeded", 409, { run_id: run.id, status: run.status });
    if (run.coverage !== "complete") return fail("run_incomplete", 409, { run_id: run.id });
    if (run.content_revision !== link.content_revision) return fail("run_stale", 409, { run_id: run.id, content_revision: link.content_revision });
    if ((body.spec_id !== undefined && body.spec_id !== run.spec_id) || (body.spec_hash !== undefined && body.spec_hash !== run.spec_hash)) {
      return fail("run_spec_mismatch", 409, { run_id: run.id });
    }
    if (!run.resolved_model || (body.resolved_model !== undefined && body.resolved_model !== run.resolved_model) ||
        (body.requested_model !== undefined && body.requested_model !== run.requested_model)) return fail("run_model_mismatch", 409, { run_id: run.id });
  }
  const primary = runs.results[0];
  const target = policyReplay ? await env.DB.prepare(`SELECT t.* FROM classification_target_state s
    JOIN classification_targets t ON t.generation=s.generation WHERE s.id=1`).first<{
      generation: number; spec_id: string; spec_hash: string; requested_model: string; taxonomy_version: string; policy_version: string;
    }>() : null;
  if (policyReplay && (!target || body.expected_target_generation !== target.generation)) return fail("target_changed", 409);
  if (policyReplay && target && (primary.spec_id !== target.spec_id || primary.spec_hash !== target.spec_hash ||
    primary.requested_model !== target.requested_model)) return fail("run_identity_mismatch", 409);
  if (policyReplay && target && !await validReplayAutomatic(env, automatic, target.taxonomy_version)) return fail("invalid_automatic");
  const rawRuns = runs.results.map(run => parseJSON(run.raw_judgments ?? "null", null));
  const judged = new Set<string>();
  for (const raw of rawRuns) if (record(raw) && record(raw.judgments)) {
    for (const question of Object.keys(raw.judgments)) judged.add(question);
  }
  if (rawRuns.some(raw => !validCandidateAutomatic(raw, automatic, judged))) return fail("invalid_candidate_automatic");
  if (policyReplay && await env.DB.prepare(`SELECT 1 FROM classification_jobs WHERE link_id=? AND status='processing' AND lease_until>?`)
    .bind(id, new Date().toISOString()).first()) return fail("classification_in_progress", 409);
  const wireHash = (run: DecisionRun): string | null => {
    const raw = parseJSON(run.raw_judgments ?? "null", null) as Record<string, unknown> | null;
    return runWireHash(raw) ?? run.wire_evidence_hash;
  };
  const identity = (run: DecisionRun) => canonicalJSON([run.spec_id, run.spec_hash, run.resolved_model,
    run.content_revision, run.target_generation, run.source_hash, wireHash(run)]);
  if (runs.results.some((run) => identity(run) !== identity(primary))) return fail("run_identity_mismatch", 409);
  if (policyReplay && (!primary.source_hash || !wireHash(primary) || runs.results.some(run => !run.evidence_snapshot_id))) return fail("run_identity_unknown", 409);
  // Old single-run policy replays remain possible with honest unknown provenance.
  // Combining unknown input identities cannot prove that the material was the same.
  if (runIDs.length > 1 && (!primary.source_hash || !wireHash(primary) || runs.results.some((run) => !run.evidence_snapshot_id))) {
    return fail("run_identity_unknown", 409);
  }
  // Pin every row read above, not only its primary ID. json_each keeps the SQL
  // variable count bounded even for the maximum 64 references. Stored snapshot
  // and actual bounded wire identities are distinct and both remain checked.
  const pinned = runs.results.map((run) => ({ id: run.id, spec_id: run.spec_id, spec_hash: run.spec_hash,
    requested_model: run.requested_model, resolved_model: run.resolved_model, target_generation: run.target_generation,
    source_hash: run.source_hash, evidence_snapshot_id: run.evidence_snapshot_id, wire_hash: wireHash(run) }));
  const snapshot = await readSelectionSnapshot(env, id);
  if (!snapshot || snapshot.link.content_revision !== link.content_revision ||
      snapshot.link.personal_revision !== link.personal_revision) return fail("run_stale", 409);
  const futureAutomatic = { ...automatic, entities: snapshot.automatic.entities };
  const futureView = effectiveView(futureAutomatic, snapshot.projectionInput.overrides);
  const inputGuard = projectionInputGuard(id, snapshot);
  const guard: WriteGuard = {
    sql: `EXISTS (SELECT 1 FROM links WHERE id=? AND content_revision=? AND personal_revision=?)
      AND (SELECT COUNT(*) FROM classification_runs cr JOIN json_each(?) p ON cr.id=json_extract(p.value,'$.id')
        WHERE cr.link_id=? AND cr.content_revision=? AND cr.status='succeeded' AND cr.coverage='complete'
          AND cr.spec_id=json_extract(p.value,'$.spec_id') AND cr.spec_hash=json_extract(p.value,'$.spec_hash')
          AND cr.requested_model=json_extract(p.value,'$.requested_model') AND cr.resolved_model=json_extract(p.value,'$.resolved_model')
          AND cr.target_generation=json_extract(p.value,'$.target_generation')
          ${policyReplay ? `AND (SELECT generation FROM classification_target_state WHERE id=1)=${Number(target!.generation)}
            AND EXISTS (SELECT 1 FROM classification_targets active WHERE active.generation=${Number(target!.generation)}
              AND active.spec_id=cr.spec_id AND active.spec_hash=cr.spec_hash AND active.requested_model=cr.requested_model)
            AND NOT EXISTS (SELECT 1 FROM classification_jobs busy WHERE busy.link_id=cr.link_id
              AND busy.status='processing' AND busy.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
            : "AND cr.target_generation=(SELECT generation FROM classification_target_state WHERE id=1)"}
          AND EXISTS (SELECT 1 FROM classification_targets ct WHERE ct.generation=cr.target_generation
            AND (ct.protocol='legacy' OR (ct.spec_id=cr.spec_id AND ct.spec_hash=cr.spec_hash)))
          AND cr.source_hash IS json_extract(p.value,'$.source_hash')
          AND cr.evidence_snapshot_id IS json_extract(p.value,'$.evidence_snapshot_id')
          AND COALESCE(CASE WHEN json_extract(cr.raw_judgments,'$.metadata_version') IN (1,2)
            THEN json_extract(cr.raw_judgments,'$.evidence_hash') END,cr.wire_evidence_hash) IS json_extract(p.value,'$.wire_hash')
          AND ((cr.evidence_snapshot_id IS NULL AND cr.source_hash IS NULL) OR EXISTS (
            SELECT 1 FROM evidence_snapshots es WHERE es.id=cr.evidence_snapshot_id AND es.link_id=cr.link_id
              AND es.content_revision=cr.content_revision AND es.content_hash=cr.source_hash)))=?
      AND ${inputGuard.sql}`,
    bindings: [id, link.content_revision, link.personal_revision, JSON.stringify(pinned), id, link.content_revision,
      runIDs.length, ...inputGuard.bindings]
  };
  const statements = [decisionInsertStatement(env, {
    linkId: id, runOperationKey: primary.operation_key, contentRevision: link.content_revision,
    policyVersion: body.policy_version, policy: body.policy ?? {}, automatic, runIDs, personalRevision: link.personal_revision,
    operationKey, createdAt: new Date().toISOString(), payloadHash,
    ...(policyReplay ? { policyHash: String(body.policy_hash), replayTargetGeneration: target!.generation } : {})
  }, guard), ...projectionWrites(env, id, link.personal_revision, futureView, futureAutomatic, true,
    link.content_revision, false, 0, snapshot.projectionInput.classification,
    decisionProjectionGuard(id, snapshot, operationKey, payloadHash))];
  // A policy experiment is a real decision but does not claim that a different
  // deployed target has been completed. Only an exact target-policy replay can
  // satisfy its queue item; the original provider run remains immutable.
  if (policyReplay && target && body.policy_version === target.policy_version) statements.push(env.DB.prepare(`INSERT INTO classification_jobs(link_id,status,target_generation,spec_id,
      taxonomy_version,policy_version,requested_model,content_revision,evidence_snapshot_id,evidence_hash,updated_at)
    SELECT ?,'completed',?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM links WHERE id=? AND content_revision=? AND personal_revision=?)
      AND (SELECT generation FROM classification_target_state WHERE id=1)=?
      AND EXISTS(SELECT 1 FROM classification_decisions WHERE link_id=? AND operation_key=? AND payload_hash=?)
      AND NOT EXISTS(SELECT 1 FROM classification_jobs WHERE link_id=? AND status='processing' AND lease_until>?)
    ON CONFLICT(link_id) DO UPDATE SET status='completed',target_generation=excluded.target_generation,spec_id=excluded.spec_id,
      taxonomy_version=excluded.taxonomy_version,policy_version=excluded.policy_version,requested_model=excluded.requested_model,
      content_revision=excluded.content_revision,evidence_snapshot_id=excluded.evidence_snapshot_id,evidence_hash=excluded.evidence_hash,
      revision=classification_jobs.revision+1,attempts=0,lease_token=NULL,lease_until=NULL,next_retry_at=NULL,error=NULL,updated_at=excluded.updated_at`)
    .bind(id, target.generation, target.spec_id, target.taxonomy_version, String(body.policy_version), target.requested_model,
      link.content_revision, primary.evidence_snapshot_id, primary.source_hash, new Date().toISOString(),
      id, link.content_revision, link.personal_revision, target.generation, id, operationKey, payloadHash, id, new Date().toISOString()));
  const result = await env.DB.batch(statements);
  if (!result[0].results.length) {
    const concurrent = await existingResponse();
    if (concurrent) return concurrent;
    const current = await env.DB.prepare("SELECT personal_revision FROM links WHERE id=?").bind(id).first<{ personal_revision: number }>();
    if (current && current.personal_revision !== link.personal_revision) return fail("revision_conflict", 409, { revision: current.personal_revision });
    return fail("run_stale", 409, { content_revision: link.content_revision });
  }
  const decisionID = Number((result[0].results[0] as { id: number }).id);
  const view = await computeEffective(env, id);
  return reply({ id, run_ids: runIDs, run_references_complete: true, revision: link.personal_revision,
    policy_version: body.policy_version, decision_id: decisionID, effective: view.view, replayed: false,
    ...(policyReplay ? { policy_hash: body.policy_hash, target_generation: target!.generation } : {}) });
}

async function validReplayAutomatic(env: Env, automatic: AutomaticView, version: string): Promise<boolean> {
  const catalog = await historicalCatalog(env, version);
  if (!catalog) return false;
  for (const field of ["topics", "resource_kinds", "content_functions", "carriers", "affordances"] as const) {
    const terms = catalog[field] ?? [], values = automatic[field] ?? [];
    if (new Set(values).size !== values.length || values.some(value => !terms.some(term => term.id === value && term.active && !term.deprecated))) return false;
  }
  return ["form", "use"].every(field => {
    const value = automatic[field as "form" | "use"];
    return value === "" || (catalog[field === "form" ? "forms" : "uses"] ?? []).some(term => term.id === value && term.active && !term.deprecated);
  });
}

function normalizeAutomatic(value: Record<string, unknown>): AutomaticView | null {
  if (!objectiveUseAllowed(value)) return null;
  if (value.assessment !== undefined && !validAssessment(value.assessment)) return null;
  const list = (entry: unknown): string[] | null =>
    Array.isArray(entry) && entry.every((item) => typeof item === "string") ? entry as string[] : null;
  const topics = list(value.topics ?? []);
  const contentFunctions = list(value.content_functions ?? []);
  const carriers = list(value.carriers ?? []);
  const affordances = list(value.affordances ?? []);
  const resources = value.resource_kinds === undefined ? undefined : list(value.resource_kinds);
  const entities = list(value.entities ?? []);
  if (!topics || !contentFunctions || !carriers || !affordances || !entities) return null;
  if (resources === null || (resources && resources.length > 6)) return null;
  if (topics.length > 64 || contentFunctions.length > 8 || carriers.length > 1 || affordances.length > 8) return null;
  return {
    ...(value.assessment === undefined ? {} : { assessment: value.assessment }),
    topics, content_functions: contentFunctions, carriers, affordances, entities,
    ...(resources ? { resource_kinds: resources } : {}),
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
  if (!field || !validOverride(field, action, term, (await managedCatalog(env)).catalog)) return fail("invalid_override");
  return recordOverride(env, id, field, action, term, operationKey, body.expected_revision);
}

// recordOverride is the single writer for human field actions. Entity
// corrections and the four-dimension UI both go through it, so the CAS and the
// event log cannot diverge between entry points.
async function recordOverride(
  env: Env, id: number, field: OverrideField, action: OverrideAction, term: string,
  operationKey: string, expectedRevision: unknown
): Promise<Response> {
  const payloadHash = await sha256Hex(canonicalJSON({ link_id: id, field, term, action }));
  type StoredOverride = { id: number; link_id: number; field: string; term: string; action: string; revision: number; payload_hash: string };
  const stored = () => env.DB.prepare(`SELECT id, link_id, field, term, action, revision, payload_hash FROM curation_overrides WHERE operation_key = ?`)
    .bind(operationKey).first<StoredOverride>();
  const acknowledge = (existing: StoredOverride, replayed: boolean): Response => {
    if (existing.link_id !== id || existing.payload_hash !== payloadHash) return fail("operation_conflict", 409);
    // One receipt shape for first delivery and lost-response recovery. The
    // nested value remains for older consumers; id is always the bookmark id.
    return reply({ id, field, term, action, operation_key: operationKey,
      revision: existing.revision, override: existing, replayed });
  };
  const existing = await stored();
  if (existing) {
    if (existing.link_id === id && existing.payload_hash === payloadHash) await rebuildProjection(env, id);
    return acknowledge(existing, true);
  }
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)) {
    return fail("invalid_expected_revision");
  }
  const snapshot = await readSelectionSnapshot(env, id);
  if (!snapshot) return fail("not_found", 404);
  // CAS: the caller's expected revision must match the current personal
  // revision. The check and the write live in one atomic batch: every statement
  // is guarded by the same revision, so a stale client cannot interleave a
  // read-then-write and two concurrent writers cannot both succeed (F08).
  const expected = expectedRevision === undefined ? snapshot.link.personal_revision : Number(expectedRevision);
  if (expected !== snapshot.link.personal_revision) {
    const concurrent = await stored();
    if (concurrent) return acknowledge(concurrent, true);
    return fail("revision_conflict", 409, { revision: snapshot.link.personal_revision });
  }
  const now = new Date().toISOString();
  const revision = snapshot.link.personal_revision + 1;
  const inputGuard = projectionInputGuard(id, snapshot);
  const futureView = effectiveView(snapshot.automatic, [...snapshot.projectionInput.overrides,
    { field, term, action, source: "human", confirmed: true, revision }]);
  const projectedGuard = overrideProjectionGuard(id, snapshot, revision, operationKey, payloadHash);
  const accepted = `SELECT 1 FROM curation_overrides WHERE operation_key = ? AND link_id = ? AND revision = ? AND payload_hash = ?`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO curation_overrides(link_id, field, term, action, source, confirmed, revision, operation_key, created_at, payload_hash)
       SELECT ?, ?, ?, ?, 'human', 1, ?, ?, ?, ? WHERE ${inputGuard.sql}
       ON CONFLICT(operation_key) DO NOTHING`
    ).bind(id, field, term, action, revision, operationKey, now, payloadHash, ...inputGuard.bindings),
    env.DB.prepare(
      `INSERT INTO curation_events(link_id, kind, payload, revision, operation_key, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE ${inputGuard.sql} AND EXISTS (${accepted})
       ON CONFLICT(operation_key) DO NOTHING`
    ).bind(id, action, canonicalJSON({ field, term }), revision, operationKey + ":event", now,
      ...inputGuard.bindings, operationKey, id, revision, payloadHash),
    env.DB.prepare(`UPDATE links SET personal_revision = personal_revision + 1
      WHERE id = ? AND ${inputGuard.sql} AND EXISTS (${accepted}) RETURNING personal_revision`)
      .bind(id, ...inputGuard.bindings, operationKey, id, revision, payloadHash),
    ...projectionWrites(env, id, revision, futureView, snapshot.automatic, snapshot.projected,
      snapshot.contentRevision, snapshot.stale, snapshot.decisionId, snapshot.projectionInput.classification, projectedGuard)
  ]);
  const updated = results[2].results as unknown[];
  // A concurrent identical operation may already have committed. Confirm that
  // exact receipt before treating a changed mutable revision as a conflict.
  const receipt = await stored();
  if (receipt) {
    if (updated.length === 0 && receipt.link_id === id && receipt.payload_hash === payloadHash) await rebuildProjection(env, id);
    return acknowledge(receipt, updated.length === 0);
  }
  const current = await env.DB.prepare(`SELECT personal_revision FROM links WHERE id = ?`).bind(id)
    .first<{ personal_revision: number }>();
  return fail("revision_conflict", 409, { revision: current?.personal_revision ?? snapshot.link.personal_revision });
}

// persistSelectionOverrides translates a whole-selection write into the
// field-level override actions the effective view is built from. It is the
// bridge that lets a legacy whole-object client and the new field-level UI
// write through the same, single truth (F04).
type SelectionReceipt = { link_id: number; payload_hash: string; revision: number; selection: string };

export async function selectionOperationReceipt(env: Env, operationKey: string): Promise<SelectionReceipt | null> {
  return env.DB.prepare(`SELECT link_id,payload_hash,revision,selection FROM selection_operations WHERE operation_key=?`)
    .bind(operationKey).first<SelectionReceipt>();
}

function selectionFromView(view: EffectiveView): V2Selection {
  return { topics: view.topics, content_functions: view.content_functions, carriers: view.carriers,
    affordances: view.affordances, form: view.form, use: view.use };
}

export async function persistSelectionOverrides(
  env: Env,
  id: number,
  desired: { topics: string[]; content_functions: string[]; carriers: string[]; affordances: string[]; form: string; use: string },
  options: {
    source: "human" | "legacy_unknown"; operationPrefix: string; expectedRevision?: number;
    // A whole-selection write (v1 replacement or a v2 PATCH) expresses the full
    // desired set, so an automatic candidate that is not in it must be rejected
    // explicitly; otherwise a later automatic result would silently reappear.
    rejectAutomaticExtras?: boolean;
    // resetFields restores the automatic value for exactly these fields. It is
    // how the legacy `classification: null` ("restore automatic") is expressed
    // without clearing hidden v2 dimensions or the user's intent.
    resetFields?: OverrideField[];
    // An explicit v1 confirmation pins all three fields, even when the saved
    // values currently equal the automatic suggestions.
    confirmV1Selection?: boolean;
    operation?: { key: string; payloadHash: string };
  }
): Promise<{ revision: number; selection: V2Selection } | { conflict: number } | { operationConflict: true }> {
  const operation = options.operation;
  const receipt = async (): Promise<{ revision: number; selection: V2Selection } | { operationConflict: true } | null> => {
    if (!operation) return null;
    const stored = await selectionOperationReceipt(env, operation.key);
    if (!stored) return null;
    if (stored.link_id !== id || stored.payload_hash !== operation.payloadHash) return { operationConflict: true };
    return { revision: stored.revision, selection: JSON.parse(stored.selection) as V2Selection };
  };
  const prior = await receipt();
  if (prior) return prior;
  const snapshot = await readSelectionSnapshot(env, id);
  if (!snapshot) return { conflict: 0 };
  if (options.expectedRevision !== undefined && options.expectedRevision !== snapshot.link.personal_revision) {
    return { conflict: snapshot.link.personal_revision };
  }
  const { view } = snapshot;
  const automatic = options.rejectAutomaticExtras ? snapshot.automatic : null;
  const actions: Array<{ field: OverrideField; term: string; action: OverrideAction }> = [];
  const resetSet = new Set(options.resetFields ?? []);
  if (options.resetFields) {
    for (const field of options.resetFields) {
      actions.push({ field, term: "", action: "reset" });
    }
  }
  const multi: Array<[OverrideField, string[], string[]]> = [
    ["topics", view.topics, desired.topics],
    ["content_functions", view.content_functions, desired.content_functions],
    ["affordances", view.affordances, desired.affordances]
  ];
  for (const [field, current, wanted] of multi) {
    if (resetSet.has(field)) continue;
    if (options.confirmV1Selection && field === "topics") {
      actions.push({ field, term: "", action: "set_empty" });
      for (const term of wanted) actions.push({ field, term, action: "accept" });
      continue;
    }
    const automaticTerms = automatic === null
      ? []
      : ((automatic[field as keyof AutomaticView] as string[] | undefined) ?? []);
    if (wanted.length === 0) {
      if (current.length > 0 || automaticTerms.length > 0) {
        if (!view.empty[field as keyof typeof view.empty]) actions.push({ field, term: "", action: "set_empty" });
      }
      continue;
    }
    if (automatic !== null) {
      // A whole-selection write expresses the complete desired set. When it
      // differs from the automatic baseline it is a replacement: the automatic
      // candidates are cleared and only the chosen ones remain, until an
      // explicit reset restores the automatic value.
      const sameAsAutomatic = wanted.length === automaticTerms.length && wanted.every((term) => automaticTerms.includes(term));
      if (!sameAsAutomatic) actions.push({ field, term: "", action: "set_empty" });
    }
    for (const term of wanted) actions.push({ field, term, action: "accept" });
    for (const term of current) {
      if (wanted.includes(term)) continue;
      actions.push({ field, term, action: "reject" });
    }
  }
  const single: Array<[OverrideField, string, string]> = [
    ["carriers", view.carriers[0] ?? "", desired.carriers[0] ?? ""],
    ["form", view.form, desired.form],
    ["use", view.use, desired.use]
  ];
  for (const [field, current, wanted] of single) {
    if (resetSet.has(field)) continue;
    if (options.confirmV1Selection && (field === "form" || field === "use")) {
      actions.push({ field, term: wanted, action: wanted ? "accept" : "set_empty" });
      continue;
    }
    if (wanted === current) continue;
    if (wanted === "") actions.push({ field, term: "", action: "set_empty" });
    else actions.push({ field, term: wanted, action: "accept" });
  }
  if (actions.length === 0) {
    if (operation) {
      const guard = projectionInputGuard(id, snapshot);
      const selection = selectionFromView(snapshot.view);
      try {
        const results = await env.DB.batch([
          env.DB.prepare(`INSERT INTO selection_operations(operation_key,link_id,payload_hash,revision,selection,created_at)
            SELECT ?,?,?,?,?,? WHERE ${guard.sql} RETURNING operation_key`)
            .bind(operation.key, id, operation.payloadHash, snapshot.link.personal_revision,
              canonicalJSON(selection), new Date().toISOString(), ...guard.bindings),
          ...projectionWrites(env, id, snapshot.link.personal_revision, snapshot.view, snapshot.automatic,
            snapshot.projected, snapshot.contentRevision, snapshot.stale, snapshot.decisionId,
            snapshot.projectionInput.classification, guard)
        ]);
        if (results[0].results.length) return { revision: snapshot.link.personal_revision, selection };
      } catch (error) {
        const concurrent = await receipt();
        if (concurrent) return concurrent;
        throw error;
      }
      const concurrent = await receipt();
      if (concurrent) return concurrent;
      const current = await env.DB.prepare(`SELECT personal_revision FROM links WHERE id=?`).bind(id)
        .first<{ personal_revision: number }>();
      return { conflict: current?.personal_revision ?? snapshot.link.personal_revision };
    }
    await rebuildProjection(env, id);
    return { revision: snapshot.link.personal_revision, selection: selectionFromView(snapshot.view) };
  }
  const now = new Date().toISOString();
  const revision = snapshot.link.personal_revision + 1;
  const changes = actions.map((entry) => {
    const key = `${options.operationPrefix}:${entry.field}:${entry.action}:${entry.term}`;
    return { ...entry, source: options.source, confirmed: options.source === "human", revision,
      operation_key: key, event_key: `${key}:event`, created_at: now,
      event_payload: canonicalJSON({ field: entry.field, term: entry.term, source: options.source }) };
  });
  const payload = JSON.stringify(changes);
  const inputGuard = projectionInputGuard(id, snapshot);
  const futureView = effectiveView(snapshot.automatic, [...snapshot.projectionInput.overrides, ...changes]);
  const selection = selectionFromView(futureView);
  const projectedGuard = selectionProjectionGuard(id, snapshot, revision, changes.map((entry) => entry.operation_key));
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,source,confirmed,revision,operation_key,created_at)
        SELECT ?,json_extract(j.value,'$.field'),json_extract(j.value,'$.term'),json_extract(j.value,'$.action'),
          json_extract(j.value,'$.source'),json_extract(j.value,'$.confirmed'),json_extract(j.value,'$.revision'),
          json_extract(j.value,'$.operation_key'),json_extract(j.value,'$.created_at')
        FROM json_each(?) j WHERE ${inputGuard.sql} ORDER BY CAST(j.key AS INTEGER)`)
        .bind(id, payload, ...inputGuard.bindings),
      env.DB.prepare(`INSERT INTO curation_events(link_id,kind,payload,revision,operation_key,created_at)
        SELECT ?,json_extract(j.value,'$.action'),json_extract(j.value,'$.event_payload'),
          json_extract(j.value,'$.revision'),json_extract(j.value,'$.event_key'),json_extract(j.value,'$.created_at')
        FROM json_each(?) j WHERE ${inputGuard.sql} ORDER BY CAST(j.key AS INTEGER)`)
        .bind(id, payload, ...inputGuard.bindings),
      env.DB.prepare(`UPDATE links SET personal_revision=personal_revision+1 WHERE id=? AND ${inputGuard.sql}
        RETURNING personal_revision`).bind(id, ...inputGuard.bindings),
      ...(operation ? [env.DB.prepare(`INSERT INTO selection_operations(operation_key,link_id,payload_hash,revision,selection,created_at)
        SELECT ?,?,?,?,?,? WHERE ${projectedGuard.sql} RETURNING operation_key`)
        .bind(operation.key, id, operation.payloadHash, revision, canonicalJSON(selection), now,
          ...projectedGuard.bindings)] : []),
      ...projectionWrites(env, id, revision, futureView, snapshot.automatic, snapshot.projected,
        snapshot.contentRevision, snapshot.stale, snapshot.decisionId, snapshot.projectionInput.classification, projectedGuard)
    ]);
  } catch (error) {
    const concurrent = await receipt();
    if (concurrent) return concurrent;
    throw error;
  }
  const updated = results[2].results as unknown[];
  if (updated.length === 0) {
    const concurrent = await receipt();
    if (concurrent) return concurrent;
    const current = await env.DB.prepare(`SELECT personal_revision FROM links WHERE id = ?`).bind(id)
      .first<{ personal_revision: number }>();
    return { conflict: current?.personal_revision ?? snapshot.link.personal_revision };
  }
  return { revision, selection };
}

// --- Effective view ---------------------------------------------------------

// classificationAutomatic is the AI suggestion baseline: links.classification is
// the generated result and never contains human edits. The previous code read
// link_selections_v2 here, which is a projection of the *effective* (already
// human-resolved) view; using it as the automatic baseline made `reset` unable
// to restore the real automatic value (R2-03).
async function classificationAutomatic(env: Env, id: number): Promise<AutomaticView> {
  const link = await env.DB.prepare(`SELECT classification FROM links WHERE id = ?`).bind(id)
    .first<{ classification: string | null }>();
  const generated = parseJSON(link?.classification ?? "{}", {}) as Record<string, unknown>;
  const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    ...EMPTY_AUTOMATIC, topics: list(generated.topics),
    form: typeof generated.form === "string" ? generated.form : "",
    use: typeof generated.use === "string" ? generated.use : ""
  };
}

// automaticOf returns the current automatic baseline (decision automatic or the
// stored AI classification) without applying any human override.
export async function automaticOf(env: Env, id: number): Promise<AutomaticView> {
  const decision = await env.DB.prepare(
    `SELECT automatic FROM classification_decisions WHERE link_id = ? ORDER BY id DESC LIMIT 1`
  ).bind(id).first<{ automatic: string }>();
  const automatic = decision
    ? (parseJSON(decision.automatic, EMPTY_AUTOMATIC) as AutomaticView)
    : await classificationAutomatic(env, id);
  automatic.entities = await entityAutomatic(env, id);
  return automatic;
}

// entityAutomatic is the entity run's own success baseline. It is independent
// of the classification decision, so an entity result is visible in the
// effective view even before/without a decision (R2-08).
async function entityAutomatic(env: Env, id: number): Promise<string[]> {
  const row = await env.DB.prepare(`SELECT e.state,e.entities FROM entity_states e JOIN links l ON l.id=e.link_id
    JOIN evidence_snapshots s ON s.id=e.evidence_snapshot_id AND s.link_id=e.link_id
    WHERE e.link_id=? AND e.content_revision=l.content_revision AND s.content_revision=e.content_revision
      AND s.content_hash=e.content_hash`).bind(id)
    .first<{ state: string; entities: string }>();
  if (!row || (row.state !== "completed_nonempty" && row.state !== "completed_empty")) return [];
  const parsed = parseJSON(row.entities, []) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

// All fields and revisions are read from one SQLite snapshot.
export async function computeEffective(env: Env, id: number): Promise<{ view: EffectiveView; automatic: AutomaticView; decisionId: number; projected: boolean; stale: boolean; contentRevision: number }> {
  const snapshot = await readSelectionSnapshot(env, id);
  if (snapshot) return snapshot;
  const automatic = { ...EMPTY_AUTOMATIC };
  return { view: effectiveView(automatic, []), automatic, decisionId: 0, projected: false, stale: false, contentRevision: 0 };
}

// projectionStatements builds the guarded query projection writes used by both
// atomic business commits and exact-operation recovery.
export function projectionStatements(env: Env, id: number, personalRevision: number, view: EffectiveView, projected: boolean, contentRevision: number, stale = false, decisionId = 0, overrideGuard?: WriteGuard): D1PreparedStatement[] {
  const now = new Date().toISOString();
  const guard = overrideGuard ?? projectionGuard(id, personalRevision, contentRevision, decisionId);
  return [
    env.DB.prepare(
      `INSERT INTO current_projections(link_id, content_revision, effective, updated_at)
       SELECT ?, ?, ?, ? WHERE ${guard.sql}
       ON CONFLICT(link_id) DO UPDATE SET content_revision=excluded.content_revision,
         effective=excluded.effective, updated_at=excluded.updated_at RETURNING link_id`
    ).bind(id, contentRevision, canonicalJSON({ ...view, projected, stale }), now, ...guard.bindings),
    env.DB.prepare(
      `INSERT INTO link_selections_v2(link_id, taxonomy_version, definition_version, topics, content_functions, carriers, affordances, form, use, provenance, revised_at, resource_kinds)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
       ON CONFLICT(link_id) DO UPDATE SET topics=excluded.topics, content_functions=excluded.content_functions,
         carriers=excluded.carriers, affordances=excluded.affordances, form=excluded.form, use=excluded.use,
         provenance=excluded.provenance, revised_at=excluded.revised_at, resource_kinds=excluded.resource_kinds`
    ).bind(id, taxonomyV2().version, taxonomyV2().definition_version, JSON.stringify(view.topics), JSON.stringify(view.content_functions),
      JSON.stringify(view.carriers), JSON.stringify(view.affordances), view.form, view.use,
      canonicalJSON({ source: projected ? "decision" : "legacy", overrides: view.reviewed, revision: view.revision }),
      now, JSON.stringify(view.resource_kinds ?? []), ...guard.bindings)
  ];
}

type SelectionSnapshot = NonNullable<Awaited<ReturnType<typeof readSelectionSnapshot>>>;

// Pin every input used to precompute a future effective view. A changed entity
// result or legacy write can otherwise race even while personal/content remain
// unchanged. Every domain statement in the batch must use this predicate.
export function projectionInputGuard(id: number, snapshot: SelectionSnapshot): WriteGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM links WHERE id=? AND personal_revision=? AND content_revision=? AND classification IS ?)
      AND COALESCE((SELECT MAX(id) FROM classification_decisions WHERE link_id=?),0)=?
      AND COALESCE((SELECT revision FROM entity_states WHERE link_id=?),0)=?
      AND COALESCE((SELECT MAX(id) FROM legacy_curation_history WHERE link_id=?),0)=?`,
    bindings: [id, snapshot.link.personal_revision, snapshot.link.content_revision, snapshot.projectionInput.classification,
      id, snapshot.projectionInput.decisionId, id, snapshot.projectionInput.entityRevision,
      id, snapshot.projectionInput.legacyId]
  };
}

function decisionProjectionGuard(id: number, snapshot: SelectionSnapshot, operationKey: string, payloadHash: string): WriteGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM links WHERE id=? AND personal_revision=? AND content_revision=? AND classification IS ?)
      AND (SELECT id FROM classification_decisions WHERE link_id=? ORDER BY id DESC LIMIT 1)=
        (SELECT id FROM classification_decisions WHERE link_id=? AND operation_key=? AND payload_hash=?)
      AND COALESCE((SELECT revision FROM entity_states WHERE link_id=?),0)=?
      AND COALESCE((SELECT MAX(id) FROM legacy_curation_history WHERE link_id=?),0)=?`,
    bindings: [id, snapshot.link.personal_revision, snapshot.link.content_revision, snapshot.projectionInput.classification,
      id, id, operationKey, payloadHash, id, snapshot.projectionInput.entityRevision,
      id, snapshot.projectionInput.legacyId]
  };
}

function overrideProjectionGuard(id: number, snapshot: SelectionSnapshot, personalRevision: number,
  operationKey: string, payloadHash: string): WriteGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM links WHERE id=? AND personal_revision=? AND content_revision=? AND classification IS ?)
      AND COALESCE((SELECT MAX(id) FROM classification_decisions WHERE link_id=?),0)=?
      AND COALESCE((SELECT revision FROM entity_states WHERE link_id=?),0)=?
      AND COALESCE((SELECT MAX(id) FROM legacy_curation_history WHERE link_id=?),0)=?
      AND EXISTS (SELECT 1 FROM curation_overrides WHERE link_id=? AND operation_key=? AND payload_hash=? AND revision=?)`,
    bindings: [id, personalRevision, snapshot.link.content_revision, snapshot.projectionInput.classification,
      id, snapshot.projectionInput.decisionId, id, snapshot.projectionInput.entityRevision,
      id, snapshot.projectionInput.legacyId, id, operationKey, payloadHash, personalRevision]
  };
}

function selectionProjectionGuard(id: number, snapshot: SelectionSnapshot, personalRevision: number,
  actionKeys: string[]): WriteGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM links WHERE id=? AND personal_revision=? AND content_revision=? AND classification IS ?)
      AND COALESCE((SELECT MAX(id) FROM classification_decisions WHERE link_id=?),0)=?
      AND COALESCE((SELECT revision FROM entity_states WHERE link_id=?),0)=?
      AND COALESCE((SELECT MAX(id) FROM legacy_curation_history WHERE link_id=?),0)=?
      AND (SELECT COUNT(*) FROM curation_overrides WHERE link_id=? AND revision=?
        AND operation_key IN (SELECT value FROM json_each(?)))=?`,
    bindings: [id, personalRevision, snapshot.link.content_revision, snapshot.projectionInput.classification,
      id, snapshot.projectionInput.decisionId, id, snapshot.projectionInput.entityRevision,
      id, snapshot.projectionInput.legacyId, id, personalRevision, JSON.stringify(actionKeys), actionKeys.length]
  };
}

function entityProjectionGuard(id: number, snapshot: SelectionSnapshot, operationKey: string,
  requestHash: string, outcome: "stored" | "ignored_stale"): WriteGuard {
  const expectedEntityRevision = snapshot.projectionInput.entityRevision + (outcome === "stored" ? 1 : 0);
  return {
    sql: `EXISTS (SELECT 1 FROM links WHERE id=? AND personal_revision=? AND content_revision=? AND classification IS ?)
      AND COALESCE((SELECT MAX(id) FROM classification_decisions WHERE link_id=?),0)=?
      AND COALESCE((SELECT MAX(id) FROM legacy_curation_history WHERE link_id=?),0)=?
      AND COALESCE((SELECT revision FROM entity_states WHERE link_id=?),0)=?
      AND EXISTS (SELECT 1 FROM entity_operations WHERE link_id=? AND operation_key=? AND request_hash=? AND outcome=?)
      AND (?='ignored_stale' OR EXISTS (SELECT 1 FROM entity_states WHERE link_id=? AND operation_key=?))`,
    bindings: [id, snapshot.link.personal_revision, snapshot.link.content_revision, snapshot.projectionInput.classification,
      id, snapshot.projectionInput.decisionId, id, snapshot.projectionInput.legacyId,
      id, expectedEntityRevision, id, operationKey, requestHash, outcome,
      outcome, id, operationKey]
  };
}

export function projectionWrites(
  env: Env, id: number, personalRevision: number, view: EffectiveView, automatic: AutomaticView,
  projected: boolean, contentRevision: number, stale: boolean, decisionId: number,
  priorClassification: string | null, guard?: WriteGuard
): D1PreparedStatement[] {
  const active = guard ?? projectionGuard(id, personalRevision, contentRevision, decisionId);
  const statements = projectionStatements(env, id, personalRevision, view, projected, contentRevision, stale, decisionId, active);
  // Write the compatibility classification last. It is itself a pinned input
  // for the precomputed view, so changing it earlier would invalidate the
  // remaining guards inside the same transaction.
  const humanCuration = view.reviewed ? canonicalJSON({ topics: view.topics.slice(0, 3), form: view.form, use: view.use }) : null;
  statements.push(env.DB.prepare(`UPDATE links SET curation=?,curation_projection_epoch=curation_projection_epoch+1
    WHERE id=? AND ${active.sql}`).bind(humanCuration, id, ...active.bindings));
  if (projected) {
    const prior = storedClassification(priorClassification, null);
    const generated = {
      why_suggestion: "", entities: [], uncertainty: false, taxonomy_version: taxonomy.version, discarded_tags: [],
      ...prior, topics: automatic.topics.slice(0, 3), form: automatic.form, use: automatic.use
    };
    statements.push(env.DB.prepare(`UPDATE links SET classification=? WHERE id=? AND ${active.sql}`)
      .bind(canonicalJSON(generated), id, ...active.bindings));
  }
  return statements;
}

// Completion computes the future view before the batch, then writes that view
// inside the run/decision/job transaction. The pre-guard pins every input to
// that calculation; the post-guard proves the new decision landed before a
// projection or completion receipt can be written.
export async function completionProjectionPlan(
  env: Env, id: number, classification: Classification, automatic: AutomaticView | null,
  decisionKey: string | null, payloadHash: string, jobGuard: WriteGuard
): Promise<{ preGuard: WriteGuard; postGuard: WriteGuard; statements: D1PreparedStatement[] } | null> {
  const snapshot = await readSelectionSnapshot(env, id);
  if (!snapshot) return null;
  const identity = `EXISTS (SELECT 1 FROM links WHERE id=? AND personal_revision=? AND content_revision=?)
    AND COALESCE((SELECT revision FROM entity_states WHERE link_id=?),0)=?
    AND COALESCE((SELECT MAX(id) FROM legacy_curation_history WHERE link_id=?),0)=?`;
  const identityBindings = [id, snapshot.link.personal_revision, snapshot.link.content_revision,
    id, snapshot.projectionInput.entityRevision, id, snapshot.projectionInput.legacyId];
  const priorDecision = `COALESCE((SELECT MAX(id) FROM classification_decisions WHERE link_id=?),0)=?`;
  const preGuard: WriteGuard = {
    sql: `(${jobGuard.sql}) AND ${identity} AND ${priorDecision}`,
    bindings: [...jobGuard.bindings, ...identityBindings, id, snapshot.projectionInput.decisionId]
  };
  const newDecision = decisionKey !== null;
  const decisionGuard = newDecision
    ? `(SELECT id FROM classification_decisions WHERE link_id=? ORDER BY id DESC LIMIT 1)=
        (SELECT id FROM classification_decisions WHERE link_id=? AND operation_key=? AND payload_hash=?)`
    : priorDecision;
  const postGuard: WriteGuard = {
    sql: `(${jobGuard.sql}) AND ${identity} AND ${decisionGuard}`,
    bindings: [...jobGuard.bindings, ...identityBindings,
      ...(newDecision ? [id, id, decisionKey, payloadHash] : [id, snapshot.projectionInput.decisionId])]
  };
  const projected = automatic !== null || snapshot.projected;
  const futureAutomatic = automatic !== null
    ? { ...automatic, entities: snapshot.automatic.entities }
    : snapshot.projected ? snapshot.automatic
      : { ...EMPTY_AUTOMATIC, topics: classification.topics, form: classification.form, use: classification.use,
        entities: snapshot.automatic.entities };
  const view = effectiveView(futureAutomatic, snapshot.projectionInput.overrides);
  const statements = projectionWrites(env, id, snapshot.link.personal_revision, view, futureAutomatic,
    projected, snapshot.contentRevision, automatic !== null ? false : snapshot.stale,
    snapshot.decisionId, JSON.stringify(classification), postGuard);
  if (!projected) {
    statements.push(env.DB.prepare(`UPDATE links SET classification=? WHERE id=? AND ${postGuard.sql}`)
      .bind(JSON.stringify(classification), id, ...postGuard.bindings));
  }
  return { preGuard, postGuard, statements };
}

function projectionGuard(id: number, personalRevision: number, contentRevision: number, decisionId: number): WriteGuard {
  return { sql: `EXISTS (SELECT 1 FROM links WHERE id=? AND personal_revision=? AND content_revision=?)
      AND COALESCE((SELECT MAX(id) FROM classification_decisions WHERE link_id=?),0)=?`,
    bindings: [id, personalRevision, contentRevision, id, decisionId] };
}

async function persistEffective(env: Env, id: number): Promise<void> {
  // A superseded computation never overwrites newer caches. Pin the entity and
  // legacy input as well as personal/content/decision; neither is covered by
  // personal revision alone. Recompute from one SQLite snapshot on conflict.
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await readSelectionSnapshot(env, id);
    if (!snapshot) return;
    const guard = projectionInputGuard(id, snapshot);
    const statements = projectionWrites(env, id, snapshot.link.personal_revision, snapshot.view,
      snapshot.automatic, snapshot.projected, snapshot.contentRevision, snapshot.stale,
      snapshot.decisionId, snapshot.projectionInput.classification, guard);
    const result = await env.DB.batch(statements);
    if (result[0].results.length) return;
  }
}

async function currentTaxonomyVersion(): Promise<string> {
  return taxonomyV2().version;
}

// rebuildProjection is kept as the single entry point used by the completion
// path and legacy writers.
export async function rebuildProjection(env: Env, id: number): Promise<void> {
  await persistEffective(env, id);
}

async function effective(env: Env, id: number): Promise<Response> {
  const snapshot = await readSelectionSnapshot(env, id);
  return snapshot ? reply(effectivePayload(snapshot)) : fail("not_found", 404);
}

function effectivePayload(snapshot: NonNullable<Awaited<ReturnType<typeof readSelectionSnapshot>>>) {
  return { id: snapshot.link.id, content_revision: snapshot.contentRevision,
    effective: snapshot.view, projected: snapshot.projected, stale: snapshot.stale,
    why: snapshot.link.why, curation_status: snapshot.link.curation_status };
}

// Export is an internal, read-only operation. A fixed 50-ID cap stays well
// below D1's 100 binding parameters and bounds response size and JS memory.
async function effectiveBatch(request: Request, env: Env, observer?: QueryObserver): Promise<Response> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("invalid_content_type");
  }
  const reader = request.body?.getReader();
  if (!reader) return fail("invalid_json");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let ids: number[];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2048) { await reader.cancel(); return fail("request_too_large", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !("ids" in body)) return fail("invalid_ids");
    const input = (body as { ids: unknown }).ids;
    if (!Array.isArray(input) || input.length < 1 || input.length > 50 ||
      !input.every((id: unknown) => typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
      new Set(input).size !== input.length) {
      return fail("invalid_ids");
    }
    ids = input as number[];
  } catch { return fail("invalid_json"); }
  const { snapshots, meta } = await readSelectionSnapshots(env, ids, observer);
  observer?.setD1Stats({ query: "effective_batch", scope: "effective_view_only",
    sql_count: 1, rows_read: meta.rows_read, rows_written: meta.rows_written });
  const payload = { version: 1, items: ids.flatMap((id) => {
    const snapshot = snapshots.get(id);
    return snapshot ? [effectivePayload(snapshot)] : [];
  }), missing_ids: ids.filter((id) => !snapshots.has(id)),
  d1: { scope: "effective_view_only", sql_count: 1,
    rows_read: meta.rows_read, rows_written: meta.rows_written } };
  const body = JSON.stringify(payload);
  return new Response(body, { headers: { ...headers,
    "Content-Length": String(new TextEncoder().encode(body).length) } });
}
