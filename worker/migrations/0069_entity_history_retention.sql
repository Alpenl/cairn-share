-- B03-T13: compact superseded entity results, preserving the exact operation
-- identity without retaining the old payload or pinning its source snapshot.
-- Current entity_states.operation_key references are never expired.
CREATE INDEX entity_operations_age_idx ON entity_operations(created_at, operation_key);

CREATE TABLE entity_operation_tombstones (
  operation_key TEXT PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  content_revision INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expired_at TEXT NOT NULL
);
CREATE INDEX entity_operation_tombstones_link_idx ON entity_operation_tombstones(link_id);

-- Delayed or older SQL writers must not recreate an expired operation even if
-- they skip the HTTP receipt lookup. The HTTP insert also checks inside its
-- transaction, so a cleanup racing preflight returns 410 rather than a 5xx.
CREATE TRIGGER entity_operation_expired_key BEFORE INSERT ON entity_operations
WHEN EXISTS (SELECT 1 FROM entity_operation_tombstones WHERE operation_key=NEW.operation_key)
BEGIN
  SELECT RAISE(ABORT, 'entity_operation_expired');
END;
