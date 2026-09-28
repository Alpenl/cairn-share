-- An operator may release an unknown paid attempt only after obtaining
-- external proof that the provider did not bill it. The original permit is
-- never erased or refunded; a new lease uses a different operation key.
CREATE TABLE enrichment_provider_reconciliations (
  operation_key TEXT PRIMARY KEY REFERENCES enrichment_provider_attempts(operation_key) ON DELETE CASCADE,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK (verdict='confirmed_not_billed'),
  actor TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('provider_invoice','provider_support')),
  evidence_ref TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX enrichment_provider_reconciliations_link_idx
  ON enrichment_provider_reconciliations(link_id, created_at);
CREATE TRIGGER enrichment_provider_reconciliations_private_delete AFTER DELETE ON links
BEGIN
  DELETE FROM enrichment_provider_reconciliations WHERE link_id=OLD.id;
END;
