-- Context is objective evidence even when the primary text is unchanged.
-- Invalidate the old snapshot identity in the same source-save transaction.
-- Primary/URL changes already advance the revision via migration 0014.
CREATE TRIGGER source_context_revision_update
AFTER UPDATE ON enrichment_sources
WHEN OLD.original_text IS NEW.original_text AND OLD.url IS NEW.url
  AND COALESCE(json_extract(OLD.payload, '$.context_text'), '')
      IS NOT COALESCE(json_extract(NEW.payload, '$.context_text'), '')
BEGIN
  UPDATE links SET content_revision = content_revision + 1 WHERE id = NEW.link_id;
END;
