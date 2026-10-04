import type { Env } from "./index";
import { effectiveView, effectiveOrigins, EMPTY_AUTOMATIC, normalizeField, validAssessment,
  type AutomaticView, type Override, type OverrideField } from "./domain";

const dimensions = ["topics", "content_functions", "carriers", "affordances", "form", "use", "resource_kinds"] as const;
const parse = <T>(value: string | null, fallback: T): T => {
  try { return value === null ? fallback : JSON.parse(value) as T; } catch { return fallback; }
};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

type Decision = { id: number; content_revision: number; automatic: string; policy_version: string;
  run_references_complete: number; runs: Array<{ coverage: string; evidence_coverage: string }> };
type Legacy = { id: number; payload: string | null; revision: number; provenance: string };
type Entity = { state: string; content_revision: number; content_hash: string; evidence_snapshot_id: number;
  entities: string; observations: string; revision: number; updated_at: string; snapshot_matches: number };
type Queue = { status: string; content_revision: number };
type Evidence = { id: number; content_hash: string; truncated: number; completeness: string };
type Row = { id: number; personal_revision: number; content_revision: number; classification: string | null;
  why: string | null; curation_status: string | null; decision: string | null; overrides: string;
  legacy: string | null; entity: string | null; queue: string | null; evidence: string | null };

export type SummaryCustomTag = { id: string; owner_id: string; label: string; revision: number; status: string };
export type TagSummary = { topics: string[]; resource_kinds: string[]; content_functions: string[]; custom_tags: SummaryCustomTag[] };
export type TagSummaryRow = { tag_topics: string; tag_resources: string; tag_functions: string; tag_custom_tags: string };
export type TagOriginsRow = { field: string; term: string; action: string; actions: string | null; context: string | null };
export type TagDetailRow = TagSummaryRow & { tag_origins: string; source_available: number };

// Membership is maintained transactionally from canonical facts by 0049.
// Ordering is the automatic order followed by surviving manual action order.
export function tagSummaryColumns(alias = "links", ownerSQL = "'default'"): string {
  const terms = (field: string, name: string) => `(SELECT json_group_array(term) FROM
    (SELECT term FROM effective_tag_memberships WHERE link_id=${alias}.id AND field='${field}' ORDER BY position,term)) AS ${name}`;
  return `${terms("topics", "tag_topics")},${terms("resource_kinds", "tag_resources")},${terms("content_functions", "tag_functions")},
    (SELECT json_group_array(json_object('id',t.id,'owner_id',t.owner_id,'label',t.label,'revision',t.revision,'status',t.status))
      FROM (SELECT t.id,t.owner_id,t.label,t.revision,t.status FROM custom_tag_links a JOIN custom_tags t ON t.id=a.tag_id
        WHERE a.link_id=${alias}.id AND t.owner_id=${ownerSQL} ORDER BY t.label,t.id) t) AS tag_custom_tags`;
}
export function tagSummaryFromRow(row: TagSummaryRow): TagSummary {
  return { topics: strings(parse(row.tag_topics, [])), resource_kinds: strings(parse(row.tag_resources, [])),
    content_functions: strings(parse(row.tag_functions, [])), custom_tags: parse<SummaryCustomTag[]>(row.tag_custom_tags, []) };
}
export async function readTagSummaries(env: Env,
  selection: number[] | { clauses: string[]; bindings: Array<string | number> }, owner = "default") {
  const ids = Array.isArray(selection) ? selection : null;
  if (ids && !ids.length) return { summaries: new Map<number, TagSummary>() };
  const filters = Array.isArray(selection) ? null : selection;
  const where = ids ? "links.id IN (SELECT value FROM json_each(?))" : filters!.clauses.join(" AND ") || "1";
  const bindings = ids ? [JSON.stringify(ids)] : filters!.bindings;
  const rows = await env.DB.prepare(`SELECT links.id,${tagSummaryColumns("links", "?")}
    FROM links WHERE ${where} ORDER BY links.id DESC`).bind(owner, ...bindings).all<TagSummaryRow & { id: number }>();
  return { summaries: new Map(rows.results.map(row => [row.id, tagSummaryFromRow(row)])), meta: rows.meta };
}

