-- Manual source text is accepted only after the source and its receipt commit.
-- The receipt contains no user text. Deleting a link removes its receipt.
CREATE TABLE manual_source_operations (
  operation_key TEXT PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  result_revision INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX manual_source_operations_link_idx ON manual_source_operations(link_id);

-- A pasted source stays ahead of routine retrieval until its reading aids
-- finish. Claiming a lease does not consume the priority: a crashed worker
-- must not silently demote a durable manual request.
ALTER TABLE links ADD COLUMN manual_source_priority INTEGER NOT NULL DEFAULT 0
  CHECK (manual_source_priority IN (0, 1));
CREATE INDEX links_manual_source_priority_idx ON links(manual_source_priority DESC, id ASC);
