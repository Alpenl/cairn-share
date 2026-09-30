-- Private, bounded result cache. A cache entry may reference several bookmarks;
-- deleting any member removes the whole request/answer record before cascading
-- its references. Anonymous budget consumption is intentionally not refunded.
CREATE TABLE rerank_cache (
  cache_key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
  request_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  items TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '{}',
  result_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rerank_cache_expiry ON rerank_cache(expires_at);
CREATE TABLE rerank_cache_links (
  cache_key TEXT NOT NULL REFERENCES rerank_cache(cache_key) ON DELETE CASCADE,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  PRIMARY KEY(cache_key, link_id)
);
CREATE INDEX rerank_cache_owner ON rerank_cache_links(link_id);
CREATE TRIGGER delete_private_rerank_cache BEFORE DELETE ON links BEGIN
  DELETE FROM rerank_cache WHERE cache_key IN
    (SELECT cache_key FROM rerank_cache_links WHERE link_id=OLD.id);
END;

-- These human fields predate canonical overrides; they must also advance the
-- personal version used by asynchronous consumers. Same-value writes do not.
CREATE TRIGGER links_personal_text_revision_update
AFTER UPDATE OF note, why, curation_status ON links
WHEN OLD.note IS NOT NEW.note OR OLD.why IS NOT NEW.why
  OR OLD.curation_status IS NOT NEW.curation_status
BEGIN
  UPDATE links SET personal_revision=personal_revision+1 WHERE id=NEW.id;
END;

-- 0023 covered large reading bodies. Reranking consumes title/summary and
-- filtered candidates, so their revisions must participate in the same CAS.
CREATE TRIGGER links_rerank_reading_revision_update
AFTER UPDATE OF ai_title, summary, enrichment_status, url ON links
WHEN OLD.ai_title IS NOT NEW.ai_title OR OLD.summary IS NOT NEW.summary
  OR OLD.enrichment_status IS NOT NEW.enrichment_status OR OLD.url IS NOT NEW.url
BEGIN
  UPDATE links SET app_body_revision=app_body_revision+1 WHERE id=NEW.id;
END;
