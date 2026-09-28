-- A settled, ledger-bound provider response can be committed after the old
-- source lease expires. The operator-only route inserts one receipt. This
-- trigger performs the entire source, snapshot and queue transition in the
-- same D1 statement; an ineligible operation or snapshot conflict aborts all
-- writes. Private transient payload and lease bytes are erased before commit.
CREATE TABLE enrichment_provider_source_recoveries (
  operation_key TEXT NOT NULL PRIMARY KEY REFERENCES enrichment_provider_attempts(operation_key) ON DELETE CASCADE,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  response_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  source_payload TEXT,
  evidence_payload TEXT,
  evidence_hash TEXT NOT NULL,
  lease_token TEXT,
  lease_hash TEXT,
  response TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX enrichment_provider_source_recoveries_link_idx
  ON enrichment_provider_source_recoveries(link_id, created_at);
CREATE TRIGGER enrichment_provider_source_recoveries_private_delete AFTER DELETE ON links
BEGIN
  DELETE FROM enrichment_provider_source_recoveries WHERE link_id=OLD.id;
END;

CREATE TRIGGER enrichment_provider_source_recoveries_commit
AFTER INSERT ON enrichment_provider_source_recoveries
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM enrichment_provider_attempts a JOIN links l ON l.id=a.link_id
    WHERE a.operation_key=NEW.operation_key AND a.link_id=NEW.link_id
      AND a.stage='fetch' AND a.state='responded' AND a.http_status=200
      AND a.response_id=NEW.response_id AND a.response_id IS NOT NULL
      AND a.model=json_extract(NEW.source_payload,'$.model')
      AND a.lease_hash=NEW.lease_hash AND a.content_revision=l.content_revision
      AND l.enrichment_lease_token=NEW.lease_token AND l.enrichment_lease_until<=NEW.created_at
      AND l.enrichment_paid_uncertain=1 AND l.enrichment_paid_stage='fetch'
      AND l.enrichment_status IN ('processing','failed','exhausted')
      AND NOT EXISTS (SELECT 1 FROM enrichment_provider_reconciliations r
        WHERE r.operation_key=a.operation_key)
      AND NOT EXISTS (SELECT 1 FROM enrichment_provider_attempts other
        WHERE other.link_id=l.id AND other.lease_hash=a.lease_hash
          AND other.stage='fetch' AND other.state='reserved')
  ) THEN RAISE(ABORT,'provider_source_recovery_ineligible') END;

  UPDATE links SET original_text=json_extract(NEW.source_payload,'$.original_text'),
    original_language=json_extract(NEW.source_payload,'$.original_language'),
    source_context_text=json_extract(NEW.source_payload,'$.context_text'),
    related_links=json_extract(NEW.source_payload,'$.related_links'),
    ai_title=NULL,translated_text=NULL,summary=NULL,
    images=CASE WHEN original_text IS json_extract(NEW.source_payload,'$.original_text') THEN images ELSE '[]' END,
    enrichment_model=NULL,enriched_at=NULL,enrichment_status='pending',
    enrichment_attempts=0,enrichment_next_retry_at=NULL,manual_priority=1,
    enrichment_lease_token=NULL,enrichment_lease_until=NULL,enrichment_error=NULL,
    enrichment_paid_uncertain=0,enrichment_paid_stage=NULL,
    refresh_requested_at=NULL,enrichment_updated_at=NEW.created_at
    WHERE id=NEW.link_id;

  INSERT INTO enrichment_sources(link_id,url,original_text,payload,fetched_at)
    SELECT id,url,json_extract(NEW.source_payload,'$.original_text'),NEW.source_payload,NEW.created_at
    FROM links WHERE id=NEW.link_id
    ON CONFLICT(link_id) DO UPDATE SET url=excluded.url,original_text=excluded.original_text,
      payload=excluded.payload,fetched_at=excluded.fetched_at;

  INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,truncated,completeness,created_at)
    SELECT id,content_revision,NEW.evidence_hash,NEW.evidence_payload,0,'complete',NEW.created_at
    FROM links WHERE id=NEW.link_id
    ON CONFLICT(link_id,content_revision) DO NOTHING;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evidence_snapshots s JOIN links l ON l.id=s.link_id
    WHERE l.id=NEW.link_id AND s.content_revision=l.content_revision
      AND s.content_hash=NEW.evidence_hash
  ) THEN RAISE(ABORT,'provider_source_recovery_snapshot_conflict') END;

  UPDATE enrichment_provider_source_recoveries SET
    source_payload=NULL,evidence_payload=NULL,lease_token=NULL,lease_hash=NULL,
    response=json_object('recovered',json('true'),'id',NEW.link_id,'status','source_saved',
      'content_revision',(SELECT content_revision FROM links WHERE id=NEW.link_id))
    WHERE operation_key=NEW.operation_key;
END;
