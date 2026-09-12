-- App reads can now include enrichment and curation. Invalidate cached pages
-- in the same transaction as an internal update, including lease transitions.
CREATE TRIGGER links_enrichment_cache_update
AFTER UPDATE OF enrichment_status, ai_title, original_language, original_text,
  translated_text, summary, related_links, images, enrichment_updated_at,
  enriched_at, classification, curation, why, curation_status ON links
BEGIN
  UPDATE cache_metadata
     SET value = value + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE key = 'links_generation';
END;
