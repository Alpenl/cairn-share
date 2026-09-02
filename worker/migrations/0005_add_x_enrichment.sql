ALTER TABLE links ADD COLUMN enrichment_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (enrichment_status IN ('pending', 'processing', 'completed', 'failed', 'exhausted'));
ALTER TABLE links ADD COLUMN enrichment_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (enrichment_attempts >= 0);
ALTER TABLE links ADD COLUMN enrichment_next_retry_at TEXT;
ALTER TABLE links ADD COLUMN enrichment_lease_token TEXT;
ALTER TABLE links ADD COLUMN enrichment_lease_until TEXT;
ALTER TABLE links ADD COLUMN original_text TEXT;
ALTER TABLE links ADD COLUMN summary TEXT;
ALTER TABLE links ADD COLUMN related_links TEXT;
ALTER TABLE links ADD COLUMN enrichment_model TEXT;
ALTER TABLE links ADD COLUMN enrichment_error TEXT;
ALTER TABLE links ADD COLUMN enrichment_updated_at TEXT;
ALTER TABLE links ADD COLUMN enriched_at TEXT;

CREATE INDEX links_enrichment_queue_idx
  ON links (enrichment_status, enrichment_next_retry_at, id);
