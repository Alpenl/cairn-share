-- B05: multidimensional v2 selection, taxonomy proposals and search support.
--
-- The v1 projection stays in links.classification/curation. These tables carry
-- the additional dimensions that v1 cannot express, so a v1 write can never
-- silently destroy them.

CREATE TABLE link_selections_v2 (
  link_id INTEGER PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
  taxonomy_version TEXT NOT NULL,
  definition_version INTEGER NOT NULL DEFAULT 1,
  topics TEXT NOT NULL DEFAULT '[]',
  content_functions TEXT NOT NULL DEFAULT '[]',
  carriers TEXT NOT NULL DEFAULT '[]',
  affordances TEXT NOT NULL DEFAULT '[]',
  form TEXT NOT NULL DEFAULT '',
  use TEXT NOT NULL DEFAULT '',
  provenance TEXT NOT NULL DEFAULT '{}',
  revised_at TEXT NOT NULL
);

-- Taxonomy proposals. A proposal is never applied directly; approval records a
-- semantic diff and an impact dry-run so the change is reviewable and
-- reversible.
CREATE TABLE taxonomy_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dimension TEXT NOT NULL,
  term_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  revision INTEGER NOT NULL DEFAULT 1,
  impact TEXT NOT NULL DEFAULT '{}',
  submitted_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX taxonomy_proposals_status_idx ON taxonomy_proposals(status);

-- Evidence escalation requests (B09 uses this; B05 defines the bounded API).
CREATE TABLE evidence_requests (
  id TEXT PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  content_revision INTEGER NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  budget TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(dedupe_key)
);
