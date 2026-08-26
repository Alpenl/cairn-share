ALTER TABLE links ADD COLUMN learned INTEGER NOT NULL DEFAULT 0 CHECK (learned IN (0, 1));
ALTER TABLE links ADD COLUMN learned_at TEXT;
CREATE INDEX links_learned_id_idx ON links (learned, id DESC);
