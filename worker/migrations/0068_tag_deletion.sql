-- Deletion differs from archival: immutable receipts suppress the stable ID
-- even if an old decision, legacy client or reset action proposes it again.
CREATE INDEX tag_catalog_deleted ON tag_catalog_operations(dimension,term_id,revision) WHERE action='delete';
DROP VIEW canonical_effective_tag_terms;
CREATE VIEW canonical_effective_tag_terms AS
SELECT links.id AS link_id,json_extract(j.value,'$.field') AS field,
  json_extract(j.value,'$.term') AS term,json_extract(j.value,'$.position') AS position
FROM links,json_each((SELECT json_group_array(json_object('field',e.field,'term',e.term,'position',e.position))
FROM (WITH
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
      WHEN 'carrier' THEN 'carriers' WHEN 'affordance' THEN 'affordances'
      WHEN 'resource_kind' THEN 'resource_kinds' ELSE field END AS field,
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
  SELECT (SELECT id FROM classification_decisions WHERE link_id=links.id ORDER BY id DESC LIMIT 1) AS decision_id,
    COALESCE((SELECT automatic FROM classification_decisions WHERE link_id=links.id ORDER BY id DESC LIMIT 1),
    json_object('topics',json(COALESCE(json_extract(links.classification,'$.topics'),'[]')),
      'form',COALESCE(json_extract(links.classification,'$.form'),''),
      'use',COALESCE(json_extract(links.classification,'$.use'),''))) AS automatic
), dimensions(field,single) AS (VALUES ('topics',0),('content_functions',0),('carriers',1),('affordances',0),('resource_kinds',0),('form',1),('use',1)),
automatic AS (
  SELECT field,single,j.value AS term,CAST(j.key AS INTEGER) AS position FROM baseline CROSS JOIN dimensions,
    json_each(CASE WHEN field IN ('form','use') THEN json_array(json_extract(automatic,'$.'||field))
      WHEN field='carriers' THEN json_array(json_extract(automatic,'$.carriers[0]'))
      ELSE COALESCE(json_extract(automatic,'$.'||field),'[]') END) j
    WHERE j.type='text' AND j.value<>''
      AND NOT EXISTS (SELECT 1 FROM ai_suggestion_holds h WHERE h.decision_id=baseline.decision_id
        AND h.field=dimensions.field AND h.term=j.value)
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
SELECT field,term,COALESCE((SELECT MIN(a.position) FROM allowed_automatic a
  WHERE a.field=effective.field AND a.term=effective.term),100000+(SELECT MIN(h.sequence) FROM history h
  WHERE h.field=effective.field AND h.term=effective.term),0) AS position FROM effective
WHERE NOT EXISTS (SELECT 1 FROM tag_catalog_operations d WHERE d.action='delete'
  AND d.dimension=CASE effective.field WHEN 'form' THEN 'forms' WHEN 'use' THEN 'uses' ELSE effective.field END
  AND d.term_id=effective.term)) e)) j;

CREATE INDEX custom_tag_deleted ON custom_tag_operations(tag_id) WHERE action='delete';
