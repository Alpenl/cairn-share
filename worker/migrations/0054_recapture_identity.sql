-- Non-unique for legacy duplicates: new writes use an atomic INSERT WHERE NOT
-- EXISTS, and recapture targets the oldest original bookmark, preserving its ID.
ALTER TABLE links ADD COLUMN url_identity TEXT;
ALTER TABLE links ADD COLUMN last_capture_id TEXT;
CREATE INDEX links_url_identity ON links(url_identity,id);
CREATE TRIGGER links_url_identity_changed AFTER UPDATE OF url ON links
WHEN OLD.url IS NOT NEW.url BEGIN
 UPDATE links SET url_identity=NULL WHERE id=NEW.id;
END;
ALTER TABLE browser_captures ADD COLUMN expected_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE browser_captures ADD COLUMN expected_body_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE browser_captures ADD COLUMN was_existing INTEGER NOT NULL DEFAULT 0;
CREATE TABLE archived_media (
 id TEXT PRIMARY KEY, link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 capture_id TEXT NOT NULL, ordinal INTEGER NOT NULL, url TEXT NOT NULL,
 title TEXT NOT NULL, kind TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT '',
 size INTEGER NOT NULL DEFAULT 0, digest TEXT NOT NULL DEFAULT '', r2_key TEXT,
 upload_id TEXT, upload_started_at TEXT, parts TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
 updated_at TEXT NOT NULL, UNIQUE(capture_id,ordinal)
);
CREATE INDEX archived_media_link ON archived_media(link_id,capture_id);
CREATE TRIGGER archived_media_update AFTER UPDATE OF status ON archived_media BEGIN
 UPDATE links SET app_body_revision=app_body_revision+1 WHERE id=NEW.link_id;
 UPDATE cache_metadata SET value=value+1 WHERE key='links_generation';
END;
