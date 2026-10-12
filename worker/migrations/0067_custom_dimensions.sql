-- Additive: existing custom identities and legacy clients remain valid.
CREATE TABLE custom_dimensions (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 color INTEGER NOT NULL DEFAULT 0 CHECK(color BETWEEN 0 AND 7),
 ai_enabled INTEGER NOT NULL DEFAULT 1 CHECK(ai_enabled IN(0,1)),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)),
 revision INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX custom_dimensions_label_idx ON custom_dimensions(lower(trim(label)));
ALTER TABLE custom_tags ADD COLUMN dimension_id TEXT REFERENCES custom_dimensions(id);
ALTER TABLE custom_tags ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE custom_tags ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
ALTER TABLE custom_tags ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 0 CHECK(ai_enabled IN(0,1));
ALTER TABLE custom_tag_links ADD COLUMN origin TEXT NOT NULL DEFAULT 'human' CHECK(origin IN('human','ai'));
CREATE TABLE custom_tag_overrides (
 link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 tag_id TEXT NOT NULL REFERENCES custom_tags(id),
 action TEXT NOT NULL CHECK(action IN('attach','detach')),
 PRIMARY KEY(link_id,tag_id)
);
INSERT INTO custom_tag_overrides SELECT link_id,tag_id,'attach' FROM custom_tag_links;
CREATE TABLE custom_dimension_operations (
 operation_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result TEXT NOT NULL
);
CREATE TABLE custom_tag_judgments (
 link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 tag_id TEXT NOT NULL REFERENCES custom_tags(id),
 content_revision INTEGER NOT NULL, tag_revision INTEGER NOT NULL, dimension_revision INTEGER NOT NULL,
 probability REAL CHECK(probability BETWEEN 0 AND 1),
 state TEXT NOT NULL CHECK(state IN('running','done','failed','stale')),
 operation_key TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(link_id,tag_id)
);
CREATE TRIGGER custom_dimension_sync AFTER UPDATE ON custom_dimensions BEGIN
 INSERT INTO library_sync_changes(kind) VALUES('taxonomy');
END;