// The reading endpoint extends the same statement that folds the effective
// selection. Keep these columns explicit: links also holds private source and
// lease material which a detail read must not fetch or expose.
const readingColumns = `,l.url,l.note,l.created_at,l.curation,l.enrichment_status,l.enrichment_attempts,
  l.enrichment_next_retry_at,l.enrichment_paid_uncertain,l.enrichment_paid_stage,
  l.ai_title,l.original_language,
  CASE WHEN l.app_body_revision=? THEN NULL ELSE l.original_text END AS original_text,
  CASE WHEN l.app_body_revision=? THEN NULL ELSE l.translated_text END AS translated_text,
  CASE WHEN l.app_body_revision=? THEN NULL ELSE (SELECT p.formatted_content FROM content_presentations p WHERE p.link_id=l.id AND p.status='completed') END AS formatted_content,
  (SELECT p.status FROM content_presentations p WHERE p.link_id=l.id) AS formatting_status,
  l.summary,l.related_links,
  l.images,l.enrichment_model,l.enrichment_error,l.enrichment_updated_at,l.enriched_at,
  l.app_body_revision`;

function legacyOverrides(source: Legacy | null): Override[] {
  if (!source || source.provenance !== "legacy_unknown") return [];
  const legacy = parse<Record<string, unknown> | null>(source.payload, null);
  const out: Override[] = [];
  const add = (field: OverrideField, action: Override["action"], term = "") =>
    out.push({ field, term, action, source: "legacy_unknown", confirmed: false, revision: source.revision });
  for (const field of ["topics", "form", "use"] as const) {
    if (legacy === null) { add(field, "reset"); continue; }
    if (!(field in legacy)) continue;
    add(field, "set_empty");
    for (const term of strings(field === "topics" ? legacy.topics : [legacy[field]])) if (term !== "") add(field, "accept", term);
  }
  return out;
}

// One SQLite statement gives every value and its identity the same read
// snapshot. Separate awaited SELECTs can attach revision N+1 to values from N,
// even when every individual query is correct. Never read mutable projections.
function selectionSQL(where: string, includeReading: boolean, extraColumns = ""): string {
  return `SELECT l.id,l.personal_revision,l.content_revision,l.classification,l.why,l.curation_status,
    (SELECT json_object('id',d.id,'content_revision',d.content_revision,'automatic',d.automatic,'policy_version',d.policy_version,
      'run_references_complete',d.run_references_complete,'runs',
      (SELECT json_group_array(json_object('coverage',r.coverage,'evidence_coverage',r.evidence_coverage))
        FROM classification_decision_runs dr JOIN classification_runs r ON r.id=dr.run_id WHERE dr.decision_id=d.id))
      FROM classification_decisions d WHERE d.link_id=l.id ORDER BY d.id DESC LIMIT 1) AS decision,
    (SELECT json_group_array(json_object('field',o.field,'term',o.term,'action',o.action,'source',o.source,
      'confirmed',o.confirmed,'revision',o.revision)) FROM
      (SELECT field,term,action,source,confirmed,revision FROM curation_overrides WHERE link_id=l.id ORDER BY revision,id) o) AS overrides,
    (SELECT json_object('id',h.id,'payload',h.payload,'revision',h.revision,'provenance',h.provenance)
      FROM legacy_curation_history h WHERE h.link_id=l.id ORDER BY h.id DESC LIMIT 1) AS legacy,
    (SELECT json_object('state',e.state,'content_revision',e.content_revision,'content_hash',e.content_hash,
      'evidence_snapshot_id',e.evidence_snapshot_id,'entities',e.entities,'observations',e.observations,'revision',e.revision,
      'updated_at',e.updated_at,
      'snapshot_matches',CASE WHEN s.link_id=e.link_id AND s.content_revision=e.content_revision AND s.content_hash=e.content_hash THEN 1 ELSE 0 END)
      FROM entity_states e LEFT JOIN evidence_snapshots s ON s.id=e.evidence_snapshot_id WHERE e.link_id=l.id) AS entity,
    (SELECT json_object('status',j.status,'content_revision',j.content_revision) FROM classification_jobs j WHERE j.link_id=l.id) AS queue,
    (SELECT json_object('id',s.id,'content_hash',s.content_hash,'truncated',s.truncated,'completeness',s.completeness)
      FROM evidence_snapshots s WHERE s.link_id=l.id AND s.content_revision=l.content_revision) AS evidence
    ${includeReading ? readingColumns : ""}${extraColumns}
    FROM links l WHERE ${where}`;
}

