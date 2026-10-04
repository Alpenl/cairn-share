-- Configuration-scoped checks survive deployments; never store credentials.
CREATE TABLE provider_checks (
  scope TEXT PRIMARY KEY,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  valid_until INTEGER NOT NULL DEFAULT 0,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  last_started_at INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  manual_after INTEGER NOT NULL DEFAULT 0,
  manual_requests INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS enrichment_provider_canary_time ON enrichment_provider_attempts(stage,created_at);
