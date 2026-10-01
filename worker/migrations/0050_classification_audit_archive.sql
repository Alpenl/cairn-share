-- Preserve immutable run/decision identities while moving old full payloads to
-- private R2. Wire identity survives archival and is not reconstructed as truth.
ALTER TABLE classification_runs ADD COLUMN archive_key TEXT;
ALTER TABLE classification_runs ADD COLUMN archive_hash TEXT;
ALTER TABLE classification_runs ADD COLUMN archive_bytes INTEGER;
ALTER TABLE classification_runs ADD COLUMN archived_at TEXT;
ALTER TABLE classification_runs ADD COLUMN wire_evidence_hash TEXT;
UPDATE classification_runs SET wire_evidence_hash=json_extract(raw_judgments,'$.evidence_hash')
  WHERE json_valid(raw_judgments) AND json_extract(raw_judgments,'$.metadata_version')=1;
CREATE TRIGGER classification_run_wire_identity AFTER INSERT ON classification_runs
WHEN json_valid(NEW.raw_judgments) AND json_extract(NEW.raw_judgments,'$.metadata_version')=1 BEGIN
  UPDATE classification_runs SET wire_evidence_hash=json_extract(NEW.raw_judgments,'$.evidence_hash') WHERE id=NEW.id;
END;
ALTER TABLE classification_decisions ADD COLUMN policy_hash TEXT;
ALTER TABLE classification_decisions ADD COLUMN replay_target_generation INTEGER;

-- Global budget rows remain anonymous. Per-link reservation identities and
-- attempt receipts are deleted with their bookmark, including failed calls.
CREATE TABLE classification_reservations (
  reservation_key TEXT PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  identity TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX classification_reservations_link_idx ON classification_reservations(link_id);
CREATE TABLE classification_attempt_operations (
  operation_key TEXT PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE classification_provider_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL REFERENCES classification_attempt_operations(operation_key) ON DELETE CASCADE,
  reservation_key TEXT NOT NULL UNIQUE REFERENCES classification_reservations(reservation_key) ON DELETE CASCADE,
  call_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX classification_provider_attempts_link_idx ON classification_provider_attempts(link_id,id DESC);
