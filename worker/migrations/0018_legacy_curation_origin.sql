-- Freeze historical input separately from the compatibility projection.
-- Rows already exposed to v2 projection writes are ambiguous; preserve their
-- bytes for audit without manufacturing additional legacy accept actions.
CREATE TABLE legacy_curation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  payload TEXT,
  revision INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX legacy_curation_history_link_idx ON legacy_curation_history(link_id, id);
INSERT INTO legacy_curation_history(link_id,payload,revision,provenance,created_at)
  SELECT l.id,l.curation,0,
    CASE WHEN EXISTS(SELECT 1 FROM current_projections p WHERE p.link_id=l.id)
      THEN 'ambiguous_projection' ELSE 'legacy_unknown' END,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM links l WHERE l.curation IS NOT NULL;

-- New projection writers increment this marker in the same UPDATE. An older
-- application can still write the old column: that write is captured as a new
-- unknown-source full-selection event at the next personal revision.
ALTER TABLE links ADD COLUMN curation_projection_epoch INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER legacy_curation_capture_update
AFTER UPDATE OF curation ON links
WHEN OLD.curation_projection_epoch=NEW.curation_projection_epoch
  AND OLD.curation IS NOT NEW.curation
BEGIN
  INSERT INTO legacy_curation_history(link_id,payload,revision,provenance,created_at)
    VALUES(NEW.id,NEW.curation,NEW.personal_revision+1,'legacy_unknown',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  UPDATE links SET personal_revision=personal_revision+1 WHERE id=NEW.id;
END;
