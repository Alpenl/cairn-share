-- B03-T13: scan only a bounded age-ordered page on each scheduled tick.
-- Reference indexes keep the protected-snapshot checks proportional to that
-- page, even when the other domain tables have grown large.
CREATE INDEX curation_events_age_idx ON curation_events(created_at, id);
CREATE INDEX evidence_snapshots_age_idx ON evidence_snapshots(created_at, id);
CREATE INDEX classification_runs_snapshot_idx ON classification_runs(evidence_snapshot_id);
CREATE INDEX entity_operations_snapshot_idx ON entity_operations(evidence_snapshot_id);
CREATE INDEX evidence_requests_snapshot_idx ON evidence_requests(evidence_snapshot_id);
CREATE INDEX entity_states_snapshot_idx ON entity_states(evidence_snapshot_id);
CREATE INDEX entity_cache_snapshot_idx ON entity_cache(evidence_snapshot_id);
CREATE INDEX classification_jobs_snapshot_idx ON classification_jobs(evidence_snapshot_id);
