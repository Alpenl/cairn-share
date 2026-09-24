-- Keep historical unbound states for audit; only bound current states may be
-- used as automatic values. Receipts survive subsequent results/revisions.
ALTER TABLE entity_states ADD COLUMN evidence_snapshot_id INTEGER NOT NULL DEFAULT 0;
CREATE TABLE entity_operations (
  operation_key TEXT PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  evidence_snapshot_id INTEGER NOT NULL REFERENCES evidence_snapshots(id),
  content_revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  outcome TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Search resolves the same entity action log as the API. It does not trust an
-- asynchronously rebuilt display cache or stale classification.entities.
CREATE VIEW effective_entity_terms AS
WITH barriers AS (
  SELECT link_id,MAX(id) AS id FROM curation_overrides
  WHERE field='entities' AND (action='set_empty' OR (action='reset' AND term='')) GROUP BY link_id
), active AS (
  SELECT o.* FROM curation_overrides o LEFT JOIN barriers b ON b.link_id=o.link_id
  WHERE o.field='entities' AND o.term<>'' AND o.id>COALESCE(b.id,0)
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
LEFT JOIN curation_overrides barrier ON barrier.id=b.id
LEFT JOIN active last ON last.id=(SELECT MAX(a.id) FROM active a WHERE a.link_id=c.link_id AND a.term=c.term)
WHERE (barrier.action IS NOT 'set_empty' OR EXISTS (
  SELECT 1 FROM active a WHERE a.link_id=c.link_id AND a.action IN ('accept','reject')
)) AND (
  last.action='accept' OR (
    last.action IS NOT 'reject' AND EXISTS (SELECT 1 FROM automatic a WHERE a.link_id=c.link_id AND a.term=c.term)
    AND (barrier.action IS NOT 'set_empty' OR EXISTS (
      SELECT 1 FROM active a WHERE a.link_id=c.link_id AND a.term=c.term AND a.action='reset'
    ))
  )
);
