-- Each actual xAI POST must obtain one durable, single-use permit. A lost
-- provider response leaves the reservation charged and blocks automatic
-- fallback. Link-scoped records are erased with the bookmark.
CREATE TABLE enrichment_provider_attempts (
  operation_key TEXT PRIMARY KEY,
  link_id INTEGER REFERENCES links(id) ON DELETE CASCADE,
  lease_hash TEXT,
  content_revision INTEGER,
  stage TEXT NOT NULL CHECK (stage IN ('fetch', 'reading', 'canary')),
  variant TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number IN (1, 2)),
  request_hash TEXT NOT NULL,
  reservation_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'responded')),
  http_status INTEGER,
  response_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  x_search_calls INTEGER,
  cost_usd_ticks INTEGER,
  fallback_authorized INTEGER NOT NULL DEFAULT 0 CHECK (fallback_authorized IN (0, 1)),
  settlement_hash TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK ((stage='canary' AND link_id IS NULL AND lease_hash IS NULL AND content_revision IS NULL)
    OR (stage<>'canary' AND link_id IS NOT NULL AND lease_hash IS NOT NULL AND content_revision IS NOT NULL))
);
CREATE INDEX enrichment_provider_attempts_day_idx
  ON enrichment_provider_attempts(created_at, stage);
CREATE INDEX enrichment_provider_attempts_item_day_idx
  ON enrichment_provider_attempts(link_id, created_at);
CREATE INDEX enrichment_provider_attempts_lease_idx
  ON enrichment_provider_attempts(link_id, lease_hash, stage, attempt_number);
CREATE INDEX enrichment_provider_attempts_state_idx
  ON enrichment_provider_attempts(state, created_at);
CREATE TRIGGER enrichment_provider_attempts_private_delete AFTER DELETE ON links
BEGIN
  DELETE FROM enrichment_provider_attempts WHERE link_id=OLD.id;
END;

-- Admission alone is free. The unknown-cost marker and attempt consumption
-- begin in the same SQLite statement that creates the single-use permit.
CREATE TRIGGER enrichment_provider_attempts_mark_paid AFTER INSERT ON enrichment_provider_attempts
WHEN NEW.link_id IS NOT NULL
BEGIN
  UPDATE links SET enrichment_paid_stage_started=1,enrichment_paid_uncertain=1
    WHERE id=NEW.link_id;
END;
