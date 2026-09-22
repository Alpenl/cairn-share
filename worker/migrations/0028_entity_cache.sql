-- Private source-bound entity judgments; human overrides remain separate.
CREATE TABLE entity_cache (
 cache_key TEXT PRIMARY KEY,
 link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 evidence_snapshot_id INTEGER NOT NULL REFERENCES evidence_snapshots(id) ON DELETE CASCADE,
 content_revision INTEGER NOT NULL,
 content_hash TEXT NOT NULL,
 source_links TEXT NOT NULL,
 owner_token TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
 request_json TEXT NOT NULL,
 candidates TEXT NOT NULL,
 spec_hash TEXT NOT NULL,
 answers TEXT NOT NULL DEFAULT '{}',
 result_hash TEXT,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX entity_cache_expiry ON entity_cache(expires_at);
CREATE INDEX entity_cache_link ON entity_cache(link_id);

-- Entity candidates also include stored source links. 0014 already versions
-- primary-text changes; a links-only source refresh needs its own invalidation.
CREATE TRIGGER links_related_evidence_revision_update
AFTER UPDATE OF related_links ON links
WHEN OLD.original_text IS NEW.original_text
 AND (CASE WHEN json_valid(OLD.related_links) THEN json(OLD.related_links) ELSE '[]' END)
  IS NOT (CASE WHEN json_valid(NEW.related_links) THEN json(NEW.related_links) ELSE '[]' END)
BEGIN
 UPDATE links SET content_revision=content_revision+1 WHERE id=NEW.id;
END;
