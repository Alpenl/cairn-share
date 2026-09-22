import type { Env } from "./index";
import { computeEffective, persistSelectionOverrides } from "./domain-routes";
import {
  applyV1Write, findTerm, proposalImpact, projectV1, taxonomyV2, validateTaxonomy, validateV2Selection,
  type TaxonomyProposal, type V2Selection
} from "./taxonomy-v2";
import { V1_V2_MAPPING, validateMapping } from "./taxonomy-mapping";

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const fail = (code: string, status = 400, extra: Record<string, unknown> = {}) => reply({ error: code, ...extra }, status);

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return null;
  try {
    const value: unknown = JSON.parse(await request.text());
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

const EMPTY_SELECTION: V2Selection = { topics: [], content_functions: [], carriers: [], affordances: [], form: "", use: "" };

function parseList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch { return []; }
}

// expandSearchText builds the bounded, parameterised search text for a link.
// It is called on every write so search never needs a join across history.
export function expandSearchText(fields: { url: string; note: string; original_text?: string | null; translated_text?: string | null; summary?: string | null; ai_title?: string | null; entities?: string[]; why?: string | null }): string {
  const parts = [
    fields.url, fields.note, fields.original_text ?? "", fields.translated_text ?? "",
    fields.summary ?? "", fields.ai_title ?? "", fields.why ?? "", ...(fields.entities ?? [])
  ];
  const joined = parts.filter(Boolean).join("\u0000").toLowerCase();
  // Bound the stored index so a long article cannot bloat the row; the detail
  // read still searches the full text when needed.
  return joined.length > 4000 ? joined.slice(0, 4000) : joined;
}

export async function taxonomyV2Route(request: Request, env: Env, path: string): Promise<Response> {
  // Vocabulary read: the Worker is the single executable source. Approved
  // display-only renames are overlaid on the response; the executable
  // definitions are untouched so no stored decision is invalidated.
  if (path === "/api/v2/taxonomy") {
    if (request.method !== "GET") return fail("method_not_allowed", 405);
    return reply(await taxonomyWithDisplayOverrides(env));
  }
  if (path === "/api/v2/taxonomy/validate") {
    const problems = validateTaxonomy();
    return reply({ ok: problems.length === 0, problems });
  }
  // The explicit v1→v2 mapping: keep/split/deprecate/uncertain per legacy term.
  if (path === "/api/v2/taxonomy/mapping") {
    if (request.method !== "GET") return fail("method_not_allowed", 405);
    return reply({ entries: V1_V2_MAPPING, problems: validateMapping() });
  }

  // Per-link multidimensional selection.
  let match = path.match(/^\/api\/v2\/links\/(\d+)\/selection$/);
  if (match) {
    const id = Number(match[1]);
    if (request.method === "GET") return getSelection(env, id);
    if (request.method === "PATCH") return patchSelection(request, env, id);
    return fail("method_not_allowed", 405);
  }

  // v1-compatible write path: an old client writes only what it can express.
  match = path.match(/^\/api\/v2\/links\/(\d+)\/selection\/v1$/);
  if (match) {
    if (request.method !== "PATCH") return fail("method_not_allowed", 405);
    return patchSelectionV1(request, env, Number(match[1]));
  }

  // Taxonomy proposals.
  if (path === "/api/v2/taxonomy/proposals") {
    if (request.method === "GET") return listProposals(env);
    if (request.method === "POST") return createProposal(request, env);
    return fail("method_not_allowed", 405);
  }
  match = path.match(/^\/api\/v2\/taxonomy\/proposals\/([A-Za-z0-9_-]{1,64})\/decision$/);
  if (match) {
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return decideProposal(request, env, match[1]);
  }
  match = path.match(/^\/api\/v2\/taxonomy\/proposals\/([A-Za-z0-9_-]{1,64})\/apply$/);
  if (match) {
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return applyProposal(request, env, match[1]);
  }
  if (path === "/api/v2/taxonomy/proposals/generate") {
    if (request.method !== "POST") return fail("method_not_allowed", 405);
    return generateProposals(env);
  }

  return fail("not_found", 404);
}

