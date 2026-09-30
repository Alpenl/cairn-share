-- A process may pause only one paid stage. Keep the other stage's claim
-- ordered by manual priority without scanning every excluded bookmark.
-- This expression must match SOURCE_NEXT_COMPONENT_SQL in source-claim.ts.
CREATE INDEX links_source_stage_priority_idx ON links(
  (CASE WHEN refresh_requested_at IS NOT NULL
    OR COALESCE(original_text,'')='' THEN 'source' ELSE 'reading' END),
  manual_priority DESC, id ASC
) WHERE enrichment_status IN ('pending', 'failed', 'processing');
