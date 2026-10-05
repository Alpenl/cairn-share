CREATE TABLE collections (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)), revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_operation TEXT NOT NULL
);
CREATE INDEX collections_visible ON collections(deleted,archived,pinned,updated_at);
CREATE TABLE collection_items (
 collection_id TEXT NOT NULL REFERENCES collections(id), link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 position INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL,
 PRIMARY KEY(collection_id,link_id)
);
CREATE INDEX collection_items_order ON collection_items(collection_id,position,link_id);
CREATE INDEX collection_items_link ON collection_items(link_id,collection_id);
CREATE TABLE collection_operations(operation_key TEXT PRIMARY KEY,collection_id TEXT NOT NULL,request_hash TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE collection_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,collection_id TEXT NOT NULL,link_id INTEGER);
CREATE TRIGGER collections_insert AFTER INSERT ON collections BEGIN INSERT INTO collection_changes(collection_id) VALUES(NEW.id); END;
CREATE TRIGGER collections_update AFTER UPDATE ON collections BEGIN INSERT INTO collection_changes(collection_id) VALUES(NEW.id); END;
CREATE TRIGGER collection_items_insert AFTER INSERT ON collection_items BEGIN INSERT INTO collection_changes(collection_id,link_id) VALUES(NEW.collection_id,NEW.link_id); END;
CREATE TRIGGER collection_items_update AFTER UPDATE ON collection_items BEGIN INSERT INTO collection_changes(collection_id,link_id) VALUES(NEW.collection_id,NEW.link_id); END;
CREATE TRIGGER collection_items_delete AFTER DELETE ON collection_items BEGIN
 INSERT INTO collection_changes(collection_id,link_id) VALUES(OLD.collection_id,OLD.link_id);
 UPDATE collections SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=OLD.collection_id AND NOT EXISTS(SELECT 1 FROM links WHERE id=OLD.link_id);
END;
