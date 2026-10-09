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

// The source belongs to the browser capture path. Queue consumers only process
// an already archived original; historical refresh intents never trigger fetches.
export const CAPTURED_SOURCE_SQL = "original_text IS NOT NULL AND original_text<>''";
export const SOURCE_NEXT_COMPONENT_SQL = "'reading'";
export const SOURCE_GATE_READY_SQL = `EXISTS(SELECT 1 FROM enrichment_component_gates g
  WHERE g.component=(${SOURCE_NEXT_COMPONENT_SQL})
    AND (g.state='closed' OR (?=1 AND ((g.state='open' AND g.retry_at<=?)
      OR (g.state='probing' AND g.probe_until<=?)))))`;

// A read-only preflight and the actual source claim share this exact
// candidate predicate. The preflight is only a snapshot; callers that see
// false must not subsequently claim without first running their canary.
function sourceClaimCandidateSQL(index: string, stagePredicate: string): string {
  return `SELECT id
  FROM links INDEXED BY ${index}
  WHERE ${X_LINK_SQL}
    AND ${CAPTURED_SOURCE_SQL}
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
    AND ${stagePredicate}
    AND ${SOURCE_GATE_READY_SQL}
  ORDER BY manual_priority DESC, id ASC
  LIMIT 1`;
}

// The common path retains the smaller priority index. A locally paused stage
// uses a stage-leading index, so a long queue of the excluded stage is not
// scanned on every scheduler tick.
export const SOURCE_CLAIM_CANDIDATE_SQL = sourceClaimCandidateSQL(
  "links_captured_reading_priority_idx", "1=1"
);
export const SOURCE_CLAIM_STAGE_CANDIDATE_SQL = sourceClaimCandidateSQL(
  "links_captured_reading_priority_idx", `(${SOURCE_NEXT_COMPONENT_SQL})=?`
);

export function sourceClaimSQL(stageMask: "both" | "source" | "reading"): string {
  return stageMask === "both" ? SOURCE_CLAIM_CANDIDATE_SQL : SOURCE_CLAIM_STAGE_CANDIDATE_SQL;
}

export function sourceClaimCandidateBindings(
  now: Date, gateAware = true, stageMask: "both" | "source" | "reading" = "both"
): Array<string | number> {
  const nowIso = now.toISOString();
  const budgetStart = nowIso.slice(0, 10) + "T00:00:00.000Z";
  const budgetEnd = new Date(Date.parse(budgetStart) + 86400000).toISOString();
  return [MAX_ENRICHMENT_ATTEMPTS, nowIso, nowIso, nowIso, nowIso,
    budgetStart.slice(0, 10), PROVIDER_ATTEMPT_LIMITS.daily_total,
    budgetStart, budgetEnd, PROVIDER_ATTEMPT_LIMITS.daily_item,
    ...(stageMask === "both" ? [] : [stageMask]),
    gateAware ? 1 : 0, nowIso, nowIso];
}
