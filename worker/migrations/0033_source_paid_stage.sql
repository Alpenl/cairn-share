-- Source claims count an attempt before the process can start paid work.
-- Record paid-stage admission on the lease so a capacity/expiry release can
-- refund only a claim that never reached a paid stage.
ALTER TABLE links ADD COLUMN enrichment_paid_stage_started INTEGER NOT NULL DEFAULT 0
  CHECK (enrichment_paid_stage_started IN (0, 1));

-- A pre-upgrade process may already be paying for a claimed job. It cannot
-- report admission, so never infer that its attempt was unused.
UPDATE links SET enrichment_paid_stage_started=1 WHERE enrichment_status='processing';
