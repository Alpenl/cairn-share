-- A personal note is not v2 objective evidence. Keep the legacy target's
-- historical behavior, but do not spend another v2 inference on a note edit.
-- 0009 is already deployed and must remain untouched.
DROP TRIGGER links_classification_input_update;
CREATE TRIGGER links_classification_input_update
AFTER UPDATE OF original_text, url, note ON links
WHEN OLD.original_text IS NOT NEW.original_text OR OLD.url IS NOT NEW.url
  OR (OLD.note IS NOT NEW.note AND EXISTS (
    SELECT 1 FROM classification_target_state s
    JOIN classification_targets t ON t.generation=s.generation
    WHERE s.id=1 AND t.protocol='legacy'
  ))
BEGIN
  INSERT INTO classification_jobs(link_id, status)
    SELECT NEW.id, CASE WHEN COALESCE(NEW.original_text, '') = '' THEN 'waiting_source' ELSE 'pending' END
    WHERE COALESCE(NEW.original_text, '') <> '' OR EXISTS(SELECT 1 FROM classification_jobs WHERE link_id = NEW.id)
    ON CONFLICT(link_id) DO UPDATE SET revision = revision + 1, status = excluded.status, attempts = 0,
      next_retry_at = NULL, lease_token = NULL, lease_until = NULL, error = NULL, result = NULL;
  UPDATE links SET classification = CASE WHEN OLD.classification IS NEW.classification THEN NULL ELSE NEW.classification END WHERE id = NEW.id;
END;
