-- Runtime catalog snapshots are immutable; source definitions remain the bootstrap seed.
CREATE TABLE tag_catalog_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, last_operation TEXT);
INSERT INTO tag_catalog_state(id,version) VALUES(1,'2026-10-02.1');
CREATE TABLE tag_catalog_snapshots (revision INTEGER PRIMARY KEY, version TEXT NOT NULL, catalog TEXT NOT NULL CHECK(json_valid(catalog)), created_at TEXT NOT NULL);
CREATE INDEX tag_catalog_version ON tag_catalog_snapshots(version,revision DESC);
CREATE TABLE tag_catalog_operations (operation_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, revision INTEGER NOT NULL, dimension TEXT NOT NULL, term_id TEXT NOT NULL, action TEXT NOT NULL, before_value TEXT, after_value TEXT NOT NULL, created_at TEXT NOT NULL);
ALTER TABLE classification_targets ADD COLUMN new_items_only INTEGER NOT NULL DEFAULT 0 CHECK(new_items_only IN(0,1));
