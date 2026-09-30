-- Source/reading completion can commit before its HTTP response reaches Go.
-- Keep an exact, deletion-scoped receipt keyed by a digest of the old lease;
-- no raw lease token or source/model content is retained here.
CREATE TABLE enrichment_completion_receipts (
  lease_hash TEXT PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX enrichment_completion_receipts_link_idx
  ON enrichment_completion_receipts(link_id, created_at);
