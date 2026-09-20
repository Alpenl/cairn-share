CREATE TABLE enrichment_sources (
  link_id INTEGER PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
  url TEXT NOT NULL, original_text TEXT NOT NULL, payload TEXT NOT NULL, fetched_at TEXT NOT NULL
);
CREATE TABLE classification_jobs (
  link_id INTEGER PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT, lease_token TEXT, lease_until TEXT,
  taxonomy_version TEXT NOT NULL DEFAULT '', policy_version TEXT NOT NULL DEFAULT '',
  requested_model TEXT NOT NULL DEFAULT '', error TEXT, result TEXT, updated_at TEXT
);
CREATE INDEX classification_queue_idx ON classification_jobs(status, next_retry_at, link_id);
-- No historical backfill. Input changes invalidate outstanding leases atomically.
CREATE TRIGGER links_classification_input_update
AFTER UPDATE OF original_text, url, note ON links
WHEN OLD.original_text IS NOT NEW.original_text OR OLD.url IS NOT NEW.url OR OLD.note IS NOT NEW.note
BEGIN
  INSERT INTO classification_jobs(link_id, status)
    SELECT NEW.id, CASE WHEN COALESCE(NEW.original_text, '') = '' THEN 'waiting_source' ELSE 'pending' END
    WHERE COALESCE(NEW.original_text, '') <> '' OR EXISTS(SELECT 1 FROM classification_jobs WHERE link_id = NEW.id)
    ON CONFLICT(link_id) DO UPDATE SET revision = revision + 1, status = excluded.status, attempts = 0,
      next_retry_at = NULL, lease_token = NULL, lease_until = NULL, error = NULL, result = NULL;
  UPDATE links SET classification = CASE WHEN OLD.classification IS NEW.classification THEN NULL ELSE NEW.classification END WHERE id = NEW.id;
END;
CREATE TRIGGER source_classification_insert AFTER INSERT ON enrichment_sources
BEGIN
  INSERT INTO classification_jobs(link_id) VALUES(NEW.link_id)
    ON CONFLICT(link_id) DO UPDATE SET revision = revision + 1, status = 'pending',
      attempts = 0, next_retry_at = NULL, lease_token = NULL, lease_until = NULL, error = NULL, result = NULL;
END;
CREATE TRIGGER source_classification_update AFTER UPDATE ON enrichment_sources
BEGIN
  UPDATE classification_jobs SET revision = revision + 1, status = 'pending', attempts = 0,
    next_retry_at = NULL, lease_token = NULL, lease_until = NULL, error = NULL, result = NULL WHERE link_id = NEW.link_id;
  UPDATE links SET classification = NULL WHERE id = NEW.link_id;
END;
