-- R3-06: additive durable ownership and recovery. Legacy requests stay protocol 0.
ALTER TABLE evidence_requests ADD COLUMN protocol INTEGER NOT NULL DEFAULT 0;
ALTER TABLE evidence_requests ADD COLUMN evidence_snapshot_id INTEGER REFERENCES evidence_snapshots(id);
ALTER TABLE evidence_requests ADD COLUMN source_hash TEXT;
ALTER TABLE evidence_requests ADD COLUMN target_generation INTEGER;
ALTER TABLE evidence_requests ADD COLUMN url TEXT;
ALTER TABLE evidence_requests ADD COLUMN payload_hash TEXT;
ALTER TABLE evidence_requests ADD COLUMN owner_token TEXT;
ALTER TABLE evidence_requests ADD COLUMN lease_until TEXT;
ALTER TABLE evidence_requests ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE evidence_requests ADD COLUMN checkpoint TEXT;
ALTER TABLE evidence_requests ADD COLUMN checkpoint_hash TEXT;
ALTER TABLE evidence_requests ADD COLUMN receipt TEXT;
CREATE INDEX evidence_requests_recovery_idx ON evidence_requests(protocol,status,lease_until,created_at);
