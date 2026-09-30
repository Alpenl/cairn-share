-- Selection/entity filters derive freshness from content revision and snapshot
-- identity, not only the legacy enrichment fields watched by 0008. Invalidate
-- cached lists in the same transaction as either authoritative change.
CREATE TRIGGER links_content_revision_cache_invalidation
AFTER UPDATE OF content_revision ON links
WHEN NEW.content_revision <> OLD.content_revision
BEGIN
  UPDATE cache_metadata SET value=value+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key='links_generation';
END;

CREATE TRIGGER evidence_snapshot_cache_invalidation
AFTER INSERT ON evidence_snapshots
BEGIN
  UPDATE cache_metadata SET value=value+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key='links_generation';
END;
