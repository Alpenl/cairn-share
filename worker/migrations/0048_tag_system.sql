-- Stable custom identities, independent resources and lifetime lightweight facts.
ALTER TABLE link_selections_v2 ADD COLUMN resource_kinds TEXT NOT NULL DEFAULT '[]';

ALTER TABLE taxonomy_display_overrides RENAME TO taxonomy_display_overrides_old;
CREATE TABLE taxonomy_display_overrides (
  dimension TEXT NOT NULL,
  term_id TEXT NOT NULL,
  label TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  display_revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(dimension, term_id)
);
INSERT INTO taxonomy_display_overrides(dimension,term_id,label,proposal_id,applied_at)
  SELECT dimension,term_id,label,proposal_id,applied_at FROM taxonomy_display_overrides_old;
DROP TABLE taxonomy_display_overrides_old;

CREATE TABLE custom_tags (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT 'default',
  label TEXT NOT NULL,
  normalized_label TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, normalized_label)
);
CREATE TABLE custom_tag_links (
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES custom_tags(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(link_id,tag_id)
);
CREATE INDEX custom_tag_links_tag_idx ON custom_tag_links(tag_id,link_id);
CREATE TABLE custom_tag_operations (
  operation_key TEXT PRIMARY KEY,
  tag_id TEXT NOT NULL REFERENCES custom_tags(id),
  payload_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE tag_operations (
  operation_key TEXT PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actions TEXT NOT NULL,
  before_overrides TEXT NOT NULL,
  before_custom TEXT NOT NULL,
  before_effective TEXT NOT NULL,
  after_effective TEXT NOT NULL,
  context TEXT NOT NULL,
  reverts_operation TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX tag_operations_link_idx ON tag_operations(link_id,revision);
CREATE TABLE tag_change_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL,
  field TEXT NOT NULL,
  term TEXT NOT NULL,
  action TEXT NOT NULL,
  source TEXT NOT NULL,
  revision INTEGER NOT NULL,
  context TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX tag_change_facts_link_idx ON tag_change_facts(link_id,id);
-- Preserve only facts that actually exist; do not invent prior evidence/actors.
INSERT INTO tag_change_facts(link_id,operation_key,operation_id,field,term,action,source,revision,created_at)
  SELECT link_id,operation_key,operation_key,field,term,action,source,revision,created_at
  FROM curation_overrides WHERE field <> 'entities';
CREATE TRIGGER tag_override_fact AFTER INSERT ON curation_overrides
WHEN NEW.field <> 'entities'
BEGIN
  INSERT INTO tag_change_facts(link_id,operation_key,operation_id,field,term,action,source,revision,created_at)
    VALUES(NEW.link_id,NEW.operation_key,NEW.operation_key,NEW.field,NEW.term,NEW.action,NEW.source,NEW.revision,NEW.created_at);
END;

CREATE TRIGGER custom_tag_cache_update AFTER UPDATE ON custom_tags BEGIN
  UPDATE cache_metadata SET value=value+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key='links_generation';
END;
CREATE TRIGGER custom_tag_link_cache_insert AFTER INSERT ON custom_tag_links BEGIN
  UPDATE cache_metadata SET value=value+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key='links_generation';
END;
CREATE TRIGGER custom_tag_link_cache_delete AFTER DELETE ON custom_tag_links BEGIN
  UPDATE cache_metadata SET value=value+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key='links_generation';
END;
