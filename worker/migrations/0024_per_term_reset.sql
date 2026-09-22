-- A term reset after set_empty re-admits just that automatic term. It also
-- ends the explicit-empty state, even if that term is not currently proposed.
-- Keep the independent entity snapshot identity checks from 0019.
DROP VIEW effective_entity_terms;
CREATE VIEW effective_entity_terms AS
WITH events AS (
  SELECT link_id,term,action,ROW_NUMBER() OVER (PARTITION BY link_id ORDER BY revision,id) AS sequence
  FROM curation_overrides WHERE field IN ('entity','entities')
), barriers AS (
  SELECT link_id,MAX(sequence) AS sequence FROM events
  WHERE action='set_empty' OR (action='reset' AND term='') GROUP BY link_id
), active AS (
  SELECT o.* FROM events o LEFT JOIN barriers b ON b.link_id=o.link_id
  WHERE o.term<>'' AND o.sequence>COALESCE(b.sequence,0)
), automatic AS (
  SELECT e.link_id,j.value AS term FROM entity_states e JOIN links l ON l.id=e.link_id
  JOIN evidence_snapshots s ON s.id=e.evidence_snapshot_id AND s.link_id=e.link_id,
  json_each(e.entities) j
  WHERE e.state='completed_nonempty' AND e.content_revision=l.content_revision
    AND s.content_revision=e.content_revision AND s.content_hash=e.content_hash
), candidates AS (
  SELECT link_id,term FROM automatic UNION SELECT link_id,term FROM active WHERE action='accept'
)
SELECT c.link_id,c.term FROM candidates c
LEFT JOIN barriers b ON b.link_id=c.link_id
LEFT JOIN events barrier ON barrier.link_id=c.link_id AND barrier.sequence=b.sequence
LEFT JOIN active last ON last.link_id=c.link_id AND last.sequence=(SELECT MAX(a.sequence) FROM active a WHERE a.link_id=c.link_id AND a.term=c.term)
WHERE last.action='accept' OR (
  last.action IS NOT 'reject' AND EXISTS (SELECT 1 FROM automatic a WHERE a.link_id=c.link_id AND a.term=c.term)
  AND (barrier.action IS NOT 'set_empty' OR EXISTS (
    SELECT 1 FROM active a WHERE a.link_id=c.link_id AND a.term=c.term AND a.action='reset'
  ))
);

-- Only repair the changed branch: the last non-term-reset action is set_empty,
-- followed by one or more term resets. A later accept/reject/whole reset already
-- ended the old empty state and must not be changed. Legacy input is layered
-- before real overrides at the same revision, as in selection-state.ts.
-- These helper tables exist only during this migration (D1 disallows TEMP).
CREATE TABLE _reset_events AS
WITH legacy AS (
  SELECT h.link_id,h.revision,
    CASE WHEN json_valid(h.payload) THEN h.payload ELSE 'null' END AS payload
  FROM legacy_curation_history h
  WHERE h.id=(SELECT MAX(h2.id) FROM legacy_curation_history h2 WHERE h2.link_id=h.link_id)
    AND h.provenance='legacy_unknown'
), fields(field) AS (VALUES ('topics'),('form'),('use'))
SELECT link_id,revision,id AS sequence,
  CASE field WHEN 'topic' THEN 'topics' WHEN 'content_function' THEN 'content_functions'
    WHEN 'carrier' THEN 'carriers' WHEN 'affordance' THEN 'affordances' WHEN 'entity' THEN 'entities' ELSE field END AS field,
  term,action FROM curation_overrides
WHERE field IN ('topic','topics','content_function','content_functions','carrier','carriers',
  'affordance','affordances','entity','entities','form','use')
UNION ALL
SELECT h.link_id,h.revision,0,f.field,'',
  CASE WHEN json_type(h.payload)='null' THEN 'reset'
    WHEN EXISTS (SELECT 1 FROM json_each(CASE
      WHEN f.field='topics' THEN CASE WHEN json_type(h.payload,'$.topics')='array' THEN json_extract(h.payload,'$.topics') ELSE '[]' END
      ELSE json_array(json_extract(h.payload,'$.'||f.field)) END) j WHERE j.type='text' AND j.value<>'')
    THEN 'accept' ELSE 'set_empty' END
FROM legacy h CROSS JOIN fields f
WHERE json_type(h.payload)='null' OR json_type(h.payload,'$.'||f.field) IS NOT NULL;
CREATE INDEX _reset_events_order ON _reset_events(link_id,field,revision,sequence);

