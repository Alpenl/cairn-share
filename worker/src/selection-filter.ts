import { findTerm } from "./taxonomy-v2";

// Correlated with the outer links row. Every source is read in the same SQLite
// statement; mutable projection caches are deliberately not input. Restrict the
// histories to this link before ordering them, using the existing link indexes.
// Keep this fold aligned with domain.effectiveView and selection-state.ts.
export const SELECTION_TERMS_SQL = `WITH
legacy AS (
  SELECT revision, CASE WHEN json_valid(payload) THEN payload ELSE 'null' END AS payload
  FROM legacy_curation_history WHERE link_id=links.id
    AND id=(SELECT MAX(id) FROM legacy_curation_history WHERE link_id=links.id)
    AND provenance='legacy_unknown'
), fields(field) AS (VALUES ('topics'),('form'),('use')),
legacy_fields AS (
  SELECT revision,field,payload,CASE WHEN field='topics'
    THEN CASE WHEN json_type(payload,'$.topics')='array' THEN json_extract(payload,'$.topics') ELSE '[]' END
    ELSE json_array(json_extract(payload,'$.'||field)) END AS terms
  FROM legacy CROSS JOIN fields
  WHERE json_type(payload)='null' OR json_type(payload,'$.'||field) IS NOT NULL
), raw_events AS (
  SELECT revision,1 AS layer,id AS ordinal,
    CASE field WHEN 'topic' THEN 'topics' WHEN 'content_function' THEN 'content_functions'
      WHEN 'carrier' THEN 'carriers' WHEN 'affordance' THEN 'affordances' ELSE field END AS field,
    term,action FROM curation_overrides WHERE link_id=links.id
  UNION ALL
  SELECT revision,0,0,field,'',CASE WHEN json_type(payload)='null' THEN 'reset' ELSE 'set_empty' END FROM legacy_fields
  UNION ALL
  SELECT revision,0,CAST(j.key AS INTEGER)+1,field,j.value,'accept'
    FROM legacy_fields,json_each(terms) j WHERE j.type='text' AND j.value<>''
), events AS (
  SELECT field,term,action,ROW_NUMBER() OVER (PARTITION BY field ORDER BY revision,layer,ordinal) AS sequence FROM raw_events
), barriers AS (
  SELECT field,MAX(sequence) AS sequence FROM events
    WHERE action='set_empty' OR (action='reset' AND term='') GROUP BY field
), active AS (
  SELECT e.* FROM events e LEFT JOIN barriers b ON b.field=e.field
    WHERE e.term<>'' AND e.sequence>COALESCE(b.sequence,0)
), history AS (
  SELECT e.* FROM active e WHERE e.action IN ('accept','reject')
    AND NOT EXISTS (SELECT 1 FROM active r WHERE r.field=e.field AND r.term=e.term AND r.action='reset' AND r.sequence>e.sequence)
), baseline AS (
  SELECT COALESCE((SELECT automatic FROM classification_decisions WHERE link_id=links.id ORDER BY id DESC LIMIT 1),
    json_object('topics',json(COALESCE(json_extract(links.classification,'$.topics'),'[]')),
      'form',COALESCE(json_extract(links.classification,'$.form'),''),
      'use',COALESCE(json_extract(links.classification,'$.use'),''))) AS automatic
), dimensions(field,single) AS (VALUES ('topics',0),('content_functions',0),('carriers',1),('affordances',0),('form',1),('use',1)),
automatic AS (
  SELECT field,single,j.value AS term FROM baseline CROSS JOIN dimensions,
    json_each(CASE WHEN field IN ('form','use') THEN json_array(json_extract(automatic,'$.'||field))
      WHEN field='carriers' THEN json_array(json_extract(automatic,'$.carriers[0]'))
      ELSE COALESCE(json_extract(automatic,'$.'||field),'[]') END) j
    WHERE j.type='text' AND j.value<>''
), allowed_automatic AS (
  SELECT a.* FROM automatic a LEFT JOIN barriers b ON b.field=a.field
    LEFT JOIN events barrier ON barrier.field=b.field AND barrier.sequence=b.sequence
    WHERE barrier.action IS NOT 'set_empty' OR EXISTS (
      SELECT 1 FROM active r WHERE r.field=a.field AND r.term=a.term AND r.action='reset')
), multi_candidates AS (
  SELECT field,term FROM allowed_automatic WHERE single=0
  UNION SELECT h.field,h.term FROM history h JOIN dimensions d ON d.field=h.field WHERE d.single=0 AND h.action='accept'
), single_accept AS (
  SELECT h.* FROM history h JOIN dimensions d ON d.field=h.field WHERE d.single=1 AND h.action='accept'
    AND h.sequence=(SELECT MAX(a.sequence) FROM history a WHERE a.field=h.field AND a.action='accept')
), single_candidates AS (
  SELECT field,term,sequence FROM single_accept
  UNION ALL SELECT a.field,a.term,0 FROM allowed_automatic a WHERE a.single=1
    AND NOT EXISTS (SELECT 1 FROM single_accept s WHERE s.field=a.field)
), effective AS (
  SELECT c.field,c.term FROM multi_candidates c WHERE COALESCE((
    SELECT h.action FROM history h WHERE h.field=c.field AND h.term=c.term ORDER BY h.sequence DESC LIMIT 1),'')<>'reject'
  UNION ALL
  SELECT c.field,c.term FROM single_candidates c WHERE NOT EXISTS (
    SELECT 1 FROM history h WHERE h.field=c.field AND h.term=c.term AND h.action='reject' AND h.sequence>c.sequence)
)
SELECT field,term FROM effective`;

