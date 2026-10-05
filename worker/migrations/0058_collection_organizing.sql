CREATE TABLE collection_organizing_runs (
 id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN('review','apply')), definitions TEXT NOT NULL,
 create_request_hash TEXT NOT NULL, created_at TEXT NOT NULL, next_attempt_at TEXT, auto_finished INTEGER NOT NULL DEFAULT 0, question_version TEXT NOT NULL DEFAULT 'collection-fit-v1'
);
CREATE TABLE collection_organizing_batches (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES collection_organizing_runs(id) ON DELETE CASCADE,
 lease_until TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'processing', request_hash TEXT, model TEXT, usage TEXT, error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE collection_organizing_items (
 run_id TEXT NOT NULL REFERENCES collection_organizing_runs(id) ON DELETE CASCADE, link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 content_revision INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', batch_id TEXT, probabilities TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(run_id,link_id)
);
CREATE INDEX collection_organizing_queue ON collection_organizing_items(status,run_id,link_id);
CREATE TABLE collection_organizing_actions (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES collection_organizing_runs(id) ON DELETE CASCADE,
 request_hash TEXT NOT NULL, payload TEXT NOT NULL, receipts TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', actor TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TRIGGER collection_organizing_privacy AFTER DELETE ON links BEGIN
 DELETE FROM collection_organizing_actions WHERE EXISTS(SELECT 1 FROM json_each(json_extract(payload,'$.link_ids')) WHERE value=OLD.id);
END;
