-- A paid call can finish at the provider after the Go process loses its
-- response. Keep an unresolved pre-call marker before the network request so
-- lease expiry alone never authorizes another automatic paid call.
ALTER TABLE links ADD COLUMN enrichment_paid_uncertain INTEGER NOT NULL DEFAULT 0
  CHECK (enrichment_paid_uncertain IN (0, 1));
ALTER TABLE links ADD COLUMN enrichment_paid_stage TEXT
  CHECK (enrichment_paid_stage IS NULL OR enrichment_paid_stage IN ('fetch', 'reading', 'legacy_unknown'));

-- A process already running during this migration cannot report which stage
-- it reached. Conservatively require review if its lease later expires.
UPDATE links SET enrichment_paid_uncertain=1,enrichment_paid_stage='legacy_unknown'
  WHERE enrichment_status='processing' AND enrichment_paid_stage_started=1;
