-- R3-12: preserve every run used by a decision. Historical rows only recorded
-- the primary run; retain that known reference without claiming it was all of them.
ALTER TABLE classification_decisions ADD COLUMN run_ids TEXT;
ALTER TABLE classification_decisions ADD COLUMN run_references_complete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE classification_decisions ADD COLUMN expected_personal_revision INTEGER;
ALTER TABLE classification_decisions ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 0;
UPDATE classification_decisions SET run_ids=json_array(run_id);

CREATE TABLE classification_decision_runs (
  decision_id INTEGER NOT NULL REFERENCES classification_decisions(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL REFERENCES classification_runs(id),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (decision_id, run_id),
  UNIQUE (decision_id, ordinal)
);
CREATE INDEX classification_decision_runs_run_idx ON classification_decision_runs(run_id);
INSERT INTO classification_decision_runs(decision_id, run_id, ordinal)
  SELECT id, run_id, 0 FROM classification_decisions;
-- This also supports an older writer that only supplies run_id after migration.
CREATE TRIGGER classification_decision_runs_insert AFTER INSERT ON classification_decisions
BEGIN
  INSERT INTO classification_decision_runs(decision_id, run_id, ordinal)
    SELECT NEW.id, value, CAST(key AS INTEGER)
    FROM json_each(COALESCE(NEW.run_ids, json_array(NEW.run_id)));
END;
