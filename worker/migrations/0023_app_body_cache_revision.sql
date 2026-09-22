-- App summaries omit these fields. A source revision alone does not invalidate
-- a refreshed translation, image list or related links with the same timestamp.
ALTER TABLE links ADD COLUMN app_body_revision INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER links_app_body_revision_update
AFTER UPDATE OF original_text, translated_text, related_links, images ON links
WHEN OLD.original_text IS NOT NEW.original_text
  OR OLD.translated_text IS NOT NEW.translated_text
  OR OLD.related_links IS NOT NEW.related_links
  OR OLD.images IS NOT NEW.images
BEGIN
  UPDATE links SET app_body_revision = app_body_revision + 1 WHERE id = NEW.id;
END;
