-- Cross-device preferences (AI tagging). Reading preferences stay on each device.
CREATE TABLE preferences(
 id INTEGER PRIMARY KEY CHECK(id=1),
 value TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(value)),
 revision INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL DEFAULT '',
 last_operation TEXT NOT NULL DEFAULT ''
);
INSERT INTO preferences(id) VALUES(1);
CREATE TABLE preference_operations(operation_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL);
