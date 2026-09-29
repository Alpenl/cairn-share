import { PROVIDER_ATTEMPT_LIMITS } from "./provider-attempts";

export const MAX_ENRICHMENT_ATTEMPTS = 5;

export const X_LINK_SQL = `(
  lower(url) LIKE 'https://x.com/%'
  OR lower(url) LIKE 'http://x.com/%'
  OR lower(url) LIKE 'https://www.x.com/%'
  OR lower(url) LIKE 'http://www.x.com/%'
  OR lower(url) LIKE 'https://twitter.com/%'
  OR lower(url) LIKE 'http://twitter.com/%'
  OR lower(url) LIKE 'https://www.twitter.com/%'
  OR lower(url) LIKE 'http://www.twitter.com/%'
)`;

// A refresh always fetches again. Otherwise the staged Go processor uses a
// current source snapshot or adopts already stored legacy text before reading.
// This expression must stay aligned with processStages' source decision.
export const SOURCE_NEXT_COMPONENT_SQL = `CASE WHEN refresh_requested_at IS NOT NULL
  OR COALESCE(original_text,'')='' THEN 'source' ELSE 'reading' END`;
export const SOURCE_GATE_READY_SQL = `EXISTS(SELECT 1 FROM enrichment_component_gates g
  WHERE g.component=(${SOURCE_NEXT_COMPONENT_SQL})
    AND (g.state='closed' OR (?=1 AND ((g.state='open' AND g.retry_at<=?)
      OR (g.state='probing' AND g.probe_until<=?)))))`;

// A read-only preflight and the actual source claim share this exact
// candidate predicate. The preflight is only a snapshot; callers that see
// false must not subsequently claim without first running their canary.
export const SOURCE_CLAIM_CANDIDATE_SQL = `SELECT id
  FROM links INDEXED BY links_manual_priority_idx
  WHERE ${X_LINK_SQL}
    AND (curation_status <> 'drop' OR manual_priority = 1)
    AND enrichment_status IN ('pending', 'failed', 'processing')
    AND enrichment_paid_uncertain=0
    AND (enrichment_attempts < ? OR
      (enrichment_status='processing' AND enrichment_paid_stage_started=0
        AND enrichment_lease_until IS NOT NULL AND enrichment_lease_until <= ?))
    AND (
      enrichment_status = 'pending'
      OR (
        enrichment_status = 'failed'
        AND (enrichment_next_retry_at IS NULL OR enrichment_next_retry_at <= ?)
      )
      OR (
        enrichment_status = 'processing'
        AND (enrichment_lease_until IS NULL OR enrichment_lease_until <= ?)
      )
    )
    AND (enrichment_status <> 'pending' OR enrichment_next_retry_at IS NULL
      OR enrichment_next_retry_at <= ?)
    AND COALESCE((SELECT total FROM enrichment_provider_daily_usage
      WHERE day=?),0) < ?
    AND (SELECT COUNT(*) FROM enrichment_provider_attempts a
      WHERE a.link_id=links.id AND a.created_at>=? AND a.created_at<?) < ?
    AND ${SOURCE_GATE_READY_SQL}
  ORDER BY manual_priority DESC, id ASC
  LIMIT 1`;

export function sourceClaimCandidateBindings(now: Date, gateAware = true): Array<string | number> {
  const nowIso = now.toISOString();
  const budgetStart = nowIso.slice(0, 10) + "T00:00:00.000Z";
  const budgetEnd = new Date(Date.parse(budgetStart) + 86400000).toISOString();
  return [MAX_ENRICHMENT_ATTEMPTS, nowIso, nowIso, nowIso, nowIso,
    budgetStart.slice(0, 10), PROVIDER_ATTEMPT_LIMITS.daily_total,
    budgetStart, budgetEnd, PROVIDER_ATTEMPT_LIMITS.daily_item,
    gateAware ? 1 : 0, nowIso, nowIso];
}
