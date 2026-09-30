-- F08/F13: the objective content revision must advance for every change to the
-- actual source bytes, not only when an evidence snapshot is submitted. Without
-- this, a URL edit or a refreshed source could leave a stored decision looking
-- current and a late completion could overwrite the new projection.
--
-- The trigger only advances on an actual change (SQLite `IS NOT` treats equal
-- values, including NULLs, as unchanged), so a note-only edit stays personal.

CREATE TRIGGER links_content_revision_update
AFTER UPDATE OF original_text, url ON links
WHEN OLD.original_text IS NOT NEW.original_text OR OLD.url IS NOT NEW.url
BEGIN
  UPDATE links SET content_revision = content_revision + 1 WHERE id = NEW.id;
END;

-- Existing rows whose source changed before this migration cannot be
-- reconstructed, so they keep their stored revision. No backfill.
