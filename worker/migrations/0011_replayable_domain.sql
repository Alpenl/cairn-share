-- B03: replayable domain model, source revisions and human override events.
--
-- The existing links columns remain the v1 projection. These tables add the
-- append-only history the v2 model needs so that a decision can be recomputed
-- from stored evidence without paying for inference again, and so that human
-- edits are explicit, auditable events rather than an opaque overwrite.
--
-- Content (objective evidence) and personal state (note/why/status) are tracked
-- by separate revisions so a note edit never invalidates a classification run.

-- Objective input revision and personal revision for each link.
ALTER TABLE links ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE links ADD COLUMN personal_revision INTEGER NOT NULL DEFAULT 0;

-- Recovery-grade evidence snapshot. The payload is the full block structure,
-- not just a hash, so a run can be reconstructed.
CREATE TABLE evidence_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  content_revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  -- Canonical JSON: { blocks: [...], fetched_at, retrieval, truncation }
  payload TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  completeness TEXT NOT NULL DEFAULT 'complete',
  created_at TEXT NOT NULL,
  UNIQUE(link_id, content_revision)
);
CREATE INDEX evidence_snapshots_link_idx ON evidence_snapshots(link_id, content_revision);

-- Immutable question specification. The same hash must always describe the same
-- bytes; a different definition under the same id is rejected by the API.
CREATE TABLE question_specs (
  spec_id TEXT PRIMARY KEY,
  spec_hash TEXT NOT NULL,
  spec_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  display_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Append-only classification runs. A job is queue state; a run is the historical
-- record of one evaluation and is never deleted by invalidation.
CREATE TABLE classification_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  content_revision INTEGER NOT NULL,
  spec_id TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  target_generation INTEGER NOT NULL,
  requested_model TEXT NOT NULL,
  resolved_model TEXT NOT NULL DEFAULT '',
  policy_version TEXT NOT NULL,
  -- typed answers with their original distributions
  answers TEXT NOT NULL,
  usage TEXT NOT NULL DEFAULT '{}',
  attempt INTEGER NOT NULL DEFAULT 1,
  operation_key TEXT NOT NULL,
  coverage TEXT NOT NULL DEFAULT 'complete',
  status TEXT NOT NULL DEFAULT 'succeeded',
  created_at TEXT NOT NULL,
  UNIQUE(operation_key)
);
CREATE INDEX classification_runs_link_idx ON classification_runs(link_id, content_revision);

-- Explicit human overrides. Field-level, so accept/reject/set-empty/reset are
-- distinguishable and a policy replay cannot silently revive a rejected tag.
CREATE TABLE curation_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  term TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,          -- accept | reject | set_empty | reset
  source TEXT NOT NULL,          -- human | legacy_unknown
  confirmed INTEGER NOT NULL DEFAULT 1,  -- 0 for legacy rows whose intent is unknown
  revision INTEGER NOT NULL,
  operation_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(operation_key)
);
CREATE INDEX curation_overrides_link_idx ON curation_overrides(link_id, field);

-- Append-only audit of human curation actions, including why/status edits that
-- produce no accept event.
CREATE TABLE curation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- accept | reject | set_empty | reset | why | status
  payload TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL,
  operation_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(operation_key)
);
CREATE INDEX curation_events_link_idx ON curation_events(link_id);

-- Query-oriented current projection of the effective view. Rebuilt from runs and
-- overrides; never the source of truth.
CREATE TABLE current_projections (
  link_id INTEGER PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
  content_revision INTEGER NOT NULL,
  decision_id INTEGER,
  effective TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Entity state for B09 (not_run/failed/completed_empty/completed_nonempty/stale).
CREATE TABLE entity_states (
  link_id INTEGER PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'not_run',
  content_revision INTEGER NOT NULL DEFAULT 0,
  entities TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

-- Bounded budget accounting for single-item and batch operations.
CREATE TABLE budget_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,           -- entity | evidence | rerank | classify
  link_id INTEGER,
  units TEXT NOT NULL DEFAULT '{}',
  operation_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(operation_key)
);
CREATE INDEX budget_ledger_scope_idx ON budget_ledger(scope, created_at);