// generateProposals turns repeated *human* entity corrections into pending
// proposals. It is grounded in the override log only: a model answer alone is
// never treated as evidence that a term belongs in the vocabulary, and nothing
// is applied automatically (B09-T11/T12).
async function generateProposals(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT lower(term) AS term, COUNT(*) AS n FROM curation_overrides
     WHERE field = 'entities' AND action = 'accept' AND term <> ''
     GROUP BY lower(term) HAVING COUNT(*) >= 3 ORDER BY n DESC LIMIT 20`
  ).all<{ term: string; n: number }>();
  const created: Array<Record<string, unknown>> = [];
  for (const row of rows.results) {
    const existing = await env.DB.prepare(
      `SELECT id FROM taxonomy_proposals WHERE dimension = 'entities' AND lower(term_id) = ? AND status = 'pending'`
    ).bind(row.term).first<{ id: string }>();
    if (existing) continue;
    const id = crypto.randomUUID();
    const suggestedID = row.term.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || `entity_${id.slice(0, 8)}`;
    const evidence = { human_correction_count: row.n, out_of_taxonomy_count: 0, confusion_pairs: [] };
    const impact = { dimension: "entities", requires_new_version: true, affected_links: row.n };
    await env.DB.prepare(
      `INSERT INTO taxonomy_proposals(id, kind, dimension, term_id, payload, status, revision, impact, submitted_at)
       VALUES (?, 'add_term', 'entities', ?, ?, 'pending', 1, ?, ?)`
    ).bind(id, suggestedID, JSON.stringify({ label: row.term, evidence }), JSON.stringify(impact), new Date().toISOString()).run();
    created.push({ id, term: row.term, evidence });
  }
  return reply({ created, scanned: rows.results.length, applied: false });
}

// taxonomyWithDisplayOverrides returns the executable vocabulary with approved
// display-only renames applied to labels. Definitions, ids and relations are
// unchanged, so the model input and every stored decision stay valid.
async function taxonomyWithDisplayOverrides(env: Env): Promise<Record<string, unknown>> {
  const vocabulary = taxonomyV2() as unknown as Record<string, unknown>;
  const rows = await env.DB.prepare(`SELECT term_id, dimension, label FROM taxonomy_display_overrides`).all<{ term_id: string; dimension: string; label: string }>();
  if (rows.results.length === 0) return vocabulary;
  const overlays = new Map(rows.results.map((row) => [`${row.dimension}:${row.term_id}`, row.label]));
  const result: Record<string, unknown> = { ...vocabulary };
  for (const dimension of ["topics", "forms", "uses", "content_functions", "carriers", "affordances"]) {
    const terms = vocabulary[dimension];
    if (!Array.isArray(terms)) continue;
    result[dimension] = terms.map((term) => {
      const label = overlays.get(`${dimension}:${(term as { id: string }).id}`);
      return label === undefined ? term : { ...(term as Record<string, unknown>), label, display_overridden: true };
    });
  }
  return result;
}

// applyProposal is the explicit application step for an approved proposal. Only
// display-only renames can be applied in place; a semantic change (new term,
// deprecation, relation) requires a new vocabulary version and is refused here
// instead of silently mutating the executable taxonomy (B05-T11).
async function applyProposal(request: Request, env: Env, id: string): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  const proposal = await env.DB.prepare(
    `SELECT id, kind, dimension, term_id, payload, status FROM taxonomy_proposals WHERE id = ?`
  ).bind(id).first<{ id: string; kind: string; dimension: string; term_id: string; payload: string; status: string }>();
  if (!proposal) return fail("not_found", 404);
  if (proposal.status !== "approved") return fail("not_approved", 409, { status: proposal.status });
  if (proposal.kind !== "rename_label") {
    return fail("requires_new_version", 409, {
      reason: "semantic taxonomy changes must ship as a new immutable vocabulary version; applying them in place would invalidate stored decisions"
    });
  }
  const payload = JSON.parse(proposal.payload) as { label?: unknown };
  if (typeof payload.label !== "string" || payload.label.trim().length === 0 || payload.label.length > 80) {
    return fail("invalid_proposal");
  }
  await env.DB.prepare(
    `INSERT INTO taxonomy_display_overrides(term_id, dimension, label, proposal_id, applied_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(term_id) DO UPDATE SET dimension=excluded.dimension, label=excluded.label,
       proposal_id=excluded.proposal_id, applied_at=excluded.applied_at`
  ).bind(proposal.term_id, proposal.dimension, payload.label.trim(), id, new Date().toISOString()).run();
  return reply({ id, applied: true, display_only: true, vocabulary_changed: false });
}

// getSelection reads the same effective view that the field-level override API
// derives. There is exactly one source of truth (decision + override log);
// link_selections_v2 is a query projection of it, never a parallel truth (F04).
async function getSelection(env: Env, id: number): Promise<Response> {
  const link = await env.DB.prepare(`SELECT personal_revision, why, curation_status FROM links WHERE id = ?`).bind(id)
    .first<{ personal_revision: number; why: string | null; curation_status: string | null }>();
  if (!link) return fail("not_found", 404);
  const { view, automatic, projected, stale } = await computeEffective(env, id);
  const selection: V2Selection = {
    topics: view.topics, content_functions: view.content_functions, carriers: view.carriers,
    affordances: view.affordances, form: view.form, use: view.use
  };
  return reply({
    id, revision: link.personal_revision, selection,
    // This is the same baseline used to derive view, before human overrides.
    // Return only the six selection dimensions; entity state is independent.
    automatic: { topics: automatic.topics, content_functions: automatic.content_functions,
      carriers: automatic.carriers, affordances: automatic.affordances, form: automatic.form, use: automatic.use },
    taxonomy_version: taxonomyV2().version, definition_version: taxonomyV2().definition_version,
    provenance: { source: projected ? "decision" : "legacy", overrides: view.reviewed, revision: view.revision, stale },
    v1_only: !projected,
    v1_projection: projectV1(selection),
    empty: view.empty, why: link.why, curation_status: link.curation_status
  });
}

// loadSelection reads the effective view. It exists for the v1 compatibility
// path, which needs the hidden v2 dimensions before applying a bounded write.
async function loadSelection(env: Env, id: number): Promise<V2Selection> {
  const { view } = await computeEffective(env, id);
  return {
    topics: view.topics, content_functions: view.content_functions, carriers: view.carriers,
    affordances: view.affordances, form: view.form, use: view.use
  };
}

async function patchSelection(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  const link = await env.DB.prepare(`SELECT id FROM links WHERE id = ?`).bind(id).first<{ id: number }>();
  if (!link) return fail("not_found", 404);
  const existing = await loadSelection(env, id);
  const candidate: V2Selection = {
    topics: body.topics === undefined ? existing.topics : body.topics as string[],
    content_functions: body.content_functions === undefined ? existing.content_functions : body.content_functions as string[],
    carriers: body.carriers === undefined ? existing.carriers : body.carriers as string[],
    affordances: body.affordances === undefined ? existing.affordances : body.affordances as string[],
    form: body.form === undefined ? existing.form : String(body.form),
    use: body.use === undefined ? existing.use : String(body.use),
  };
  const validated = validateV2Selection(candidate);
  if (!validated) return fail("invalid_selection");
  // The write is recorded as field-level human overrides and the effective view
  // is rebuilt from them, so a later read (or a second client) sees exactly
  // what this write meant.
  const result = await persistSelectionOverrides(env, id, validated, {
    source: "human", operationPrefix: typeof body.operation_key === "string" ? body.operation_key : `patch-${id}-${Date.now()}`,
    expectedRevision: Number.isSafeInteger(body.expected_revision) ? Number(body.expected_revision) : undefined,
    rejectAutomaticExtras: true
  });
  if ("conflict" in result) return fail("revision_conflict", 409, { revision: result.conflict });
  const { view } = await computeEffective(env, id);
  const selection: V2Selection = {
    topics: view.topics, content_functions: view.content_functions, carriers: view.carriers,
    affordances: view.affordances, form: view.form, use: view.use
  };
  return reply({ id, revision: result.revision, selection, v1_projection: projectV1(selection) });
}

// A v1 write can only express topics<=3 plus form/use. It must not clear the
// hidden dimensions or a fourth topic; when it cannot express the requested
// change unambiguously it reports a conflict instead of guessing.
async function patchSelectionV1(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  if (Object.keys(body).some((key) => !["topics", "form", "use", "operation_key"].includes(key))) return fail("invalid_v1_selection");
  const link = await env.DB.prepare(`SELECT id FROM links WHERE id = ?`).bind(id).first<{ id: number }>();
  if (!link) return fail("not_found", 404);
  const existing = await loadSelection(env, id);
  const payload: { topics?: string[]; form?: string; use?: string } = {};
  if (body.topics !== undefined) {
    if (!Array.isArray(body.topics) || body.topics.length > 3 || !body.topics.every((entry) => typeof entry === "string")) {
      return fail("invalid_v1_selection");
    }
    if (existing.topics.length > 3 && body.topics.length !== existing.topics.slice(0, 3).length) {
      // The v1 client cannot express a change to the folded topic set; protect
      // the hidden value and return an actionable conflict.
      return fail("hidden_value_conflict", 409, { hidden_topics: existing.topics.slice(3) });
    }
    payload.topics = body.topics;
  }
  if (body.form !== undefined) payload.form = String(body.form);
  if (body.use !== undefined) payload.use = String(body.use);
  const { selection } = applyV1Write(existing, payload);
  const validated = validateV2Selection(selection);
  if (!validated) return fail("invalid_v1_selection");
  const result = await persistSelectionOverrides(env, id, validated, {
    source: "legacy_unknown", operationPrefix: typeof body.operation_key === "string" ? body.operation_key : `patch-v1-${id}-${Date.now()}`,
    rejectAutomaticExtras: true
  });
  if ("conflict" in result) return fail("revision_conflict", 409, { revision: result.conflict });
  return reply({ id, revision: result.revision, v1_projection: projectV1(validated), preserved_hidden: true });
}

// --- Taxonomy proposals -----------------------------------------------------

async function listProposals(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT id, kind, dimension, term_id, payload, status, revision, impact, submitted_at, decided_at FROM taxonomy_proposals ORDER BY submitted_at DESC LIMIT 200`).all();
  return reply({ proposals: rows.results.map((row) => ({ ...row, impact: JSON.parse(String((row as { impact: string }).impact ?? "{}")) })) });
}