export async function readSelectionSnapshot(env: Env, id: number, includeReading = false, knownBodyRevision = -1, includeTags = false, includeTagDetails = false) {
  const detailColumns = includeTagDetails ? `,
    CASE WHEN length(trim(COALESCE(l.original_text,'')))>0 THEN 1 ELSE 0 END AS source_available,
    (SELECT json_group_array(json_object('field',f.field,'term',f.term,'action',f.action,'actions',o.actions,
      'context',CASE WHEN o.context IS NULL THEN NULL ELSE json_object('restored_actions',json_extract(o.context,'$.restored_actions')) END))
      FROM (SELECT field,term,action,operation_id FROM tag_change_facts
        WHERE link_id=l.id AND revision<=l.personal_revision AND field<>'operation' ORDER BY revision,id) f
      LEFT JOIN tag_operations o ON o.operation_key=f.operation_id) AS tag_origins` : "";
  const link = await env.DB.prepare(selectionSQL("l.id=?", includeReading,
    (includeTags ? `,${tagSummaryColumns("l")}` : "") + detailColumns))
    .bind(...(includeReading ? [knownBodyRevision, knownBodyRevision, knownBodyRevision, id] : [id])).first<Row>();
  return link ? selectionFromRow(link) : null;
}

// A single SQLite read snapshot supplies every exported view. The outer IN is
// a bounded set query; no per-link HTTP call or per-link SQL statement runs.
export async function readSelectionSnapshots(env: Env, ids: number[],
  timer?: { measure<T>(name: string, operation: () => Promise<T>): Promise<T> }) {
  const query = () => env.DB.prepare(selectionSQL(`l.id IN (${ids.map(() => "?").join(",")})`, false))
    .bind(...ids).all<Row>();
  const result = timer ? await timer.measure("db", query) : await query();
  return { snapshots: new Map(result.results.map((row) => [row.id, selectionFromRow(row)])), meta: result.meta };
}

// One statement captures selection, origin state, URL/note, custom definitions,
// total and the collection version. A delete/edit cannot split an exported row
// across read snapshots. Pagination validates this version in the route.
export async function readSelectionExport(env: Env, filters: { clauses: string[]; bindings: Array<string | number> },
  limit: number, beforeId?: number) {
  const matched = filters.clauses.join(" AND ") || "1";
  const rowsSQL = selectionSQL(`l.id IN (SELECT id FROM matched)${beforeId ? " AND l.id<?" : ""}`, false,
    `,l.url,l.note,${tagSummaryColumns("l")}`) + " ORDER BY l.id DESC LIMIT ?";
  const fields = ["id", "personal_revision", "content_revision", "classification", "why", "curation_status", "decision",
    "overrides", "legacy", "entity", "queue", "evidence", "url", "note", "tag_topics", "tag_resources", "tag_functions", "tag_custom_tags"];
  const rowJSON = fields.map(field => `'${field}',e.${field}`).join(",");
  const envelope = await env.DB.prepare(`WITH matched AS MATERIALIZED (SELECT id FROM links WHERE ${matched})
    SELECT COALESCE((SELECT value FROM cache_metadata WHERE key='links_generation'),0) AS version,
      (SELECT COUNT(*) FROM matched) AS total,
      (SELECT json_group_array(json_object(${rowJSON})) FROM (${rowsSQL}) e) AS rows`)
    .bind(...filters.bindings, ...(beforeId ? [beforeId] : []), limit)
    .first<{ version: number; total: number; rows: string }>();
  const rows = parse<Array<Row & TagSummaryRow & { url: string; note: string }>>(envelope?.rows ?? null, []);
  return { version: envelope?.version ?? 0, total: envelope?.total ?? 0,
    rows: rows.map(row => ({ row, snapshot: selectionFromRow(row), custom_tags: tagSummaryFromRow(row).custom_tags })) };
}

