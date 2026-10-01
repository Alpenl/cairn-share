import type { Env } from "./index";
import { findTerm } from "./taxonomy-v2";

// Observations are correction samples, not estimates of population error.
// The exposure denominator is recorded at the same human operation as its
// correction; no current AI result is substituted for that historical basis.
export async function tagQuality(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const since = params.get("since");
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if ([...params.keys()].some(k => k !== "since" || params.getAll(k).length !== 1) ||
    since !== null && (!Number.isFinite(Date.parse(since)) || !/^\d{4}-\d\d-\d\dT/.test(since)))
    return new Response(JSON.stringify({ error: "invalid_query" }), { status: 400, headers });
  const rows = await env.DB.prepare(`WITH
    operations AS MATERIALIZED (SELECT o.* FROM tag_operations o WHERE (? IS NULL OR o.created_at>=?)
      AND NOT EXISTS(SELECT 1 FROM json_each(o.actions) a WHERE json_extract(a.value,'$.action')='undo')
      AND NOT EXISTS(SELECT 1 FROM tag_operations reverted WHERE reverted.reverts_operation=o.operation_key)),
    facts AS MATERIALIZED (SELECT f.operation_id,f.term,f.action,f.source,
      CASE f.field WHEN 'topic' THEN 'topics' WHEN 'resource_kind' THEN 'resource_kinds' WHEN 'content_function' THEN 'content_functions'
        WHEN 'carrier' THEN 'carriers' WHEN 'affordance' THEN 'affordances' ELSE f.field END AS field
      FROM tag_change_facts f WHERE (? IS NULL OR f.created_at>=?)
      AND NOT EXISTS(SELECT 1 FROM tag_operations reverted WHERE reverted.reverts_operation=f.operation_id)
      AND NOT EXISTS(SELECT 1 FROM tag_operations o,json_each(o.actions) a WHERE o.operation_key=f.operation_id AND json_extract(a.value,'$.action')='undo')),
    exposures AS MATERIALIZED (SELECT DISTINCT o.operation_key,fields.key AS field,json_extract(v.value,'$.term') AS term
      FROM operations o,json_each(o.context,'$.basis.fields') fields,json_each(fields.value,'$.values') v
      WHERE json_extract(v.value,'$.origin')='automatic' AND json_extract(v.value,'$.term')<>''),
    correction_facts AS (SELECT * FROM facts UNION ALL SELECT f.operation_id,e.term,'reject',f.source,f.field
      FROM facts f JOIN exposures e ON e.operation_key=f.operation_id AND e.field=f.field
      WHERE f.action='set_empty' AND f.term=''),
    terms AS (SELECT field,term FROM effective_tag_memberships UNION SELECT field,term FROM facts WHERE field<>'operation' AND term<>''
      UNION SELECT field,term FROM exposures),
    corrections AS (SELECT f.field,f.term,
      SUM(f.action='accept' AND f.source='human') AS additions,SUM(f.action='reject' AND f.source='human') AS rejections,
      COUNT(DISTINCT CASE WHEN f.action='reject' AND f.source='human' AND EXISTS(SELECT 1 FROM exposures e
        WHERE e.operation_key=f.operation_id AND e.field=f.field AND e.term=f.term) THEN f.operation_id END) AS rejected_automatic,
      SUM(f.action='accept' AND f.source='human' AND EXISTS(SELECT 1 FROM operations o,json_each(o.actions) a
        WHERE o.operation_key=f.operation_id AND json_extract(a.value,'$.action')='confirm' AND json_extract(a.value,'$.tag_ref')='system/'||f.field||'/'||f.term)) AS confirmations,
      SUM(f.action IN ('reset','restore_auto') AND f.source='human') AS restorations FROM correction_facts f GROUP BY f.field,f.term)
    SELECT 'coverage' AS kind,json_object('human_operations',(SELECT COUNT(*) FROM operations),
      'human_facts',(SELECT COUNT(*) FROM facts WHERE source='human'),
      'unknown_facts',(SELECT COUNT(*) FROM facts WHERE source<>'human')) AS payload
    UNION ALL SELECT 'term',json_object('dimension',t.field,'term_id',t.term,'tag_ref','system/'||t.field||'/'||t.term,
      'current_count',(SELECT COUNT(*) FROM effective_tag_memberships m WHERE m.field=t.field AND m.term=t.term),
      'observed_automatic',(SELECT COUNT(*) FROM exposures e WHERE e.field=t.field AND e.term=t.term),
      'additions',COALESCE(c.additions,0)-COALESCE(c.confirmations,0),'rejections',COALESCE(c.rejections,0),
      'rejected_automatic',COALESCE(c.rejected_automatic,0),'confirmations',COALESCE(c.confirmations,0),'restorations',COALESCE(c.restorations,0))
      FROM terms t LEFT JOIN corrections c ON c.field=t.field AND c.term=t.term
    UNION ALL SELECT 'confusion',json_object('dimension',CASE WHEN substr(json_extract(a.value,'$.from_tag_ref'),1,instr(substr(json_extract(a.value,'$.from_tag_ref'),8),'/')+7)
        =substr(json_extract(a.value,'$.to_tag_ref'),1,instr(substr(json_extract(a.value,'$.to_tag_ref'),8),'/')+7)
        THEN substr(json_extract(a.value,'$.from_tag_ref'),8,instr(substr(json_extract(a.value,'$.from_tag_ref'),8),'/')-1) ELSE 'cross_dimension' END,
      'from_tag_ref',json_extract(a.value,'$.from_tag_ref'),'to_tag_ref',json_extract(a.value,'$.to_tag_ref'),'count',COUNT(*))
      FROM operations o,json_each(o.actions) a WHERE json_extract(a.value,'$.action')='replace'
      GROUP BY json_extract(a.value,'$.from_tag_ref'),json_extract(a.value,'$.to_tag_ref')
    UNION ALL SELECT 'retrieval',json_object('total_links',(SELECT COUNT(*) FROM links))
    UNION ALL SELECT 'dimension',json_object('dimension',field,'tagged_links',COUNT(DISTINCT link_id),'distinct_terms',COUNT(DISTINCT term),
      'largest_term_count',(SELECT MAX(n) FROM (SELECT COUNT(*) n FROM effective_tag_memberships x WHERE x.field=m.field GROUP BY x.term)))
      FROM effective_tag_memberships m GROUP BY field`).bind(since, since, since, since).all<{ kind: string; payload: string }>();
  const by = (kind: string) => rows.results.filter(r => r.kind === kind).map(r => JSON.parse(r.payload) as Record<string, unknown>);
  const terms = by("term").map(t => ({ ...t, dimension: String(t.dimension), term_id: String(t.term_id), label: findTerm(t.dimension === "form" ? "forms" : t.dimension === "use" ? "uses" : String(t.dimension), String(t.term_id))?.label ?? t.term_id,
    rejection_rate: Number(t.observed_automatic) > 0 ? Number(t.rejected_automatic) / Number(t.observed_automatic) : null }))
    .sort((a, b) => String(a.dimension).localeCompare(String(b.dimension)) || String(a.term_id).localeCompare(String(b.term_id)));
  return new Response(JSON.stringify({ version: 1, period: { since, until: new Date().toISOString() }, coverage: by("coverage")[0],
    terms, confusion_pairs: by("confusion"), retrieval: { ...by("retrieval")[0], dimensions: by("dimension") } }), { headers });
}
