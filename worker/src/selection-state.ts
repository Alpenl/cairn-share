import type { Env } from "./index";
import { effectiveView, effectiveOrigins, EMPTY_AUTOMATIC, normalizeField, validAssessment,
  type AutomaticView, type Override, type OverrideField } from "./domain";

const dimensions = ["topics", "content_functions", "carriers", "affordances", "form", "use"] as const;
const parse = <T>(value: string | null, fallback: T): T => {
  try { return value === null ? fallback : JSON.parse(value) as T; } catch { return fallback; }
};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

type Decision = { id: number; content_revision: number; automatic: string; policy_version: string;
  run_references_complete: number; runs: Array<{ coverage: string; evidence_coverage: string }> };
type Legacy = { payload: string | null; revision: number; provenance: string };
type Entity = { state: string; content_revision: number; content_hash: string; evidence_snapshot_id: number;
  entities: string; revision: number; snapshot_matches: number };
type Queue = { status: string; content_revision: number };
type Evidence = { id: number; content_hash: string; truncated: number; completeness: string };
type Row = { personal_revision: number; content_revision: number; classification: string | null;
  why: string | null; curation_status: string | null; decision: string | null; overrides: string;
  legacy: string | null; entity: string | null; queue: string | null; evidence: string | null };

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
export async function readSelectionSnapshot(env: Env, id: number) {
  const link = await env.DB.prepare(`SELECT l.personal_revision,l.content_revision,l.classification,l.why,l.curation_status,
    (SELECT json_object('id',d.id,'content_revision',d.content_revision,'automatic',d.automatic,'policy_version',d.policy_version,
      'run_references_complete',d.run_references_complete,'runs',
      (SELECT json_group_array(json_object('coverage',r.coverage,'evidence_coverage',r.evidence_coverage))
        FROM classification_decision_runs dr JOIN classification_runs r ON r.id=dr.run_id WHERE dr.decision_id=d.id))
      FROM classification_decisions d WHERE d.link_id=l.id ORDER BY d.id DESC LIMIT 1) AS decision,
    (SELECT json_group_array(json_object('field',o.field,'term',o.term,'action',o.action,'source',o.source,
      'confirmed',o.confirmed,'revision',o.revision)) FROM
      (SELECT field,term,action,source,confirmed,revision FROM curation_overrides WHERE link_id=l.id ORDER BY revision,id) o) AS overrides,
    (SELECT json_object('payload',h.payload,'revision',h.revision,'provenance',h.provenance)
      FROM legacy_curation_history h WHERE h.link_id=l.id ORDER BY h.id DESC LIMIT 1) AS legacy,
    (SELECT json_object('state',e.state,'content_revision',e.content_revision,'content_hash',e.content_hash,
      'evidence_snapshot_id',e.evidence_snapshot_id,'entities',e.entities,'revision',e.revision,
      'snapshot_matches',CASE WHEN s.link_id=e.link_id AND s.content_revision=e.content_revision AND s.content_hash=e.content_hash THEN 1 ELSE 0 END)
      FROM entity_states e LEFT JOIN evidence_snapshots s ON s.id=e.evidence_snapshot_id WHERE e.link_id=l.id) AS entity,
    (SELECT json_object('status',j.status,'content_revision',j.content_revision) FROM classification_jobs j WHERE j.link_id=l.id) AS queue,
    (SELECT json_object('id',s.id,'content_hash',s.content_hash,'truncated',s.truncated,'completeness',s.completeness)
      FROM evidence_snapshots s WHERE s.link_id=l.id AND s.content_revision=l.content_revision) AS evidence
    FROM links l WHERE l.id=?`).bind(id).first<Row>();
  if (!link) return null;
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
  const layered = [...legacyOverrides(parse<Legacy | null>(link.legacy, null)), ...overrides];
  const view = effectiveView(automatic, layered);
  const stale = decision !== null && decision.content_revision !== link.content_revision;
  const origins = effectiveOrigins(view, layered, decision ? "automatic" : "legacy_unknown");
  // Entities have their own run, independent of whether classification ran.
  origins.entities = effectiveOrigins(view, layered, "automatic").entities;
  const assessment = validAssessment(automatic.assessment) ? automatic.assessment : null;
  const runs = decision && Array.isArray(decision.runs) ? decision.runs : [];
  const partial = (field: "coverage" | "evidence_coverage") => {
    if (runs.some((run) => ["partial", "truncated", "empty"].includes(run[field]))) return true;
    return decision?.run_references_complete === 1 && runs.length > 0 && runs.every((run) => run[field] === "complete") ? false : null;
  };
  const fields = Object.fromEntries(dimensions.map((field) => {
    const candidates = assessment?.decisions.filter((entry) => entry.dimension === field) ?? [];
    const incomplete = assessment?.incomplete.includes(field) ?? false;
    const values = automatic[field];
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
    state: {
      version: 1, content_revision: link.content_revision, personal_revision: link.personal_revision,
      decision_id: decision?.id ?? null, decision_content_revision: decision?.content_revision ?? null,
      policy_version: decision?.policy_version ?? null,
      decision_answers_partial: partial("coverage"), decision_evidence_partial: partial("evidence_coverage"),
      classification_queue: queue, evidence, fields,
      entities: { ...origins.entities, status: entityStale ? "stale" : entity?.state ?? "not_run",
        recorded_state: entity?.state ?? "not_run", content_revision: entity?.content_revision ?? null,
        evidence_snapshot_id: entity?.evidence_snapshot_id ?? null, revision: entity?.revision ?? 0, automatic: automatic.entities }
    }
  };
}
