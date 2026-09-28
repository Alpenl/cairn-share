-- A whole-selection write can produce no field actions, and a retry can see a
-- newer effective view. Keep its original confirmation independently of the
-- action rows, in the same transaction as the actions and their projection.
CREATE TABLE selection_operations (
  operation_key TEXT PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  selection TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX selection_operations_link_idx ON selection_operations(link_id);