function selectionFromRow(link: Row) {
  const decision = parse<Decision | null>(link.decision, null);
  const entity = parse<Entity | null>(link.entity, null);
  const queue = parse<Queue | null>(link.queue, null);
  const evidence = parse<Evidence | null>(link.evidence, null);
  const generated = parse<Record<string, unknown> | null>(link.classification, {}) ?? {};
  const automatic: AutomaticView = decision ? parse<AutomaticView>(decision.automatic, { ...EMPTY_AUTOMATIC }) : {
    ...EMPTY_AUTOMATIC, topics: strings(generated.topics),
    form: typeof generated.form === "string" ? generated.form : "", use: typeof generated.use === "string" ? generated.use : ""
  };
  const entityStale = entity !== null && entity.state !== "not_run" && (entity.content_revision !== link.content_revision || entity.snapshot_matches !== 1);
  automatic.entities = entity && !entityStale && ["completed_empty", "completed_nonempty"].includes(entity.state)
    ? strings(parse<unknown>(entity.entities, [])) : [];
  const overrides = parse<Array<Omit<Override, "confirmed"> & { confirmed: number }>>(link.overrides, [])
    .flatMap((entry): Override[] => {
      const field = normalizeField(entry.field);
      return field ? [{ ...entry, field, confirmed: entry.confirmed === 1 }] : [];
    });
  const legacy = parse<Legacy | null>(link.legacy, null);
  const layered = [...legacyOverrides(legacy), ...overrides];
  const view = effectiveView(automatic, layered);
  const stale = decision !== null && decision.content_revision !== link.content_revision;
  const origins = effectiveOrigins(view, layered, decision ? "automatic" : "legacy_unknown");
  // Entities have their own run, independent of whether classification ran.
  origins.entities = effectiveOrigins(view, layered, "automatic").entities;
  // Read provenance in the same snapshot as effective values. Expose a bounded
  // display contract, not private cache requests or the entire catalog.
  const storedObservations = parse<Array<Record<string, any>>>(entity?.observations ?? null, []);
  const observations = (Array.isArray(storedObservations) ? storedObservations : []).flatMap((o) => {
    if (!o || typeof o !== "object" || !o.candidate || typeof o.candidate.surface !== "string") return [];
    return [{ candidate: o.candidate, decision: o.decision, canonical_state: o.canonical_state,
      canonical_id: o.canonical_id ?? null, canonical_label: o.canonical_label ?? null,
      canonical_kind: o.canonical_kind ?? null, canonical_evidence: o.canonical_evidence,
      catalog_version: o.catalog_version,
      effective: !entityStale && entity?.state === "completed_nonempty" && o.decision === "relevant" && view.entities.includes(o.candidate.surface) }];
  });
  const assessment = validAssessment(automatic.assessment) ? automatic.assessment : null;
  const runs = decision && Array.isArray(decision.runs) ? decision.runs : [];
  const partial = (field: "coverage" | "evidence_coverage") => {
    if (runs.some((run) => ["partial", "truncated", "empty"].includes(run[field]))) return true;
    return decision?.run_references_complete === 1 && runs.length > 0 && runs.every((run) => run[field] === "complete") ? false : null;
  };
  const fields = Object.fromEntries(dimensions.map((field) => {
    const candidates = assessment?.decisions.filter((entry) => entry.dimension === field) ?? [];
    const incomplete = assessment?.incomplete.includes(field) ?? false;
    const values = automatic[field] ?? [];
    let status = "unknown";
    if (stale) status = "stale";
    else if (!decision && link.classification === null) {
      status = queue?.content_revision === link.content_revision && ["failed", "exhausted"].includes(queue.status) ? "failed" : "not_run";
    } else if (assessment) {
      if (incomplete) status = "not_run";
      else if (candidates.length > 0) {
        status = values.length > 0 ? "completed_nonempty" : candidates.some((entry) => entry.verdict === "abstained") ? "abstained" : "completed_empty";
      }
    }
    return [field, { ...origins[field], status, assessment_available: assessment !== null, incomplete, candidates }];
  }));
  return {
    link, view, automatic, decisionId: decision?.id ?? 0, projected: decision !== null, stale, contentRevision: link.content_revision,
    entity, entityStale, overrides: layered,
    projectionInput: {
      overrides: layered,
      decisionId: decision?.id ?? 0,
      entityRevision: entity?.revision ?? 0,
      entity,
      legacyId: legacy?.id ?? 0,
      classification: link.classification
    },
    state: {
      version: 1, content_revision: link.content_revision, personal_revision: link.personal_revision,
      decision_id: decision?.id ?? null, decision_content_revision: decision?.content_revision ?? null,
      policy_version: decision?.policy_version ?? null,
      decision_answers_partial: partial("coverage"), decision_evidence_partial: partial("evidence_coverage"),
      classification_queue: queue, evidence, fields,
      entities: { ...origins.entities, status: entityStale ? "stale" : entity?.state ?? "not_run",
        recorded_state: entity?.state ?? "not_run", content_revision: entity?.content_revision ?? null,
        evidence_snapshot_id: entity?.evidence_snapshot_id ?? null, revision: entity?.revision ?? 0, automatic: automatic.entities,
        observations_version: 1, observations }
    }
  };
}
