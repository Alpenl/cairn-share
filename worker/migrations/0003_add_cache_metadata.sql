CREATE TABLE cache_metadata (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO cache_metadata (key, value, updated_at)
VALUES ('links_generation', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
