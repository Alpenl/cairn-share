-- F05/F06/F07/F10: immutable decision history and the extra run facts needed to
-- replay a stored run under the policy that actually produced it.
--
-- Until now `classification_runs` carried only the provider answers and a
-- policy version string. A replay that reads the version but substitutes a
-- default threshold set fabricates a baseline, so the full policy payload is
-- stored alongside every run. `classification_decisions` is the append-only
-- record of one pure decision over those runs; it is what `current_projections`
-- and `link_selections_v2` are derived from.

ALTER TABLE classification_runs ADD COLUMN policy TEXT NOT NULL DEFAULT '';
ALTER TABLE classification_runs ADD COLUMN evidence_coverage TEXT NOT NULL DEFAULT '';
ALTER TABLE classification_runs ADD COLUMN alias_drift INTEGER NOT NULL DEFAULT 0;

CREATE TABLE classification_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL REFERENCES classification_runs(id),
  content_revision INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  -- Canonical JSON policy payload: thresholds and display rules, never a model
  -- input. It is what a later replay must use as the historical baseline.
  policy TEXT NOT NULL,
  -- Canonical JSON of the automatic per-dimension proposals, before any human
  -- override. Human overrides are applied deterministically when the effective
  -- view is derived, which is why a caller-supplied `effective` is never stored.
  automatic TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(operation_key)
);
CREATE INDEX classification_decisions_link_idx ON classification_decisions(link_id, id);

-- The effective view is a projection of the latest decision plus the human
-- override log. An index on the override lookup keeps rebuilds bounded.
CREATE INDEX curation_overrides_link_revision_idx ON curation_overrides(link_id, revision);
