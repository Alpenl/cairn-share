-- Durable upload receipts prevent replay from overwriting or resurrecting a bookmark.
CREATE TABLE browser_captures (
 client_id TEXT PRIMARY KEY, link_id INTEGER NOT NULL, payload_hash TEXT NOT NULL,
 completed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE content_presentations (
 link_id INTEGER PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
 input_text TEXT NOT NULL, input_images TEXT NOT NULL, input_kind TEXT NOT NULL,
 input_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 formatted_content TEXT, model TEXT, prompt_version TEXT,
 lease_token TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 error TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX content_presentations_queue ON content_presentations(status,lease_until);
CREATE TRIGGER presentation_update AFTER UPDATE ON content_presentations BEGIN
 UPDATE links SET app_body_revision=app_body_revision+1 WHERE id=NEW.link_id;
 UPDATE cache_metadata SET value=value+1 WHERE key='links_generation';
END;
CREATE TRIGGER presentation_insert AFTER INSERT ON content_presentations BEGIN
 UPDATE links SET app_body_revision=app_body_revision+1 WHERE id=NEW.link_id;
 UPDATE cache_metadata SET value=value+1 WHERE key='links_generation';
END;
-- Input changes invalidate a queued or completed presentation. This never alters source evidence.
CREATE TRIGGER presentation_input_changed AFTER UPDATE OF original_text,translated_text,images,url ON links
WHEN OLD.original_text IS NOT NEW.original_text OR OLD.translated_text IS NOT NEW.translated_text
 OR OLD.images IS NOT NEW.images OR OLD.url IS NOT NEW.url
BEGIN
 UPDATE content_presentations SET status='stale',lease_token=NULL,lease_until=NULL WHERE link_id=NEW.id;
END;
CREATE TABLE presentation_budget(day TEXT PRIMARY KEY,calls INTEGER NOT NULL DEFAULT 0);

-- Keep only the operation identity after deletion, to reject a delayed browser retry.
CREATE TRIGGER capture_privacy_delete AFTER DELETE ON links BEGIN
 UPDATE browser_captures SET payload_hash='' WHERE link_id=OLD.id;
END;
