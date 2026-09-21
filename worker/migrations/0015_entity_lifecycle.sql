-- B05-T10/B09: entity lifecycle submissions, evidence escalation outcomes and
-- display-only taxonomy renames.
--
-- Entity state is written by the bounded extension consumer (not by a human),
-- so it needs its own idempotency key and a revision so a stale result cannot
-- overwrite a newer one. Human corrections continue to live in
-- curation_overrides, which is the single human truth.

ALTER TABLE entity_states ADD COLUMN operation_key TEXT;
ALTER TABLE entity_states ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX entity_states_operation_idx ON entity_states(operation_key);

ALTER TABLE evidence_requests ADD COLUMN decided_at TEXT;
ALTER TABLE evidence_requests ADD COLUMN result TEXT NOT NULL DEFAULT '{}';

-- A display-only rename approved through the proposal workflow. It changes what
-- the UI shows without changing the semantic vocabulary or the model input, so
-- it is stored separately and never triggers re-inference (B05-T11).
CREATE TABLE taxonomy_display_overrides (
  term_id TEXT PRIMARY KEY,
  dimension TEXT NOT NULL,
  label TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