const dimensions = ["topics", "content_functions", "carriers", "affordances"] as const;
export const SELECTION_FILTER_KEYS = ["topic", "form", "use", ...dimensions, "entity_state"];

export function selectionFilters(params: URLSearchParams): { clauses: string[]; bindings: string[] } | null {
  const groups: Array<{ field: string; terms: string[] }> = [];
  for (const key of ["topic", "form", "use", ...dimensions] as const) {
    if (!params.has(key)) continue;
    const entries = params.getAll(key);
    // Reject ambiguity and malformed/unknown terms instead of broadening a
    // query. Known deprecated IDs remain searchable for historical records.
    if (entries.length !== 1 || entries[0].length > 1024) return null;
    const terms = entries[0].split(',');
    const legacy = ["topic", "form", "use"].includes(key);
    const field = key === "topic" ? "topics" : key;
    const dimension = key === "form" ? "forms" : key === "use" ? "uses" : field;
    if ((legacy && terms.length !== 1) || terms.length > 64 || terms.some(term => !findTerm(dimension, term))) return null;
    const existing = groups.find(group => group.field === field);
    if (existing) existing.terms = [...new Set([...existing.terms, ...terms])];
    else groups.push({ field, terms: [...new Set(terms)] });
  }
  const clauses: string[] = [], bindings: string[] = [];
  if (groups.length) {
    // One bound JSON value keeps the D1 bind count bounded even for combined
    // dimensions. Every group must match, with OR inside its terms array.
    clauses.push(`(SELECT COUNT(DISTINCT effective.field) FROM (${SELECTION_TERMS_SQL}) effective
      JOIN json_each(?) requested ON effective.field=json_extract(requested.value,'$.field')
        AND effective.term IN (SELECT value FROM json_each(requested.value,'$.terms'))) = ${groups.length}`);
    bindings.push(JSON.stringify(groups));
  }
  if (params.has("entity_state")) {
    const entries = params.getAll("entity_state");
    const states = entries[0].split(',');
    if (entries.length !== 1 || states.length > 5 || states.some(state => !["not_run","failed","completed_empty","completed_nonempty","stale"].includes(state))) return null;
    clauses.push(`COALESCE((SELECT CASE WHEN e.state<>'not_run' AND
      (e.content_revision<>links.content_revision OR NOT EXISTS (
        SELECT 1 FROM evidence_snapshots s WHERE s.id=e.evidence_snapshot_id AND s.link_id=e.link_id
          AND s.content_revision=e.content_revision AND s.content_hash=e.content_hash))
      THEN 'stale' ELSE e.state END FROM entity_states e WHERE e.link_id=links.id),'not_run')
      IN (SELECT value FROM json_each(?))`);
    bindings.push(JSON.stringify([...new Set(states)]));
  }
  return { clauses, bindings };
}
