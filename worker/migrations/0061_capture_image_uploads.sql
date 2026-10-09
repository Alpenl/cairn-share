-- Text commits independently of binary transfers. Receipts survive deletion;
-- image rows are removed with the bookmark and cannot resurrect it.
CREATE TABLE capture_upload_sessions (
 client_id TEXT PRIMARY KEY REFERENCES browser_captures(client_id),
 manifest_hash TEXT NOT NULL, request_json TEXT NOT NULL, media_json TEXT
);
CREATE TABLE capture_image_uploads (
 capture_id TEXT NOT NULL REFERENCES capture_upload_sessions(client_id),
 ordinal INTEGER NOT NULL, link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 digest TEXT, size INTEGER, content_type TEXT, r2_key TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','ready')),
 PRIMARY KEY(capture_id,ordinal)
);
-- Keep only the hash tombstone after deletion, never the captured document.
CREATE TRIGGER capture_upload_sessions_delete_content AFTER DELETE ON links BEGIN
 UPDATE capture_upload_sessions SET request_json='{}',media_json=NULL
 WHERE client_id IN(SELECT client_id FROM browser_captures WHERE link_id=OLD.id);
END;