CREATE TABLE _reset_repair AS
WITH affected AS (
  SELECT e.* FROM _reset_events e WHERE e.action='set_empty'
  AND NOT EXISTS (SELECT 1 FROM _reset_events n WHERE n.link_id=e.link_id AND n.field=e.field
    AND (n.revision>e.revision OR (n.revision=e.revision AND n.sequence>e.sequence))
    AND NOT (n.action='reset' AND n.term<>''))
  AND EXISTS (SELECT 1 FROM _reset_events n WHERE n.link_id=e.link_id AND n.field=e.field
    AND (n.revision>e.revision OR (n.revision=e.revision AND n.sequence>e.sequence))
    AND n.action='reset' AND n.term<>'')
), baseline AS (
  SELECT a.*,CASE WHEN a.field='entities' THEN COALESCE((
    SELECT e.entities FROM entity_states e JOIN evidence_snapshots s ON s.id=e.evidence_snapshot_id
    WHERE e.link_id=l.id AND e.state IN ('completed_empty','completed_nonempty')
      AND e.content_revision=l.content_revision AND s.link_id=e.link_id
      AND s.content_revision=e.content_revision AND s.content_hash=e.content_hash),'[]')
    ELSE COALESCE((SELECT d.automatic FROM classification_decisions d WHERE d.link_id=l.id ORDER BY d.id DESC LIMIT 1),
      json_object('topics',json(COALESCE(json_extract(l.classification,'$.topics'),'[]')),
        'form',COALESCE(json_extract(l.classification,'$.form'),''),'use',COALESCE(json_extract(l.classification,'$.use'),''))) END AS automatic
  FROM affected a JOIN links l ON l.id=a.link_id
), arrays AS (
  SELECT b.*,CASE WHEN field='entities' THEN automatic
    WHEN field IN ('form','use') THEN json_array(COALESCE(json_extract(automatic,'$.'||field),''))
    WHEN field='carriers' THEN json_array(COALESCE(json_extract(automatic,'$.carriers[0]'),''))
    ELSE COALESCE(json_extract(automatic,'$.'||field),'[]') END AS terms FROM baseline b
), restored AS (
  SELECT a.link_id,a.field,COALESCE((SELECT json_group_array(term) FROM (
    SELECT j.value AS term FROM json_each(a.terms) j WHERE j.type='text' AND j.value<>''
      AND EXISTS (SELECT 1 FROM _reset_events r WHERE r.link_id=a.link_id AND r.field=a.field
        AND r.action='reset' AND r.term=j.value
        AND (r.revision>a.revision OR (r.revision=a.revision AND r.sequence>a.sequence)))
    GROUP BY j.value ORDER BY MIN(CAST(j.key AS INTEGER))
  )),'[]') AS terms FROM arrays a
)
SELECT link_id,field,CASE WHEN field IN ('form','use') THEN json_quote(COALESCE(json_extract(terms,'$[0]'),''))
  ELSE terms END AS value FROM restored;
CREATE UNIQUE INDEX _reset_repair_field ON _reset_repair(link_id,field);

-- Patch only affected values and empty flags. Preserve cache identities,
-- provenance, unrelated fields, decisions, and every historical event byte.
UPDATE current_projections SET effective=json_patch(effective,(
  SELECT json_patch(json_group_object(field,json(value)),json_object('empty',json((
    SELECT json_group_object(field,json('false')) FROM _reset_repair e
    WHERE e.link_id=current_projections.link_id AND e.field<>'entities'))))
  FROM _reset_repair r WHERE r.link_id=current_projections.link_id
)) WHERE link_id IN (SELECT link_id FROM _reset_repair);

UPDATE link_selections_v2 SET
  topics=COALESCE((SELECT value FROM _reset_repair WHERE link_id=link_selections_v2.link_id AND field='topics'),topics),
  content_functions=COALESCE((SELECT value FROM _reset_repair WHERE link_id=link_selections_v2.link_id AND field='content_functions'),content_functions),
  carriers=COALESCE((SELECT value FROM _reset_repair WHERE link_id=link_selections_v2.link_id AND field='carriers'),carriers),
  affordances=COALESCE((SELECT value FROM _reset_repair WHERE link_id=link_selections_v2.link_id AND field='affordances'),affordances),
  form=COALESCE((SELECT json_extract(value,'$') FROM _reset_repair WHERE link_id=link_selections_v2.link_id AND field='form'),form),
  use=COALESCE((SELECT json_extract(value,'$') FROM _reset_repair WHERE link_id=link_selections_v2.link_id AND field='use'),use)
WHERE link_id IN (SELECT link_id FROM _reset_repair WHERE field<>'entities');

-- The legacy projection is still read by v1 filters. Mark its writes so the
-- compatibility trigger does not invent a human event or advance revision.
-- As with the other caches, patch existing projections only; do not fabricate
-- a partial cache when a previous write never produced one.
UPDATE links SET curation=json_patch(curation,(
  SELECT json_group_object(field,json(CASE WHEN field='topics' THEN (
    SELECT json_group_array(value) FROM (SELECT value FROM json_each(r.value) LIMIT 3)
  ) ELSE value END)) FROM _reset_repair r WHERE r.link_id=links.id AND field IN ('topics','form','use')
)),curation_projection_epoch=curation_projection_epoch+1
WHERE curation IS NOT NULL AND id IN (SELECT link_id FROM _reset_repair WHERE field IN ('topics','form','use'));

DROP TABLE _reset_repair;
DROP TABLE _reset_events;
