-- Unknown historical identities stay NULL. No hashes are backfilled from the
-- latest snapshot or current questions. New runs retain exact bounded input.
ALTER TABLE classification_runs ADD COLUMN raw_judgments TEXT;
ALTER TABLE classification_runs ADD COLUMN evidence_snapshot_id INTEGER REFERENCES evidence_snapshots(id);
ALTER TABLE classification_runs ADD COLUMN source_hash TEXT;
