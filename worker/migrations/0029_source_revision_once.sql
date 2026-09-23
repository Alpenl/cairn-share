-- Mirror only the current source context for one atomic input-version check.
-- It is private bookkeeping; immutable evidence and the source payload remain
-- the original records. Backfill does not reclassify or change old revisions.
ALTER TABLE links ADD COLUMN source_context_text TEXT NOT NULL DEFAULT '';
UPDATE links SET source_context_text=COALESCE((
 SELECT CASE WHEN json_valid(s.payload) THEN
   CASE WHEN json_type(s.payload,'$.context_text')='text' THEN json_extract(s.payload,'$.context_text') ELSE '' END
  ELSE '' END
 FROM enrichment_sources s WHERE s.link_id=links.id AND s.url=links.url AND s.original_text=links.original_text
),'');

DROP TRIGGER links_content_revision_update;
DROP TRIGGER links_related_evidence_revision_update;
DROP TRIGGER source_context_revision_update;

-- Each links UPDATE evaluates the full objective input once. Public source
-- saves set all three fields together before upserting the archival payload.
CREATE TRIGGER links_content_revision_update
AFTER UPDATE OF original_text,url,related_links,source_context_text ON links
WHEN OLD.original_text IS NOT NEW.original_text OR OLD.url IS NOT NEW.url
 OR OLD.source_context_text IS NOT NEW.source_context_text
 OR (CASE WHEN json_valid(OLD.related_links) THEN json(OLD.related_links) ELSE '[]' END)
  IS NOT (CASE WHEN json_valid(NEW.related_links) THEN json(NEW.related_links) ELSE '[]' END)
BEGIN
 UPDATE links SET content_revision=content_revision+1 WHERE id=NEW.id;
END;

-- Old/direct source-payload writes still invalidate context. In the current
-- HTTP transaction the mirror already has this value, so synchronization is a
-- no-op. A stale source row must not affect another current URL/primary text.
CREATE TRIGGER source_context_revision_insert
AFTER INSERT ON enrichment_sources
BEGIN
 UPDATE links SET source_context_text = CASE WHEN json_valid(NEW.payload) THEN
   CASE WHEN json_type(NEW.payload,'$.context_text')='text' THEN json_extract(NEW.payload,'$.context_text') ELSE '' END
  ELSE '' END
 WHERE id=NEW.link_id AND url=NEW.url AND original_text=NEW.original_text;
END;
CREATE TRIGGER source_context_revision_update
AFTER UPDATE OF payload,url,original_text ON enrichment_sources
BEGIN
 UPDATE links SET source_context_text = CASE WHEN json_valid(NEW.payload) THEN
   CASE WHEN json_type(NEW.payload,'$.context_text')='text' THEN json_extract(NEW.payload,'$.context_text') ELSE '' END
  ELSE '' END
 WHERE id=NEW.link_id AND url=NEW.url AND original_text=NEW.original_text;
END;
CREATE TRIGGER source_context_revision_delete
AFTER DELETE ON enrichment_sources
BEGIN
 UPDATE links SET source_context_text=''
 WHERE id=OLD.link_id AND url=OLD.url AND original_text=OLD.original_text;
END;
