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

-- Search index for the expanded v2 fields. D1 has no FTS prerequisite, so a
-- maintained text column plus an index keeps search parameterised and bounded.
-- A trigger keeps it correct for every write path (create, edit, enrichment)
-- without threading the value through each statement.
ALTER TABLE links ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
CREATE INDEX links_search_text_idx ON links(search_text);

UPDATE links SET search_text = lower(
  COALESCE(url,'') || char(0) || COALESCE(note,'') || char(0) || COALESCE(original_text,'') || char(0) ||
  COALESCE(translated_text,'') || char(0) || COALESCE(summary,'') || char(0) || COALESCE(ai_title,'') || char(0) || COALESCE(why,'')
);

CREATE TRIGGER links_search_text_refresh_insert AFTER INSERT ON links
BEGIN
  UPDATE links SET search_text = lower(
    COALESCE(NEW.url,'') || char(0) || COALESCE(NEW.note,'') || char(0) || COALESCE(NEW.original_text,'') || char(0) ||
    COALESCE(NEW.translated_text,'') || char(0) || COALESCE(NEW.summary,'') || char(0) || COALESCE(NEW.ai_title,'') || char(0) || COALESCE(NEW.why,'')
  ) WHERE id = NEW.id;
END;

CREATE TRIGGER links_search_text_refresh_update AFTER UPDATE OF url, note, original_text, translated_text, summary, ai_title, why ON links
BEGIN
  UPDATE links SET search_text = lower(
    COALESCE(NEW.url,'') || char(0) || COALESCE(NEW.note,'') || char(0) || COALESCE(NEW.original_text,'') || char(0) ||
    COALESCE(NEW.translated_text,'') || char(0) || COALESCE(NEW.summary,'') || char(0) || COALESCE(NEW.ai_title,'') || char(0) || COALESCE(NEW.why,'')
  ) WHERE id = NEW.id;
END;
