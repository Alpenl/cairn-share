-- URL-only saves wait for a browser capture and never enter the paid queue.
-- Keep old source records, refresh receipts, provider attempts and human data.
CREATE INDEX links_captured_reading_priority_idx ON links(manual_priority DESC, id ASC)
WHERE enrichment_status IN ('pending', 'failed', 'processing')
  AND original_text IS NOT NULL AND original_text<>'';
