-- The classification provider breaker is shared by every Go processor.
-- Other paid stages have distinct rows so a TypeSafe outage cannot pause source
-- retrieval or reading. Only classification is wired to this gate initially.
CREATE TABLE enrichment_component_gates (
  component TEXT PRIMARY KEY CHECK (component IN ('source', 'reading', 'classification')),
  state TEXT NOT NULL CHECK (state IN ('closed', 'open', 'probing')),
  epoch INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  probe_token TEXT,
  probe_until TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO enrichment_component_gates(component,state,updated_at) VALUES
  ('source','closed',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('reading','closed',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('classification','closed',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
ALTER TABLE classification_jobs ADD COLUMN component_epoch INTEGER NOT NULL DEFAULT 0;