async function createProposal(request: Request, env: Env): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  const kind = body.kind;
  const dimension = body.dimension;
  const termID = body.term_id;
  if (!["add_term", "rename_label", "deprecate_term", "add_relation"].includes(String(kind)) ||
    !text(dimension, 40) || !text(termID, 40)) {
    return fail("invalid_proposal");
  }
  // The proposal must reference a real dimension.
  if (!(dimension in taxonomyV2())) return fail("invalid_proposal");
  const id = crypto.randomUUID();
  const proposal: TaxonomyProposal = {
    id, kind: kind as TaxonomyProposal["kind"], dimension, term_id: termID,
    payload: (body.payload as Record<string, unknown>) ?? {}, status: "pending", revision: 1,
    submitted_at: new Date().toISOString(),
  };
  const impact = proposalImpact(proposal);
  await env.DB.prepare(
    `INSERT INTO taxonomy_proposals(id, kind, dimension, term_id, payload, status, revision, impact, submitted_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, ?)`
  ).bind(id, proposal.kind, dimension, termID, JSON.stringify(proposal.payload), JSON.stringify(impact), proposal.submitted_at).run();
  // A proposal never mutates the vocabulary on its own.
  return reply({ id, status: "pending", impact, applied: false });
}

async function decideProposal(request: Request, env: Env, id: string): Promise<Response> {
  const body = await bodyOf(request);
  if (!body || !["approved", "rejected"].includes(String(body.decision))) return fail("invalid_decision");
  const existing = await env.DB.prepare(`SELECT status, revision FROM taxonomy_proposals WHERE id = ?`).bind(id)
    .first<{ status: string; revision: number }>();
  if (!existing) return fail("not_found", 404);
  if (existing.status !== "pending") return fail("already_decided", 409, { status: existing.status });
  if (body.expected_revision !== undefined && body.expected_revision !== existing.revision) {
    return fail("revision_conflict", 409, { revision: existing.revision });
  }
  await env.DB.prepare(`UPDATE taxonomy_proposals SET status = ?, decided_at = ?, revision = revision + 1 WHERE id = ? AND status = 'pending'`)
    .bind(body.decision, new Date().toISOString(), id).run();
  // Approval records the decision; enabling it in the executable vocabulary is
  // a separate, explicitly versioned step so a label change never re-evaluates
  // stored decisions implicitly.
  return reply({ id, status: body.decision, vocabulary_changed: false });
}

// --- Search helpers ---------------------------------------------------------

// selectionFilterSQL returns a parameterised WHERE fragment for a dimension
// filter. Same-dimension values are OR-ed; different dimensions are AND-ed.
export function selectionFilterSQL(filters: Partial<Record<"topics" | "content_functions" | "carriers" | "affordances", string[]>>): { clause: string; bindings: string[] } {
  const clauses: string[] = [];
  const bindings: string[] = [];
  for (const dimension of ["topics", "content_functions", "carriers", "affordances"] as const) {
    const values = filters[dimension];
    if (!values || values.length === 0) continue;
    const ors: string[] = [];
    for (const value of values) {
      if (!findTerm(dimension, value)) continue;
      ors.push(`EXISTS (SELECT 1 FROM json_each(s.${dimension}) WHERE value = ?)`);
      bindings.push(value);
    }
    if (ors.length > 0) clauses.push("(" + ors.join(" OR ") + ")");
  }
  return { clause: clauses.length > 0 ? " AND " + clauses.join(" AND ") : "", bindings };
}
