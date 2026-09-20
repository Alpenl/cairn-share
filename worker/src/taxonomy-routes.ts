import type { Env } from "./index";
import {
  applyV1Write, findTerm, proposalImpact, projectV1, taxonomyV2, validateTaxonomy, validateV2Selection,
  type TaxonomyProposal, type V2Selection
} from "./taxonomy-v2";

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
  // Vocabulary read: the Worker is the single executable source.
  if (path === "/api/v2/taxonomy") {
    if (request.method !== "GET") return fail("method_not_allowed", 405);
    return reply(taxonomyV2());
  }
  if (path === "/api/v2/taxonomy/validate") {
    const problems = validateTaxonomy();
    return reply({ ok: problems.length === 0, problems });
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

  return fail("not_found", 404);
}

async function getSelection(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT taxonomy_version, definition_version, topics, content_functions, carriers, affordances, form, use, provenance, revised_at
     FROM link_selections_v2 WHERE link_id = ?`).bind(id).first<Record<string, unknown>>();
  if (!row) {
    // Fall back to the v1 projection so an old link still reads.
    const link = await env.DB.prepare(`SELECT curation, classification, why, curation_status FROM links WHERE id = ?`).bind(id)
      .first<{ curation: string | null; classification: string | null; why: string | null; curation_status: string | null }>();
    if (!link) return fail("not_found", 404);
    const legacy = JSON.parse(link.curation ?? link.classification ?? "{}") as Partial<V2Selection>;
    return reply({
      id, selection: { ...EMPTY_SELECTION, topics: legacy.topics ?? [], form: legacy.form ?? "", use: legacy.use ?? "" },
      v1_only: true, why: link.why, curation_status: link.curation_status
    });
  }
  return reply({
    id,
    selection: {
      topics: parseList(row.topics), content_functions: parseList(row.content_functions),
      carriers: parseList(row.carriers), affordances: parseList(row.affordances),
      form: String(row.form ?? ""), use: String(row.use ?? "")
    },
    taxonomy_version: row.taxonomy_version, definition_version: row.definition_version,
    provenance: JSON.parse(String(row.provenance ?? "{}")), revised_at: row.revised_at,
    v1_projection: projectV1({
      topics: parseList(row.topics), content_functions: parseList(row.content_functions),
      carriers: parseList(row.carriers), affordances: parseList(row.affordances),
      form: String(row.form ?? ""), use: String(row.use ?? "")
    })
  });
}

async function loadSelection(env: Env, id: number): Promise<V2Selection> {
  const row = await env.DB.prepare(
    `SELECT topics, content_functions, carriers, affordances, form, use FROM link_selections_v2 WHERE link_id = ?`).bind(id).first<Record<string, unknown>>();
  if (!row) return { ...EMPTY_SELECTION };
  return {
    topics: parseList(row.topics), content_functions: parseList(row.content_functions),
    carriers: parseList(row.carriers), affordances: parseList(row.affordances),
    form: String(row.form ?? ""), use: String(row.use ?? "")
  };
}

async function persistSelection(env: Env, id: number, selection: V2Selection, provenance: Record<string, unknown>): Promise<void> {
  const vocabulary = taxonomyV2();
  await env.DB.prepare(
    `INSERT INTO link_selections_v2(link_id, taxonomy_version, definition_version, topics, content_functions, carriers, affordances, form, use, provenance, revised_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(link_id) DO UPDATE SET taxonomy_version=excluded.taxonomy_version, definition_version=excluded.definition_version,
       topics=excluded.topics, content_functions=excluded.content_functions, carriers=excluded.carriers,
       affordances=excluded.affordances, form=excluded.form, use=excluded.use,
       provenance=excluded.provenance, revised_at=excluded.revised_at`
  ).bind(id, vocabulary.version, vocabulary.definition_version,
    JSON.stringify(selection.topics), JSON.stringify(selection.content_functions),
    JSON.stringify(selection.carriers), JSON.stringify(selection.affordances),
    selection.form, selection.use, JSON.stringify(provenance), new Date().toISOString()).run();
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
  await persistSelection(env, id, validated, { source: "human", action: "patch_v2" });
  return reply({ id, selection: validated, v1_projection: projectV1(validated) });
}

// A v1 write can only express topics<=3 plus form/use. It must not clear the
// hidden dimensions or a fourth topic; when it cannot express the requested
// change unambiguously it reports a conflict instead of guessing.
async function patchSelectionV1(request: Request, env: Env, id: number): Promise<Response> {
  const body = await bodyOf(request);
  if (!body) return fail("invalid_json");
  if (Object.keys(body).some((key) => !["topics", "form", "use"].includes(key))) return fail("invalid_v1_selection");
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
  await persistSelection(env, id, validated, { source: "legacy_v1", action: "patch_v1" });
  return reply({ id, v1_projection: projectV1(validated), preserved_hidden: true });
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
