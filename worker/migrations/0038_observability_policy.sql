-- Only the authenticated Go control plane may change this singleton.
-- Version -1 makes the first publication of Go's version 0 unambiguous.
CREATE TABLE observability_policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version >= -1),
  logs TEXT NOT NULL CHECK (logs IN ('off', 'basic', 'diagnostic')),
  fallback_logs TEXT CHECK (fallback_logs IN ('off', 'basic')),
  diagnostic_until INTEGER,
  CHECK ((logs = 'diagnostic' AND fallback_logs IS NOT NULL AND diagnostic_until IS NOT NULL)
      OR (logs != 'diagnostic' AND fallback_logs IS NULL AND diagnostic_until IS NULL))
);
INSERT INTO observability_policy(singleton, version, logs) VALUES (1, -1, 'off');
