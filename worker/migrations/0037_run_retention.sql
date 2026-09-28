-- B03-T13: an immutable run is deleted only after a smaller immutable receipt
-- is committed in the same transaction. The tombstone keeps its operation
-- identity and safe metadata, so a delayed retry receives an explicit 410
-- instead of creating another run or pretending the evidence is available.
CREATE INDEX classification_runs_age_idx ON classification_runs(created_at, id);
CREATE INDEX classification_decisions_run_idx ON classification_decisions(run_id);

CREATE TABLE classification_run_tombstones (
  operation_key TEXT PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  content_revision INTEGER NOT NULL,
  spec_id TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  target_generation INTEGER NOT NULL,
  requested_model TEXT NOT NULL,
  resolved_model TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  coverage TEXT NOT NULL,
  evidence_coverage TEXT NOT NULL,
  alias_drift INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  source_hash TEXT,
  created_at TEXT NOT NULL,
  expired_at TEXT NOT NULL
);
CREATE INDEX classification_run_tombstones_link_idx ON classification_run_tombstones(link_id,run_id);

-- Some writers insert runs inside a larger completion batch. Preserve the
-- operation-key fence even if a caller skips the HTTP receipt lookup.
CREATE TRIGGER classification_run_expired_key BEFORE INSERT ON classification_runs
WHEN EXISTS (SELECT 1 FROM classification_run_tombstones WHERE operation_key=NEW.operation_key)
BEGIN
  SELECT RAISE(ABORT, 'run_operation_expired');
END;

CREATE TABLE classification_run_reuse_sources (
  run_id INTEGER NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
  source_run_id INTEGER NOT NULL REFERENCES classification_runs(id),
  PRIMARY KEY (run_id, source_run_id)
);
CREATE INDEX classification_run_reuse_source_idx ON classification_run_reuse_sources(source_run_id);

CREATE TRIGGER classification_run_reuse_insert AFTER INSERT ON classification_runs
WHEN NEW.raw_judgments IS NOT NULL AND json_valid(NEW.raw_judgments)
BEGIN
  INSERT OR IGNORE INTO classification_run_reuse_sources(run_id, source_run_id)
    SELECT NEW.id, CAST(j.value AS INTEGER)
    FROM json_each(NEW.raw_judgments, '$.reused_from') j
    WHERE j.type='integer' AND EXISTS (
      SELECT 1 FROM classification_runs source WHERE source.id=CAST(j.value AS INTEGER));
END;

CREATE TRIGGER classification_run_reuse_update AFTER UPDATE OF raw_judgments ON classification_runs
BEGIN
  DELETE FROM classification_run_reuse_sources WHERE run_id=NEW.id;
  INSERT OR IGNORE INTO classification_run_reuse_sources(run_id, source_run_id)
    SELECT NEW.id, CAST(j.value AS INTEGER)
    FROM json_each(CASE WHEN json_valid(NEW.raw_judgments) THEN NEW.raw_judgments ELSE '{}' END, '$.reused_from') j
    WHERE j.type='integer' AND EXISTS (
      SELECT 1 FROM classification_runs source WHERE source.id=CAST(j.value AS INTEGER));
END;

-- Historical rows are backfilled in 100-row Cron pages before compaction is
-- enabled. New rows are covered immediately by the INSERT trigger.
INSERT OR IGNORE INTO privacy_maintenance_state(key,cursor) VALUES ('run_reuse_backfill','0');
