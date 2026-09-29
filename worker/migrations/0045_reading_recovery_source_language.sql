-- Preserve the saved source language when a settled reading response is recovered.
-- Keep the recovery fence and receipt atomic with the same trigger body.
DROP TRIGGER enrichment_provider_reading_recoveries_commit;
CREATE TRIGGER enrichment_provider_reading_recoveries_commit
AFTER INSERT ON enrichment_provider_reading_recoveries
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM enrichment_provider_attempts a JOIN links l ON l.id=a.link_id
    JOIN enrichment_sources s ON s.link_id=l.id
    WHERE a.operation_key=NEW.operation_key AND a.link_id=NEW.link_id
      AND a.stage='reading' AND a.state='responded' AND a.http_status=200
      AND a.response_id=NEW.response_id AND a.response_id IS NOT NULL
      AND a.model=json_extract(NEW.reading_payload,'$.model')
      AND a.lease_hash=NEW.lease_hash AND a.content_revision=l.content_revision
      AND l.enrichment_lease_token=NEW.lease_token AND l.enrichment_lease_until<=NEW.created_at
      AND l.enrichment_paid_uncertain=1 AND l.enrichment_paid_stage='reading'
      AND l.enrichment_status IN ('processing','failed','exhausted')
      AND s.url=l.url AND s.original_text=l.original_text AND s.payload=NEW.source_payload
      AND EXISTS (SELECT 1 FROM evidence_snapshots e
        WHERE e.link_id=l.id AND e.content_revision=l.content_revision
          AND e.completeness<>'empty'
          AND json_extract(e.payload,'$.blocks[0].text')=l.original_text)
      AND json_extract(s.payload,'$.context_text')=l.source_context_text
      AND json(json_extract(s.payload,'$.related_links'))=json(l.related_links)
      AND ((json_array_length(json_extract(s.payload,'$.image_urls'))=0 AND NEW.images_payload IS NULL)
        OR (json_array_length(json_extract(s.payload,'$.image_urls'))>0
          AND json_valid(NEW.images_payload) AND json_type(NEW.images_payload)='array'))
      AND NOT EXISTS (SELECT 1 FROM enrichment_provider_reconciliations r
        WHERE r.operation_key=a.operation_key)
      AND NOT EXISTS (SELECT 1 FROM enrichment_completion_receipts c
        WHERE c.lease_hash=a.lease_hash)
      AND NOT EXISTS (SELECT 1 FROM enrichment_provider_attempts other
        WHERE other.link_id=l.id AND other.lease_hash=a.lease_hash
          AND other.stage='reading' AND other.state='reserved')
  ) THEN RAISE(ABORT,'provider_reading_recovery_ineligible') END;

  UPDATE links SET enrichment_status='completed',manual_priority=0,
    enrichment_next_retry_at=NULL,enrichment_lease_token=NULL,enrichment_lease_until=NULL,
    enrichment_paid_uncertain=0,enrichment_paid_stage=NULL,
    ai_title=json_extract(NEW.reading_payload,'$.ai_title'),
    original_language=COALESCE(NULLIF(json_extract(NEW.source_payload,'$.original_language'),''),
      json_extract(NEW.reading_payload,'$.original_language')),
    translated_text=json_extract(NEW.reading_payload,'$.translated_text'),
    summary=json_extract(NEW.reading_payload,'$.summary'),
    images=COALESCE(NEW.images_payload,images),
    enrichment_model=json_extract(NEW.reading_payload,'$.model'),
    enrichment_error=NULL,enrichment_updated_at=NEW.created_at,enriched_at=NEW.created_at
    WHERE id=NEW.link_id;

  UPDATE enrichment_provider_reading_recoveries SET
    reading_payload=NULL,source_payload=NULL,images_payload=NULL,
    lease_token=NULL,lease_hash=NULL,
    response=json_object('recovered',json('true'),'id',NEW.link_id,
      'status','completed','content_revision',(SELECT content_revision FROM links WHERE id=NEW.link_id),
      'enriched_at',NEW.created_at)
    WHERE operation_key=NEW.operation_key;
END;
