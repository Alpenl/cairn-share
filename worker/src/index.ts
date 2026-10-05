import { collectionOrganizingRoute } from "./collection-organizing";
import { collectionsRoute, collectionID } from "./collections";
import { librarySyncRoute, maintainLibrarySync } from "./library-sync";
import { presentationColumns, presentationRoute } from "./presentations";
import { browserCapture } from "./browser-capture";
import { mediaRoute } from './archived-media';
import { readBoundedJSON, readJSONObject } from "./json-body";
import { ReadProfile, profileBindings } from "./read-profiling";
import { indexedSearchCandidate } from "./search-index";
import { encodeCursor, decodeCursor } from "./cursor";
import { cleanupDeletedImages, maintainPrivacy } from "./privacy";
import { selectionFilters, SELECTION_FILTER_KEYS, entityStateSQL } from "./selection-filter";
import { tagSystemRoute, attachTagSummaries, projectTagSummaryRows, contentFunctionsAware } from "./tag-system";
import { bookmarkSource, record, storedClassification, taxonomy, validCurationStatus, validTerm, validateClassification, validateSelection } from "./curation";
import { ackSourceRefresh, classificationRoute, manualEnqueueRoute, manualSourceRoute, refreshSource, sourceRoute } from "./classification";
import { computeEffective, domainRoute, persistSelectionOverrides } from "./domain-routes";
import { applyV1Write, topicGranularityAware } from "./taxonomy-v2";
import { canonicalJSON } from "./domain";
import { selectionPayload, taxonomyV2Route } from "./taxonomy-routes";
import { readSelectionSnapshot, tagSummaryColumns, type TagSummaryRow } from "./selection-state";
import { emitProviderRecovery, emitRequest, emitWorkerBusiness, logExporterStatus, policyReadAvailable, publishPolicy, requestPolicy,
  type ProviderRecoveryEvent, type RequestD1Stats, type WorkerBusinessEvent } from "./observability";
import { providerCheckRoute } from "./provider-checks";
import { providerAttemptRoute, PROVIDER_ATTEMPT_LIMITS } from "./provider-attempts";
import { MAX_ENRICHMENT_ATTEMPTS, SOURCE_CLAIM_CANDIDATE_SQL, SOURCE_GATE_READY_SQL,
  SOURCE_NEXT_COMPONENT_SQL, X_LINK_SQL,
  sourceClaimCandidateBindings, sourceClaimSQL } from "./source-claim";

export interface Env {
  CAIRN_CLASSIFICATION_MAX_CALLS?: string;
  DB: D1Database;
  ENRICHMENT_IMAGES: R2Bucket;
  CAIRN_API_TOKEN: string;
  CAIRN_ENRICHER_TOKEN: string;
  CAIRN_OPERATOR_TOKEN?: string;
  HISTORY_RETENTION_DAYS?: string;
}

interface LinkRecord {
  id: number;
  url: string;
  note: string;
  created_at: string;
  learned: boolean;
  learned_at: string | null;
}

interface LinkRow {
  id: number;
  url: string;
  note: string;
  created_at: string;
  learned: number;
  learned_at: string | null;
}

interface EnrichmentJobRow {
  id: number;
  url: string;
  note: string;
  created_at: string;
  enrichment_attempts: number;
  enrichment_lease_token: string;
  enrichment_lease_until: string;
  refresh_epoch: number;
  content_revision: number;
  source_component: "source" | "reading";
}

type EnrichmentStatus = "pending" | "processing" | "completed" | "failed" | "exhausted";
type EnrichmentFilter = EnrichmentStatus | "unsupported";

interface EnrichmentListRow {
  search_excerpt?: string;
  content_revision?: number;
  personal_revision?: number;
  app_body_revision?: number;
  cache_decision_id?: number;
  cache_entity_revision?: number;
  id: number;
  url: string;
  note: string;
  created_at: string;
  enrichment_status: EnrichmentStatus;
  enrichment_attempts: number;
  enrichment_next_retry_at: string | null;
  enrichment_paid_uncertain: number;
  enrichment_paid_stage: string | null;
  ai_title: string | null;
  original_language: string | null;
  formatted_content?: string | null;
  formatting_status?: string | null;
  original_text: string | null;
  translated_text: string | null;
  summary: string | null;
  related_links: string | null;
  images: string | null;
  enrichment_model: string | null;
  enrichment_error: string | null;
  enrichment_updated_at: string | null;
  enriched_at: string | null;
  processable: number;
  classification: string | null;
  curation: string | null;
  why: string;
  curation_status: string;
}

type EnrichmentDetailRow = EnrichmentListRow;

interface EnrichmentImage {
  key: string;
  content_type: string;
}

interface EnrichmentCountRow {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  exhausted: number;
  unsupported: number;
}

type ErrorCode =
  | "invalid_json"
  | "invalid_expected_revision"
  | "invalid_content_type"
  | "invalid_url"
  | "invalid_note"
  | "invalid_client_id"
  | "invalid_learned"
  | "invalid_query"
  | "invalid_update"
  | "invalid_limit"
  | "invalid_before_id"
  | "invalid_status"
  | "invalid_enrichment"
  | "invalid_curation"
  | "invalid_images"
  | "image_fetch_failed"
  | "missing_auth"
  | "invalid_token"
  | "auth_not_configured"
  | "lease_conflict"
  | "lease_released"
  | "component_paused"
  | "provider_attempt_missing"
  | "provider_result_unknown"
  | "job_busy"
  | "not_found"
  | "method_not_allowed"
  | "invalid_classification_config"
  | "invalid_classification"
  | "invalid_source"
  | "invalid_operation_key"
  | "invalid_cursor"
  | "capability_mismatch"
  | "target_changed"
  | "input_changed"
  | "lease_expired"
  | "already_completed"
  | "operation_conflict"
  | "configuration_error";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "X-Cairn-Collections, Content-Type, Authorization, Range, X-Cairn-Tag-System, X-Cairn-Content-Functions, X-Cairn-Queue, X-Cairn-Tag-Export, X-Cairn-Run-History, X-Cairn-Search-Summary, X-Cairn-Classification-Attempts, X-Cairn-Topic-Granularity, X-Cairn-Candidate-Manifest, X-Cairn-Image-Privacy, X-Cairn-Backstage, X-Cairn-Sync, If-Match, If-None-Match",
  "Access-Control-Expose-Headers": "X-Cairn-Collections, X-Cairn-Sync, X-Cairn-Tag-System, X-Cairn-Content-Functions, X-Cairn-Queue, X-Cairn-Tag-Export, X-Cairn-Run-History, X-Cairn-Search-Summary, X-Cairn-Classification-Attempts, X-Cairn-Topic-Granularity, X-Cairn-Candidate-Manifest, X-Cairn-Image-Privacy, X-Cairn-Backstage",
  "Access-Control-Max-Age": "86400"
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  ...CORS_HEADERS
};

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  ...CORS_HEADERS
};

const MAX_URL_LENGTH = 8192;
const MAX_NOTE_LENGTH = 2000;
const MAX_QUERY_LENGTH = 200;
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ENRICHMENT_LEASE_MILLISECONDS = 15 * 60 * 1000;
const MAX_ORIGINAL_TEXT_LENGTH = 100_000;
const MAX_TRANSLATED_TEXT_LENGTH = 100_000;
const MAX_AI_TITLE_LENGTH = 200;
const MAX_ORIGINAL_LANGUAGE_LENGTH = 32;
const MAX_SUMMARY_LENGTH = 4_000;
const MAX_RELATED_LINKS = 50;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 15 << 20;
const MAX_MODEL_LENGTH = 200;
const MAX_ENRICHMENT_ERROR_LENGTH = 2_000;
const ENRICHMENT_RETRY_DELAYS_MILLISECONDS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
const READ_CACHE_TTL_SECONDS = 15;
// The overview is polled every 30s. Its generation key changes on writes, so
// retain an unchanged snapshot across polls without delaying invalidation.
const OVERVIEW_CACHE_TTL_SECONDS = 15 * 60;
const CACHE_VERSION = "4";
const CACHE_ORIGIN = "https://cairn-share-cache.internal";
const LINKS_CACHE_GENERATION_KEY = "links_generation";
const LINK_COLUMNS = "id, url, note, created_at, learned, learned_at";
const ENRICHMENT_COLUMNS = `enrichment_status, enrichment_attempts, enrichment_next_retry_at,
  enrichment_paid_uncertain, enrichment_paid_stage,
  ai_title, original_language, summary, images, enrichment_model, enrichment_error,
  enrichment_updated_at, enriched_at, classification, curation, why, curation_status,
  CASE WHEN ${X_LINK_SQL} THEN 1 ELSE 0 END AS processable`;

// Lists omit the two potentially 100 KB bodies. Detail reads retain them.
function contentColumns(summary: boolean): string {
  return summary
    ? "NULL AS original_text, NULL AS translated_text, NULL AS related_links"
    : `original_text, translated_text, related_links, ${presentationColumns}`;
}

function searchExcerptColumns(enabled: boolean, query: string | undefined): { sql: string; bindings: string[] } {
  if (!enabled || !query) return { sql: "", bindings: [] };
  return { sql: `,COALESCE((SELECT substr(s.value,MAX(1,instr(lower(s.value),lower(t.value))-60),240)
    FROM json_each(json_array(COALESCE(translated_text,''),COALESCE(original_text,''),COALESCE(summary,''),
      COALESCE(note,''),COALESCE(why,''),COALESCE(ai_title,''),url)) s
    JOIN json_each(?) t ON instr(lower(s.value),lower(t.value))>0
    ORDER BY CAST(s.key AS INTEGER),instr(lower(s.value),lower(t.value)) LIMIT 1),
    substr(COALESCE(NULLIF(summary,''),NULLIF(note,''),NULLIF(why,''),NULLIF(ai_title,''),url),1,240)) AS search_excerpt`,
    bindings: [JSON.stringify(query.split(/\s+/))] };
}

function includeEnrichment(url: URL): boolean {
  return url.searchParams.get("include") === "enrichment";
}

function includeCacheIdentity(url: URL): boolean {
  return includeEnrichment(url) && url.searchParams.get("include_cache_identity") === "1";
}

function cacheIdentityColumns(enabled: boolean): string {
  // Latest canonical versions are invalidation markers, not provenance of the
  // legacy classification projection returned alongside them.
  return enabled ? `, content_revision, app_body_revision, personal_revision,
    COALESCE((SELECT MAX(d.id) FROM classification_decisions d WHERE d.link_id=links.id),0) AS cache_decision_id,
    COALESCE((SELECT e.revision FROM entity_states e WHERE e.link_id=links.id),0) AS cache_entity_revision` : "";
}

type CacheState = "MISS" | "HIT" | "BYPASS";

class TimingCollector {
  readonly profile = new ReadProfile();
  private readonly started = performance.now();
  private readonly entries: Array<{ name: string; duration: number }> = [];
  private cacheState: CacheState | null = null;
  private d1Stats: RequestD1Stats | undefined;
  private recoveryEvent: ProviderRecoveryEvent | undefined;
  private readonly businessEvents: WorkerBusinessEvent[] = [];

  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      this.entries.push({ name, duration: performance.now() - started });
    }
  }

  setCacheState(cacheState: CacheState): void {
    this.cacheState = cacheState;
  }

  setD1Stats(stats: RequestD1Stats): void {
    if (Number.isSafeInteger(stats.rows_read) && stats.rows_read >= 0 &&
      Number.isSafeInteger(stats.rows_written) && stats.rows_written >= 0) this.d1Stats = stats;
  }

  requestD1Stats(): RequestD1Stats | undefined {
    return this.d1Stats;
  }

  setRecoveryEvent(event: ProviderRecoveryEvent): void {
    this.recoveryEvent = event;
  }

  providerRecoveryEvent(): ProviderRecoveryEvent | undefined {
    return this.recoveryEvent;
  }

  addBusinessEvent(event: WorkerBusinessEvent): void {
    this.businessEvents.push(event);
  }

  workerBusinessEvents(): readonly WorkerBusinessEvent[] {
    return this.businessEvents;
  }

  headerValue(): string {
    const total = performance.now() - this.started;
    const metrics = [`total;dur=${formatDuration(total)}`];
    if (this.cacheState !== null) {
      metrics.push(`cache-state;desc="${this.cacheState}"`);
    }
    metrics.push(`db;dur=${formatDuration(this.profile.dbMilliseconds)}`, `r2;dur=${formatDuration(this.profile.r2Milliseconds)}`,
      `sql-count;desc="${this.profile.sqlCount}"`, `db-round-trips;desc="${this.profile.dbRoundTrips}"`,
      `rows-read;desc="${this.profile.rowsRead}"`, `rows-read-unknown;desc="${this.profile.unknownRows}"`, `r2-calls;desc="${this.profile.r2Calls}"`);
    for (const entry of this.entries.filter(entry => entry.name !== "db")) {
      metrics.push(`${entry.name};dur=${formatDuration(entry.duration)}`);
    }
    return metrics.join(", ");
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await maintainPrivacy(env);
    await maintainLibrarySync(env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const timing = new TimingCollector();
    env = profileBindings(env, timing.profile);
    const path = new URL(request.url).pathname;
    if (path === "/api/internal/observability" || request.method === "OPTIONS") {
      return withServerTiming(await handleRequest(request, env, timing), timing);
    }
    // Log policy and business data are independent reads. Start both before
    // waiting, but resolve the policy before emitting any logs or its headers.
    const policyRead = requestPolicy(env.DB);
    const started = performance.now();
    let response: Response | null = null;
    try {
      response = await handleRequest(request, env, timing);
      const policy = await policyRead;
      response = withServerTiming(response, timing);
      if (response.ok) response.headers.set("X-Cairn-Sync", "1");
      if (request.headers.get("X-Cairn-Collections") === "1") response.headers.set("X-Cairn-Collections", "1");
      if (contentFunctionsAware(request)) response.headers.set("X-Cairn-Content-Functions", "1");
      if (request.headers.get("X-Cairn-Search-Summary") === "1") response.headers.set("X-Cairn-Search-Summary", "1");
      if (request.headers.get("X-Cairn-Tag-System") === "1") response.headers.set("X-Cairn-Tag-System", "1");
      else if (![204, 304].includes(response.status) && response.headers.get("Content-Type")?.includes("application/json")) {
        // Strict old clients must never see new optional dimensions.
        const removeNew = (value: unknown): unknown => Array.isArray(value) ? value.map(removeNew) :
          value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .filter(([key]) => key !== "resource_kinds" && key !== "custom_tags").map(([key, child]) => [key, removeNew(child)])) : value;
        const body = await response.clone().json();
        response = new Response(JSON.stringify(removeNew(body)), { status: response.status, headers: response.headers });
      }
      if (topicGranularityAware(request)) response.headers.set("X-Cairn-Topic-Granularity", "1");
      if (request.headers.get("X-Cairn-Candidate-Manifest") === "2") response.headers.set("X-Cairn-Candidate-Manifest", "2");
      response.headers.set("X-Cairn-Observability-Version", String(policy.version));
      if (!policyReadAvailable(policy)) response.headers.set("X-Cairn-Observability-Status", "unavailable");
      else if (policy.version === -1) response.headers.set("X-Cairn-Observability-Status", "unconfigured");
      return response;
    } finally {
      const policy = await policyRead;
      for (const event of timing.workerBusinessEvents()) {
        try { emitWorkerBusiness(policy, event); } catch { /* optional logs never fail business */ }
      }
      try { emitProviderRecovery(policy, timing.providerRecoveryEvent()); } catch { /* optional logs never fail business */ }
      try { emitRequest(policy, request, response, performance.now() - started, timing.requestD1Stats()); } catch { /* optional logs never fail business */ }
    }
  }
};

async function observeManualRoute(timing: TimingCollector, action: "source" | "process",
  execute: (onResolved: (outcome: "accepted" | "replay") => void) => Promise<Response>): Promise<Response> {
  let outcome: "accepted" | "replay" | "rejected" = "rejected";
  try {
    const response = await execute((resolved) => { outcome = resolved; });
    timing.addBusinessEvent({ kind: "manual_request", action, outcome, status: response.status });
    return response;
  } catch (cause) {
    timing.addBusinessEvent({ kind: "manual_request", action, outcome: "failed", status: 500 });
    throw cause;
  }
}

async function observeEnrichmentCommit(timing: TimingCollector, stage: "source" | "complete",
  execute: (onResolved: (outcome: "stored" | "committed" | "replay" | "receipt_confirmed") => void) =>
    Promise<Response>): Promise<Response> {
  let outcome: "stored" | "committed" | "replay" | "receipt_confirmed" | "rejected" = "rejected";
  try {
    const response = await execute((resolved) => { outcome = resolved; });
    timing.addBusinessEvent({ kind: "enrichment_commit", stage, outcome, status: response.status });
    return response;
  } catch (cause) {
    timing.addBusinessEvent({ kind: "enrichment_commit", stage, outcome: "failed", status: 500 });
    throw cause;
  }
}

async function handleRequest(request: Request, env: Env, timing: TimingCollector): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = trimTrailingSlash(url.pathname);
  const functionsFlag = request.headers.get("X-Cairn-Content-Functions");
  if (functionsFlag !== null && (functionsFlag !== "1" || !contentFunctionsAware(request))) return error("capability_mismatch", 409);
  const candidateFlag = request.headers.get("X-Cairn-Candidate-Manifest");
  if (candidateFlag !== null && candidateFlag !== "2") return error("capability_mismatch", 409);
  if (request.headers.has("X-Cairn-Search-Summary") && request.headers.get("X-Cairn-Search-Summary") !== "1") return error("capability_mismatch", 409);
  const granularityFlag = request.headers.get("X-Cairn-Topic-Granularity");
  for (const capability of ["X-Cairn-Image-Privacy", "X-Cairn-Backstage"]) {
    if (request.headers.has(capability) && request.headers.get(capability) !== "1") return error("capability_mismatch", 409);
  }
  if (granularityFlag !== null && (granularityFlag !== "1" || !topicGranularityAware(request))) return error("capability_mismatch", 409);
  if (url.searchParams.has("topic_refinements") && !topicGranularityAware(request)) return error("capability_mismatch", 409);
  // This is an internal cache discriminator for the two negotiated bookmark
  // read shapes. Aggregate routes reject queries and do not need it. A caller
  // cannot select the negotiated cache by supplying this query parameter.
  if (path === "/api/links" || /^\/api\/links\/\d+$/.test(path)) {
    url.searchParams.delete("tag_system");
    url.searchParams.delete("content_functions_view");
    url.searchParams.delete("search_summary_view");
    if (request.headers.get("X-Cairn-Tag-System") === "1") url.searchParams.set("tag_system", "1");
    if (contentFunctionsAware(request)) url.searchParams.set("content_functions_view", "1");
    if (request.headers.get("X-Cairn-Search-Summary") === "1") url.searchParams.set("search_summary_view", "1");
  }
  const newTagFilter = ["resource_kinds", "resource_kind", "custom_tags", "custom_tag", "topics_mode", "topic_mode", "resource_mode", "custom_mode"].some(key => url.searchParams.has(key));
  if (newTagFilter && request.headers.get("X-Cairn-Tag-System") !== "1") return error("capability_mismatch", 409);
  if (url.searchParams.has("functions_mode") && !contentFunctionsAware(request)) return error("capability_mismatch", 409);

  if (path === "/api/internal/observability") {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET", "POST"], () => request.method === "GET"
      ? requestPolicy(env.DB).then((policy) => json(logExporterStatus(policy), 200,
        { "Cache-Control": "private, no-store" }))
      : publishPolicy(request, env.DB));
  }

  if (path === "/" || path === "/debug") {
    return routeMethod(request, ["GET"], () => html(apiDebugHtml()));
  }

  if (path === "/health") {
    return routeMethod(request, ["GET"], () => json({ ok: true }));
  }

  if (path === "/api/collections" || path.startsWith("/api/collections/") || path === "/api/enrichment/collections" || path.startsWith("/api/enrichment/collections/")) {
    const internal = path.startsWith("/api/enrichment/");
    const auth = internal ? requireEnricherToken(request, env) : requireApiToken(request, env);
    if (auth) return auth;
    const collectionPath=path.replace("/api/enrichment/collections", "/api/collections");
    if(collectionPath.startsWith("/api/collections/organizing")) return collectionOrganizingRoute(request,env,collectionPath,internal);
    return collectionsRoute(request, env, collectionPath);
  }

  if (path === "/api/sync") {
    const authError = requireApiToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET"], () => librarySyncRoute(request, env, async (ids) => {
      if (!ids.length) return [];
      const rows = await env.DB.prepare(`SELECT ${LINK_COLUMNS},${ENRICHMENT_COLUMNS},${contentColumns(false)}${cacheIdentityColumns(true)},${tagSummaryColumns()},
        ${entityStateSQL} AS entity_state
        FROM links WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id DESC`).bind(JSON.stringify(ids)).all<LinkRow & EnrichmentListRow & TagSummaryRow & {entity_state:string}>();
      return projectTagSummaryRows(rows.results.map(row => {
        const item = mapAppLink(row, true, true);
        item.enrichment.entity_state = row.entity_state;
        return item as unknown as Record<string, unknown>;
      }), rows.results, false, true);
    }));
  }

  if (/^\/api\/links\/\d+\/presentation$/.test(path) || path.startsWith("/api/enrichment/presentations/") || /^\/api\/enrichment\/\d+\/presentation$/.test(path)) {
    const auth = path.startsWith("/api/links/") ? requireApiToken(request, env) : requireEnricherToken(request, env);
    if (auth) return auth;
    return presentationRoute(request, env, path);
  }

  if (path === "/api/captures") {
    const auth = requireApiToken(request, env);
    if (auth) return auth;
    return routeMethod(request, ["POST"], () => browserCapture(request, env));
  }

  if (path.startsWith('/api/media/') || path.startsWith('/api/enrichment/media/') || /^\/api\/(links|enrichment)\/\d+\/media$/.test(path)) {
    const auth = path.startsWith('/api/enrichment/') ? requireEnricherToken(request, env) : requireApiToken(request, env);
    if (auth) return auth;
    return mediaRoute(request, env, path);
  }

  if (path === "/api/links") {
    const authError = requireApiToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET", "POST"], () => {
      if (request.method === "POST") return createLink(request, env, timing);
      return listLinks(request, url, env, timing);
    });
  }

  if (path === "/api/links/queue") {
    const authError = requireApiToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET"], () => learningQueue(request, url, env, timing));
  }

  if (path === "/api/taxonomy") {
    const authError = requireApiToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET"], () => json(taxonomy));
  }

  const appCurationMatch = path.match(/^\/api\/links\/(\d+)\/curation$/);
  if (appCurationMatch !== null) {
    const authError = requireApiToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["PATCH"], () => updateCuration(request, env, Number(appCurationMatch[1]), timing, true));
  }

  const appImageMatch = path.match(/^\/api\/images\/(.+)$/);
  if (appImageMatch !== null) {
    const authError = requireApiToken(request, env);
    if (authError !== null) return authError;
    const key = decodePathComponent(appImageMatch[1]);
    if (key === null) return error("not_found", 404);
    return routeMethod(request, ["GET"], () => getEnrichmentImage(request, env, key));
  }

  const sourceMatch = path.match(/^\/api\/enrichment\/jobs\/(\d+)\/source$/);
  const manualSourceMatch = path.match(/^\/api\/enrichment\/jobs\/(\d+)\/manual-source$/);
  const manualEnqueueMatch = path.match(/^\/api\/enrichment\/jobs\/(\d+)\/enqueue$/);
  const refreshMatch = path.match(/^\/api\/enrichment\/jobs\/(\d+)\/refresh-source$/);
  const refreshAckMatch = path.match(/^\/api\/enrichment\/jobs\/(\d+)\/refresh-source\/ack$/);
  if (sourceMatch || manualSourceMatch || manualEnqueueMatch || refreshMatch || refreshAckMatch || path.startsWith("/api/enrichment/classifications/")) {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    if (refreshAckMatch) {
      if (request.method !== "POST") return error("method_not_allowed", 405);
      return ackSourceRefresh(request, env, Number(refreshAckMatch[1]));
    }
    if (refreshMatch) {
      if (request.method !== "POST") return error("method_not_allowed", 405);
      return refreshSource(request, env, Number(refreshMatch[1]));
    }
    if (manualSourceMatch) {
      if (request.method !== "POST") return error("method_not_allowed", 405);
      return observeManualRoute(timing, "source", (onResolved) =>
        manualSourceRoute(request, env, Number(manualSourceMatch[1]), onResolved));
    }
    if (manualEnqueueMatch) {
      if (request.method !== "POST") return error("method_not_allowed", 405);
      return observeManualRoute(timing, "process", (onResolved) =>
        manualEnqueueRoute(request, env, Number(manualEnqueueMatch[1]), onResolved));
    }
    if (sourceMatch) {
      if (request.method === "GET") return sourceRoute(request, env, Number(sourceMatch[1]));
      return observeEnrichmentCommit(timing, "source", (onResolved) =>
        sourceRoute(request, env, Number(sourceMatch[1]), () => onResolved("stored"), () =>
          timing.addBusinessEvent({ kind: "component_gate", component: "source", action: "closed" })));
    }
    return classificationRoute(request, env, path, (event) => timing.addBusinessEvent({
      kind: "component_gate", component: "classification", action: event.action
    }));
  }

  // App-facing curation is an exact allowlist, never an alias for arbitrary
  // internal v2 paths. Reads and human field actions do not invoke a model.
  const appV2 = path.match(/^\/api\/bookmarks\/(\d+)\/(v2-selection|v2-override)$/);
  const appTags = path.match(/^\/api\/bookmarks\/(\d+)\/(tags|tag-history)$/);
  if (appTags || /^\/api\/custom-tags(?:\/[A-Za-z0-9-]+)?$/.test(path) || ["/api/tag-counts", "/api/tag-export"].includes(path)) {
    const authError = requireApiToken(request, env);
    if (authError !== null) return authError;
    const route = appTags ? `/api/v2/links/${appTags[1]}/${appTags[2]}` : path.startsWith("/api/custom-tags")
      ? path.replace("/api/custom-tags", "/api/v2/custom-tags") : path === "/api/tag-counts" ? "/api/v2/tags/counts" : "/api/v2/tags/export";
    return (await tagSystemRoute(request, env, route)) ?? error("not_found", 404);
  }
  if (path === "/api/v2-taxonomy" || appV2) {
    const authError = requireApiToken(request, env);
    if (authError !== null) return authError;
    if (path === "/api/v2-taxonomy") {
      return routeMethod(request, ["GET"], () => taxonomyV2Route(request, env, "/api/v2/taxonomy"));
    }
    const [, id, action] = appV2!;
    if (action === "v2-selection") {
      return routeMethod(request, ["GET"], () => taxonomyV2Route(request, env, `/api/v2/links/${id}/selection`));
    }
    return routeMethod(request, ["POST"], async () => {
      const body = await readJSONObject(request.clone(), 64 << 10);
      if (!body || !Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 0) {
        return error("invalid_expected_revision", 400);
      }
      return domainRoute(request, env, `/api/v2/links/${id}/overrides`);
    });
  }

  // Internal v2 domain API (evidence, specs, runs, decisions, overrides).
  // Management-only and behind the enricher token; the App token cannot reach it.
  if (path.startsWith("/api/v2/")) {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    const tags = await tagSystemRoute(request, env, path);
    if (tags) return tags;
    if (path.startsWith("/api/v2/taxonomy") || /^\/api\/v2\/links\/\d+\/selection/.test(path)) {
      return taxonomyV2Route(request, env, path);
    }
    return domainRoute(request, env, path, timing);
  }

  if (path === "/api/enrichment/jobs/claim") {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["POST"], () => claimEnrichmentJob(request, env, timing));
  }

  if (path.startsWith("/api/enrichment/provider-checks/")) {
    const authResult = requireEnricherToken(request, env);
    if (authResult !== null) return authResult;
    return providerCheckRoute(request, env, path);
  }

  if (path.startsWith("/api/enrichment/provider-attempts")) {
    const operatorOnly = path === "/api/enrichment/provider-attempts/reconcile" ||
      path === "/api/enrichment/provider-attempts/inspect" ||
      path === "/api/enrichment/provider-attempts/recover-source" ||
      path === "/api/enrichment/provider-attempts/recover-reading";
    if (operatorOnly && (!env.CAIRN_OPERATOR_TOKEN?.trim() ||
        env.CAIRN_OPERATOR_TOKEN.trim() === env.CAIRN_ENRICHER_TOKEN?.trim() ||
        env.CAIRN_OPERATOR_TOKEN.trim() === env.CAIRN_API_TOKEN?.trim())) {
      return authError("auth_not_configured", 500);
    }
    const authResult = operatorOnly
      ? requireBearerToken(request, env.CAIRN_OPERATOR_TOKEN!) : requireEnricherToken(request, env);
    if (authResult !== null) return authResult;
    return await providerAttemptRoute(request, env, path, (event) => timing.setRecoveryEvent(event),
      (event) => timing.addBusinessEvent(event)) ??
      error("not_found", 404);
  }

  if (path === "/api/enrichment/source-lease-capability") {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET"], () => json({ protocol: 1,
      lease_ms: ENRICHMENT_LEASE_MILLISECONDS, paid_stage_admission: true,
      provider_result_guard: true, completion_replay: true, provider_attempt_ledger: true,
      refresh_source_checkpoint: true, source_component_gate: true,
      source_stage_pause: true }));
  }

  if (path === "/api/enrichment/source-claimable") {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET"], () => sourceClaimable(request, env, timing));
  }

  if (path === "/api/enrichment/jobs") {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET"], () => listEnrichmentJobs(url, env, timing,
      request.headers.get("X-Cairn-Tag-System") === "1", contentFunctionsAware(request), request.headers.get("X-Cairn-Search-Summary") === "1"));
  }

  if (path === "/api/enrichment/overview") {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET"], () => getEnrichmentOverview(request, url, env, timing));
  }

  if (path === "/api/enrichment/backstage") {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET"], () => getEnrichmentBackstage(request, url, env, timing));
  }

  if (path === "/api/enrichment/taxonomy") {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET"], () => json(taxonomy));
  }

  const curationMatch = path.match(/^\/api\/enrichment\/jobs\/(\d+)\/curation$/);
  if (curationMatch !== null) {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["PATCH"], () => updateCuration(request, env, Number(curationMatch[1]), timing));
  }

  const enrichmentImageMatch = path.match(/^\/api\/enrichment\/images\/(.+)$/);
  if (enrichmentImageMatch !== null) {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    const key = decodePathComponent(enrichmentImageMatch[1]);
    if (key === null) return error("not_found", 404);
    return routeMethod(request, ["GET"], () => getEnrichmentImage(request, env, key));
  }

  const enrichmentJobMatch = path.match(/^\/api\/enrichment\/jobs\/(\d+)\/(claim|complete|fail|images|lease-admit|budget-defer|local-defer)$/);
  if (enrichmentJobMatch !== null) {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["POST"], () => {
      const id = Number(enrichmentJobMatch[1]);
      if (enrichmentJobMatch[2] === "claim") {
        return claimEnrichmentJobById(request, env, id, timing);
      }
      if (enrichmentJobMatch[2] === "images") {
        return storeEnrichmentImages(request, env, id, timing);
      }
      if (enrichmentJobMatch[2] === "lease-admit") {
        return admitPaidSourceStage(request, env, id, timing);
      }
      if (enrichmentJobMatch[2] === "budget-defer") {
        return deferSourceBudget(request, env, id, timing);
      }
      if (enrichmentJobMatch[2] === "local-defer") {
        return deferLocalSourceStage(request, env, id, timing);
      }
      return enrichmentJobMatch[2] === "complete"
        ? observeEnrichmentCommit(timing, "complete", (onResolved) =>
          completeEnrichmentJob(request, env, id, timing, onResolved))
        : failEnrichmentJob(request, env, id, timing);
    });
  }

  const enrichmentJobDetailMatch = path.match(/^\/api\/enrichment\/jobs\/(\d+)$/);
  if (enrichmentJobDetailMatch !== null) {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET"], () =>
      getEnrichmentJob(env, Number(enrichmentJobDetailMatch[1]), timing,
        url.searchParams.get("include_cache_identity") === "1", request.headers.get("X-Cairn-Tag-System") === "1", contentFunctionsAware(request))
    );
  }

  const enrichmentIdentityMatch = path.match(/^\/api\/enrichment\/jobs\/(\d+)\/cache-identity$/);
  if (enrichmentIdentityMatch !== null) {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET"], () =>
      getEnrichmentJobIdentity(env, Number(enrichmentIdentityMatch[1]), timing));
  }

  const enrichmentReadingMatch = path.match(/^\/api\/enrichment\/jobs\/(\d+)\/reading$/);
  if (enrichmentReadingMatch !== null) {
    const authError = requireEnricherToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET"], () =>
      getEnrichmentReading(env, Number(enrichmentReadingMatch[1]), timing, url.searchParams,
        request.headers.get("X-Cairn-Tag-System") === "1", contentFunctionsAware(request)));
  }

  const linkIdMatch = path.match(/^\/api\/links\/(\d+)$/);
  if (linkIdMatch !== null) {
    const authError = requireApiToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET", "PATCH", "DELETE"], () => {
      const id = Number(linkIdMatch[1]);
      if (request.method === "PATCH") return updateLink(request, env, id, timing);
      if (request.method === "DELETE") return deleteLink(env, id, timing);
      return getLink(request, url, id, env, timing);
    });
  }

  return json({ error: "not_found" }, 404);
}

async function createLink(request: Request, env: Env, timing: TimingCollector): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().split(";")[0].trim() !== "application/json") {
    return error("invalid_content_type");
  }

  const raw = await readJson(request);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return error("invalid_json");
  }

  const body = raw as Record<string, unknown>;
  const validation = validateLinkBodyForCreate(body);
  if (typeof validation === "string") {
    return error(validation);
  }

  const createdAt = new Date().toISOString();
  const row = await timing.measure("db", () =>
    env.DB.prepare(
      `INSERT INTO links (url, note, created_at, client_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(client_id) DO UPDATE SET client_id = excluded.client_id
        RETURNING id, url, note, created_at, learned, learned_at`
    )
      .bind(validation.url, validation.note, createdAt, validation.clientId)
      .first<LinkRow>()
  );

  if (row === null) {
    return json({ error: "not_found" }, 500);
  }

  await bumpLinksCacheGeneration(env, timing);
  return json(mapLink(row), 201);
}

async function listLinks(request: Request, url: URL, env: Env, timing: TimingCollector): Promise<Response> {
  const limit = parseBoundedInt(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  if (limit === null) return error("invalid_limit");

  const beforeId = parseOptionalPositiveInt(url.searchParams.get("before_id"));
  if (beforeId === null) return error("invalid_before_id");

  const learned = parseLearnedFilter(url.searchParams.get("learned"));
  if (learned === null) return error("invalid_learned");

  const query = parseSearchQuery(url.searchParams.get("q"));
  if (query === null) return error("invalid_query");

  const enriched = includeEnrichment(url);
  const excerpt = searchExcerptColumns(request.headers.get("X-Cairn-Search-Summary") === "1", query);
  const filters = bookmarkFilters(url, enriched ? query : undefined);
  if (filters instanceof Response) return filters;

  return cachedJson(request, env, timing, (generation) => listCacheUrl(url, { limit, beforeId, learned, query }, generation), async () => {
    const pageSize = limit + 1;
    const select = `SELECT ${LINK_COLUMNS}${enriched ? `, ${ENRICHMENT_COLUMNS}, ${contentColumns(true)}${cacheIdentityColumns(includeCacheIdentity(url))}` : ""}${excerpt.sql}`;
    const tagAware = request.headers.get("X-Cairn-Tag-System") === "1";
    const tagColumns = tagAware ? "," + tagSummaryColumns() : "";
    const order = url.searchParams.has("collection_id") ? `ORDER BY (SELECT position FROM collection_items WHERE collection_id=\'${url.searchParams.get("collection_id")}\' AND link_id=links.id),id LIMIT ?` : "ORDER BY id DESC LIMIT ?";
    const clauses = [...filters.clauses];
    const bindings = [...filters.bindings];

    if (learned !== undefined) {
      clauses.push("learned = ?");
      bindings.push(learned ? 1 : 0);
    }
    if (beforeId !== undefined) {
      if (url.searchParams.has("collection_id")) {
        clauses.push("(SELECT position FROM collection_items WHERE collection_id=? AND link_id=links.id)>(SELECT position FROM collection_items WHERE collection_id=? AND link_id=?)");
        bindings.push(url.searchParams.get("collection_id")!,url.searchParams.get("collection_id")!,beforeId);
      } else { clauses.push("id < ?"); bindings.push(beforeId); }
    }
    if (query !== undefined && !enriched) {
      clauses.push("(url LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(query)}%`;
      bindings.push(like, like);
    }

    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const statement = env.DB.prepare(`${select}${tagColumns} FROM links${where} ${order}`).bind(...excerpt.bindings, ...bindings, pageSize);

    const result = await timing.measure("db", () => statement.all<LinkRow & EnrichmentListRow>());
    const rows = result.results ?? [];
    const items = rows.slice(0, limit);
    const next = rows.length > limit ? items[items.length - 1]?.id ?? null : null;
    const mapped = items.map((row) => ({ ...(enriched ? mapAppLink(row, false, includeCacheIdentity(url)) : mapLink(row)),
      ...(excerpt.sql ? { search_excerpt: row.search_excerpt ?? "" } : {}) }));
    return { items: tagAware ? projectTagSummaryRows(mapped as unknown as Record<string, unknown>[],
      items as unknown as Array<TagSummaryRow & { id: number }>, false, contentFunctionsAware(request)) : mapped, next_before_id: next,
      ...(url.searchParams.get("filter_contract_version") === "1" ? { filter_contract_version: 1 } : {}) };
  });
}

async function learningQueue(request: Request, url: URL, env: Env, timing: TimingCollector): Promise<Response> {
  if (request.headers.get("X-Cairn-Queue") !== "1") return error("capability_mismatch", 409);
  for (const key of url.searchParams.keys()) {
    if (!["limit", "cursor", "include", "include_cache_identity"].includes(key) || url.searchParams.getAll(key).length !== 1) return error("invalid_query");
  }
  if (url.searchParams.has("include") && !includeEnrichment(url)) return error("invalid_query");
  const limit = parseBoundedInt(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  if (limit === null) return error("invalid_limit");
  const rawCursor = url.searchParams.get("cursor"), cursor = decodeCursor(rawCursor);
  if (rawCursor !== null && (!cursor || Object.keys(cursor).length !== 2 || typeof cursor.created_at !== "string" ||
    cursor.created_at.length > 40 || !Number.isFinite(Date.parse(cursor.created_at)) || !Number.isSafeInteger(cursor.id) || Number(cursor.id) < 1)) return error("invalid_cursor");
  const enriched = includeEnrichment(url), tagAware = request.headers.get("X-Cairn-Tag-System") === "1";
  const base = "learned=0 AND curation_status<>'drop'";
  const page = `${base}${cursor ? " AND (created_at>? OR (created_at=? AND id>?))" : ""}`;
  const rowsStatement = env.DB.prepare(`SELECT ${LINK_COLUMNS}${enriched ? `,${ENRICHMENT_COLUMNS},${contentColumns(true)}${cacheIdentityColumns(includeCacheIdentity(url))}` : ""}
    ${tagAware ? "," + tagSummaryColumns() : ""} FROM links WHERE ${page} ORDER BY created_at ASC,id ASC LIMIT ?`)
    .bind(...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []), limit + 1);
  const [rowsResult, totalResult] = await timing.measure("db", () => env.DB.batch([rowsStatement,
    env.DB.prepare(`SELECT COUNT(*) AS total FROM links WHERE ${base}`)]));
  const rows = rowsResult.results as unknown as Array<LinkRow & EnrichmentListRow & TagSummaryRow>;
  const selected = rows.slice(0, limit), last = selected[selected.length - 1];
  const mapped = selected.map(row => enriched ? mapAppLink(row, false, includeCacheIdentity(url)) : mapLink(row));
  return json({ links: tagAware ? projectTagSummaryRows(mapped as unknown as Record<string, unknown>[], selected, false, contentFunctionsAware(request)) : mapped,
    next_cursor: rows.length > limit ? encodeCursor({ created_at: last.created_at, id: last.id }) : null,
    total: Number((totalResult.results[0] as { total: number } | undefined)?.total ?? 0) }, 200,
    { "X-Cairn-Queue": "1", "Cache-Control": "private, no-store" });
}

async function getLink(request: Request, url: URL, id: number, env: Env, timing: TimingCollector): Promise<Response> {
  const tagAware = request.headers.get("X-Cairn-Tag-System") === "1";
  return cachedJson(request, env, timing, (generation) => detailCacheUrl(id, url, generation), async () => {
    const row = await timing.measure("db", () =>
      env.DB.prepare(
        `SELECT ${LINK_COLUMNS}${includeEnrichment(url) ? `, ${ENRICHMENT_COLUMNS}, ${contentColumns(false)}${cacheIdentityColumns(includeCacheIdentity(url))}` : ""}
          ${tagAware ? "," + tagSummaryColumns() : ""} FROM links WHERE id = ?`
      )
        .bind(id)
        .first<LinkRow & EnrichmentListRow & TagSummaryRow>()
    );

    if (row === null) {
      return null;
    }
    const mapped = includeEnrichment(url) ? mapAppLink(row, true, includeCacheIdentity(url)) : mapLink(row);
    return tagAware ? projectTagSummaryRows([mapped as unknown as Record<string, unknown>], [row], false, contentFunctionsAware(request))[0] : mapped;
  });
}

async function updateLink(request: Request, env: Env, id: number, timing: TimingCollector): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().split(";")[0].trim() !== "application/json") {
    return error("invalid_content_type");
  }

  const raw = await readJson(request);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return error("invalid_json");
  }

  const body = raw as Record<string, unknown>;
  const updates: string[] = [];
  const bindings: Array<string | number | null> = [];
  // URL and note invalidate different things and must not be coupled:
  //  - a URL change means the stored snapshot belongs to a different page, so
  //    source/content is invalidated (human curation is preserved).
  //  - a note change is a personal annotation. It must not discard the fetched
  //    source, translation or images, and must not trigger a refetch.
  let urlChanged = false;
  let noteChanged = false;

  if ("url" in body) {
    if (typeof body.url !== "string") {
      return error("invalid_url");
    }
    const url = body.url.trim();
    if (!isValidHttpUrl(url)) {
      return error("invalid_url");
    }
    updates.push("url = ?");
    bindings.push(url);
    urlChanged = true;
  }

  if ("note" in body) {
    if (typeof body.note !== "string" || body.note.length > MAX_NOTE_LENGTH) {
      return error("invalid_note");
    }
    updates.push("note = ?");
    bindings.push(body.note);
    noteChanged = true;
  }

  if ("learned" in body) {
    if (typeof body.learned !== "boolean") {
      return error("invalid_learned");
    }
    updates.push("learned = ?", "learned_at = ?");
    bindings.push(body.learned ? 1 : 0, body.learned ? new Date().toISOString() : null);
  }

  if (updates.length === 0) {
    return error("invalid_update");
  }

  // A URL change invalidates the stored source and the derived reading content
  // because they describe a different page. Human curation, why and status are
  // deliberately preserved: they are the user's own decisions.
  if (urlChanged) {
    updates.push(
      "enrichment_status = 'pending'",
      "manual_priority = 0",
      "enrichment_attempts = 0",
      "enrichment_next_retry_at = NULL",
      "enrichment_lease_token = NULL",
      "enrichment_lease_until = NULL",
      "enrichment_paid_uncertain = 0",
      "enrichment_paid_stage = NULL",
      "ai_title = NULL",
      "original_language = NULL",
      "original_text = NULL",
      "translated_text = NULL",
      "summary = NULL",
      "related_links = NULL",
      "images = NULL",
      "enrichment_model = NULL",
      "enrichment_error = NULL",
      "enrichment_updated_at = NULL",
      "enriched_at = NULL",
      "classification = NULL"
    );
  }

  bindings.push(id);
  const requestUrl = new URL(request.url);
  const enriched = includeEnrichment(requestUrl);
  const row = await timing.measure("db", () =>
    env.DB.prepare(
      `UPDATE links
        SET ${updates.join(", ")}
        WHERE id = ?
        RETURNING ${LINK_COLUMNS}${enriched ? `, ${ENRICHMENT_COLUMNS}, ${contentColumns(false)}${cacheIdentityColumns(includeCacheIdentity(requestUrl))}` : ""}`
    )
      .bind(...bindings)
      .first<LinkRow & EnrichmentListRow>()
  );

  if (row === null) {
    return error("not_found", 404);
  }
  await bumpLinksCacheGeneration(env, timing);
  if (includeCacheIdentity(requestUrl)) {
    // SQLite RETURNING precedes AFTER triggers. Read body and identity together
    // after their revisions have advanced, never attach pre-trigger revisions.
    const current = await timing.measure("db", () => env.DB.prepare(
      `SELECT ${LINK_COLUMNS}, ${ENRICHMENT_COLUMNS}, ${contentColumns(false)}${cacheIdentityColumns(true)} FROM links WHERE id=?`
    ).bind(id).first<LinkRow & EnrichmentListRow>());
    if (!current) return error("not_found", 404);
    const mapped = mapAppLink(current, true, true);
    return json(request.headers.get("X-Cairn-Tag-System") === "1"
      ? (await attachTagSummaries(env, [mapped as unknown as Record<string, unknown>], false, contentFunctionsAware(request)))[0] : mapped);
  }
  const mapped = enriched ? mapAppLink(row, true) : mapLink(row);
  return json(request.headers.get("X-Cairn-Tag-System") === "1"
    ? (await attachTagSummaries(env, [mapped as unknown as Record<string, unknown>], false, contentFunctionsAware(request)))[0] : mapped);
}

async function deleteLink(env: Env, id: number, timing: TimingCollector): Promise<Response> {
  const row = await timing.measure("db", () =>
    env.DB.prepare("DELETE FROM links WHERE id = ? RETURNING id")
      .bind(id)
      .first<{ id: number }>()
  );

  if (row === null && !await env.DB.prepare("SELECT link_id FROM privacy_deletions WHERE link_id=?").bind(id).first()) {
    return error("not_found", 404);
  }
  // The trigger removes budgets, invalidates cached reads and records the outbox
  // in the same transaction as deletion. A lost response can safely be retried.
  if (!await cleanupDeletedImages(env, id)) return json({ error: "deletion_cleanup_pending" }, 503, { "Retry-After": "300" });
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function bookmarkFilters(url: URL, query?: string): { clauses: string[]; bindings: Array<string | number> } | Response {
  const clauses: string[] = [];
  const bindings: Array<string | number> = [];
  const collection = url.searchParams.get("collection_id");
  if (collection !== null) {
    if (!collectionID(collection) || url.searchParams.getAll("collection_id").length !== 1) return error("invalid_query");
    clauses.push("links.id IN(SELECT i.link_id FROM collection_items i JOIN collections c ON c.id=i.collection_id WHERE c.id=? AND c.deleted=0)");
    bindings.push(collection);
  }
  const curationStatus = url.searchParams.get("curation_status");
  if (curationStatus && curationStatus !== "all") {
    if (!validCurationStatus(curationStatus)) return error("invalid_query");
    clauses.push("curation_status = ?");
    bindings.push(curationStatus);
  }
  const selection = selectionFilters(url.searchParams);
  if (!selection) return error("invalid_query");
  clauses.push(...selection.clauses);
  bindings.push(...selection.bindings);
  const wechatSQL = "(lower(url) LIKE 'https://mp.weixin.qq.com/%' OR lower(url) LIKE 'http://mp.weixin.qq.com/%')";
  const source = url.searchParams.get("source");
  if (source) {
    if (!["x", "wechat", "other"].includes(source)) return error("invalid_query");
    clauses.push(source === "x" ? X_LINK_SQL : source === "wechat" ? wechatSQL : `(NOT ${X_LINK_SQL} AND NOT ${wechatSQL})`);
  }
  const uncertain = url.searchParams.get("uncertain");
  if (uncertain) {
    if (uncertain !== "true") return error("invalid_query");
    clauses.push("curation IS NULL AND COALESCE(json_extract(classification, '$.uncertainty'), 1) = 1");
  }
  const since = url.searchParams.get("since");
  if (since) {
    const date = new Date(since);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(since) || !Number.isFinite(date.getTime())) return error("invalid_query");
    clauses.push("created_at >= ?");
    bindings.push(date.toISOString());
  }
  if (query !== undefined) {
    const terms = query.split(/\s+/);
    if (terms.length > 10) return error("invalid_query");
    const candidate = indexedSearchCandidate(terms);
    if (candidate) { clauses.push(candidate.clause); bindings.push(candidate.binding); }
    for (const term of terms) {
      const like = `%${escapeLike(term)}%`;
      const fields = ["url", "note", "ai_title", "summary", "translated_text", "original_text", "why",
        "json_extract(classification, '$.why_suggestion')",
        // Retain legacy full-text metadata until an independent entity run or
        // correction exists. Thereafter only current, corrected entities match.
        `(CASE WHEN NOT EXISTS (SELECT 1 FROM entity_states WHERE link_id=links.id)
          AND NOT EXISTS (SELECT 1 FROM curation_overrides WHERE link_id=links.id AND field IN ('entity','entities'))
          THEN json_extract(classification, '$.entities')
          ELSE (SELECT group_concat(term, ' ') FROM effective_entity_memberships WHERE link_id=links.id) END)`];
      clauses.push(`(${fields.map((field) => `COALESCE(${field}, '') LIKE ? ESCAPE '\\'`).join(" OR ")})`);
      bindings.push(...fields.map(() => like));
    }
  }

  return { clauses, bindings };
}

async function listEnrichmentJobs(url: URL, env: Env, timing: TimingCollector, tagAware = false, includeContentFunctions = false, searchSummary = false): Promise<Response> {
  const countsOption = url.searchParams.getAll("counts");
  if (countsOption.length > 1 || (countsOption.length === 1 && !["0", "1"].includes(countsOption[0]))) {
    return error("invalid_query");
  }
  const includeCounts = countsOption[0] !== "0";
  const limit = parseBoundedInt(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  if (limit === null) return error("invalid_limit");
  const beforeId = parseOptionalPositiveInt(url.searchParams.get("before_id"));
  if (beforeId === null) return error("invalid_before_id");
  const status = parseEnrichmentStatus(url.searchParams.get("status"));
  if (status === null) return error("invalid_status");
  const query = parseSearchQuery(url.searchParams.get("q"));
  if (query === null) return error("invalid_query");
  const filters = bookmarkFilters(url, query);
  if (filters instanceof Response) return filters;
  // Counts are status facets for the filtered collection, independent of the
  // selected status tab and page cursor. Capture before adding those clauses.
  const countWhere = includeCounts && filters.clauses.length ? `WHERE ${filters.clauses.join(" AND ")}` : "";
  const countBindings = includeCounts ? [...filters.bindings] : [];
  const { clauses, bindings } = filters;
  if (beforeId !== undefined) {
    if (url.searchParams.has("collection_id")) {
      clauses.push("(SELECT position FROM collection_items WHERE collection_id=? AND link_id=links.id)>(SELECT position FROM collection_items WHERE collection_id=? AND link_id=?)");
      bindings.push(url.searchParams.get("collection_id")!,url.searchParams.get("collection_id")!,beforeId);
    } else { clauses.push("id < ?"); bindings.push(beforeId); }
  }
  if (status === "unsupported") {
    clauses.push(`NOT ${X_LINK_SQL}`);
  } else if (status !== undefined) {
    clauses.push(X_LINK_SQL);
    clauses.push("enrichment_status = ?");
    bindings.push(status);
  }
  const excerpt = searchExcerptColumns(searchSummary, query);
  const summary = url.searchParams.get("view") === "summary" || Boolean(excerpt.sql);
  const withIdentity = url.searchParams.get("include_cache_identity") === "1";

  const pageSize = limit + 1;
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const listStatement = env.DB.prepare(
    `SELECT id, url, note, created_at, ${ENRICHMENT_COLUMNS}, ${contentColumns(summary)} ${cacheIdentityColumns(withIdentity)}${excerpt.sql}
       ${tagAware ? "," + tagSummaryColumns() : ""}
       FROM links
      ${where}
      ORDER BY ${url.searchParams.has("collection_id") ? `(SELECT position FROM collection_items WHERE collection_id='${url.searchParams.get("collection_id")}' AND link_id=links.id),id` : "id DESC"}
      LIMIT ?`
  ).bind(...excerpt.bindings, ...bindings, pageSize);
  let rows: EnrichmentListRow[];
  let countRow: EnrichmentCountRow | null = null;
  if (includeCounts) {
    const countStatement = env.DB.prepare(
      `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN ${X_LINK_SQL} AND enrichment_status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN ${X_LINK_SQL} AND enrichment_status = 'processing' THEN 1 ELSE 0 END), 0) AS processing,
            COALESCE(SUM(CASE WHEN ${X_LINK_SQL} AND enrichment_status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
            COALESCE(SUM(CASE WHEN ${X_LINK_SQL} AND enrichment_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
            COALESCE(SUM(CASE WHEN ${X_LINK_SQL} AND enrichment_status = 'exhausted' THEN 1 ELSE 0 END), 0) AS exhausted,
            COALESCE(SUM(CASE WHEN NOT ${X_LINK_SQL} THEN 1 ELSE 0 END), 0) AS unsupported
       FROM links ${countWhere}`
    ).bind(...countBindings);
    // D1 batches are transactional. Do not attach counts read after a
    // concurrent mutation to a page that predates it.
    const [listResult, countResult] = await timing.measure("db", () => env.DB.batch([listStatement, countStatement]));
    rows = (listResult.results ?? []) as unknown as EnrichmentListRow[];
    countRow = (countResult.results?.[0] ?? null) as unknown as EnrichmentCountRow | null;
  } else {
    const listResult = await timing.measure("db", () => listStatement.all());
    rows = (listResult.results ?? []) as unknown as EnrichmentListRow[];
  }
  const items = rows.slice(0, limit);
  const next = rows.length > limit ? items[items.length - 1]?.id ?? null : null;
  const mapped = items.map((row) => ({ ...mapEnrichmentListItem(row, withIdentity), ...(summary ? { content_loaded: false } : {}),
    ...(excerpt.sql ? { search_excerpt: row.search_excerpt ?? "" } : {}) }));
  return json({
    items: tagAware ? projectTagSummaryRows(mapped, items as unknown as Array<TagSummaryRow & { id: number }>, true, includeContentFunctions) : mapped,
    next_before_id: next,
    ...(includeCounts ? { counts: mapEnrichmentCounts(countRow) } : {}),
    ...(url.searchParams.get("filter_contract_version") === "1" ? { filter_contract_version: 1 } : {})
  });
}

interface EnrichmentOverviewRow extends EnrichmentCountRow {
  view_inbox: number;
  view_kept: number;
  view_compiled: number;
  view_drop: number;
  view_uncertain: number;
}

async function getEnrichmentBackstage(request: Request, url: URL, env: Env, timing: TimingCollector): Promise<Response> {
  if (request.headers.get("X-Cairn-Backstage") !== "1") return error("capability_mismatch", 409);
  if (url.searchParams.size) return error("invalid_query");
  const tagAware = request.headers.get("X-Cairn-Tag-System") === "1";
  const rows = env.DB.prepare(`SELECT id,url,note,created_at,${ENRICHMENT_COLUMNS},${contentColumns(true)}
    ${tagAware ? "," + tagSummaryColumns() : ""} FROM links
    WHERE is_x=1 AND enrichment_status IN('failed','exhausted') ORDER BY id DESC LIMIT 100`);
  const aggregate = env.DB.prepare(`SELECT COUNT(*) AS total,
    ${["pending","processing","completed","failed","exhausted"].map(status => `COALESCE(SUM(is_x=1 AND enrichment_status='${status}'),0) AS ${status}`).join(",")},
    COALESCE(SUM(is_x=0),0) AS unsupported,
    ${["inbox","kept","compiled","drop"].map(status => `COALESCE(SUM(curation_status='${status}'),0) AS view_${status}`).join(",")},
    COALESCE(SUM(curation IS NULL AND COALESCE(json_extract(classification,'$.uncertainty'),1)=1),0) AS view_uncertain FROM links`);
  // Attention, totals and fixed views are from one transactional D1 round trip.
  const [attentionResult, aggregateResult] = await timing.measure("db", () => env.DB.batch([rows,aggregate]));
  const row = aggregateResult.results[0] as unknown as EnrichmentOverviewRow;
  const counts = mapEnrichmentCounts(row);
  const items = attentionResult.results as unknown as Array<EnrichmentListRow & TagSummaryRow>;
  const mapped = items.map(item => ({ ...mapEnrichmentListItem(item), content_loaded: false }));
  return json({ version: 1,
    attention: tagAware ? projectTagSummaryRows(mapped, items, true, contentFunctionsAware(request)) : mapped,
    attention_total: counts.failed + counts.exhausted, counts,
    overview: { version: 1, views: { all: counts.total, inbox: row.view_inbox, kept: row.view_kept,
      compiled: row.view_compiled, drop: row.view_drop, uncertain: row.view_uncertain }, counts,
      attention: counts.failed + counts.exhausted, queued: counts.pending + counts.processing }
  },200,{ "X-Cairn-Backstage": "1" });
}

async function getEnrichmentOverview(request: Request, url: URL, env: Env, timing: TimingCollector): Promise<Response> {
  if ([...url.searchParams.keys()].length > 0) return error("invalid_query");
  return cachedJson(request, env, timing, generation => enrichmentOverviewCacheUrl(url, generation), async () => {
    // Reuse the list's predicates, including the exact uncertain projection
    // rule. The fixed views keep all user-controlled text out of SQL source.
    const viewFilters = [
      ["inbox", "curation_status=inbox"], ["kept", "curation_status=kept"],
      ["compiled", "curation_status=compiled"], ["drop", "curation_status=drop"],
      ["uncertain", "uncertain=true"]
    ] as const;
    const bindings: Array<string | number> = [];
    const columns = viewFilters.map(([name, query]) => {
      const filter = bookmarkFilters(new URL(`https://cairn.invalid/api/enrichment/jobs?${query}`));
      if (filter instanceof Response) throw new Error("invalid fixed overview filter");
      bindings.push(...filter.bindings);
      return `COALESCE(SUM(CASE WHEN ${filter.clauses.join(" AND ") || "1"} THEN 1 ELSE 0 END),0) AS view_${name}`;
    });
    const statusColumns = ["pending", "processing", "completed", "failed", "exhausted"].map(status =>
      `COALESCE(SUM(CASE WHEN is_x=1 AND enrichment_status='${status}' THEN n ELSE 0 END),0) AS ${status}`);
    const statement = env.DB.prepare(`
      WITH view_counts AS (
        SELECT COUNT(*) AS total, ${columns.join(", ")}
        FROM links
      ), status_groups AS (
        SELECT is_x, enrichment_status, COUNT(*) AS n
        FROM links INDEXED BY links_is_x_status_idx
        GROUP BY is_x, enrichment_status
      ), status_counts AS (
        SELECT ${statusColumns.join(", ")},
          COALESCE(SUM(CASE WHEN is_x=0 THEN n ELSE 0 END),0) AS unsupported
        FROM status_groups
      )
      SELECT * FROM view_counts CROSS JOIN status_counts
    `).bind(...bindings);
    const result = await timing.measure("db", () => statement.all<EnrichmentOverviewRow>());
    const row = result.results[0];
    if (row === undefined) throw new Error("overview aggregate returned no row");
    timing.setD1Stats({ query: "overview_aggregate", sql_count: 1, rows_read: result.meta.rows_read,
      rows_written: result.meta.rows_written, scope: "aggregate_only" });
    const counts = mapEnrichmentCounts(row);
    return { version: 1, views: {
      all: counts.total, inbox: row.view_inbox, kept: row.view_kept,
      compiled: row.view_compiled, drop: row.view_drop, uncertain: row.view_uncertain
    }, counts, attention: counts.failed + counts.exhausted, queued: counts.pending + counts.processing };
  }, OVERVIEW_CACHE_TTL_SECONDS);
}

async function getEnrichmentJob(env: Env, id: number, timing: TimingCollector, withIdentity = false, tagAware = false, includeContentFunctions = false): Promise<Response> {
  const row = await timing.measure("db", () =>
    env.DB.prepare(
      `SELECT id, url, note, created_at, enrichment_status, enrichment_attempts,
              enrichment_next_retry_at, enrichment_paid_uncertain, enrichment_paid_stage,
              ai_title, original_language, original_text,
              translated_text, ${presentationColumns}, summary, related_links, images, enrichment_model,
              enrichment_error, enrichment_updated_at, enriched_at, classification, curation, why, curation_status,
              CASE WHEN ${X_LINK_SQL} THEN 1 ELSE 0 END AS processable${cacheIdentityColumns(withIdentity)}
              ${tagAware ? "," + tagSummaryColumns() : ""}
         FROM links
        WHERE id = ?`
    )
      .bind(id)
      .first<EnrichmentDetailRow & TagSummaryRow>()
  );
  if (row === null) return error("not_found", 404);
  const mapped = mapEnrichmentListItem(row, withIdentity);
  return json(tagAware ? projectTagSummaryRows([mapped], [row], true, includeContentFunctions)[0] : mapped);
}

async function getEnrichmentJobIdentity(env: Env, id: number, timing: TimingCollector): Promise<Response> {
  const row = await timing.measure("db", () => env.DB.prepare(`SELECT id,enrichment_status,
    enrichment_updated_at,enrichment_paid_uncertain${cacheIdentityColumns(true)}
    FROM links WHERE id=?`).bind(id).first<{
      id: number; enrichment_status: string; enrichment_updated_at: string | null;
      enrichment_paid_uncertain: number; content_revision: number; app_body_revision: number;
      personal_revision: number; cache_decision_id: number; cache_entity_revision: number;
    }>());
  if (!row) return error("not_found", 404);
  return json({ id: row.id, status: row.enrichment_status,
    updated_at: row.enrichment_updated_at, paid_call_unresolved: row.enrichment_paid_uncertain === 1,
    cache_identity: { schema_version: 1, content_revision: row.content_revision,
      body_revision: row.app_body_revision, personal_revision: row.personal_revision,
      latest_decision_id: row.cache_decision_id,
      latest_entity_revision: row.cache_entity_revision } });
}

// One SQLite statement supplies article text, the effective selection and
// entity state. A sequence of detail/selection/entity reads can combine
// different revisions when another client writes between requests.
async function getEnrichmentReading(env: Env, id: number, timing: TimingCollector, params: URLSearchParams,
  tagAware = false, includeContentFunctions = false): Promise<Response> {
  if (params.getAll("body_revision").length > 1) return error("invalid_query");
  const rawRevision = params.get("body_revision");
  if (rawRevision !== null && (!/^(0|[1-9][0-9]*)$/.test(rawRevision) ||
      !Number.isSafeInteger(Number(rawRevision)))) return error("invalid_query");
  const knownBodyRevision = rawRevision === null ? -1 : Number(rawRevision);
  const snapshot = await timing.measure("db", () => readSelectionSnapshot(env, id, true, knownBodyRevision, tagAware));
  if (!snapshot) return error("not_found", 404);
  const row = snapshot.link as unknown as EnrichmentDetailRow;
  const bodyUnchanged = knownBodyRevision >= 0 && row.app_body_revision === knownBodyRevision;
  const processable = /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(row.url) ? 1 : 0;
  const mapped = mapEnrichmentListItem({ ...row, processable,
    cache_decision_id: snapshot.decisionId,
    cache_entity_revision: snapshot.entity?.revision ?? 0 }, true);
  // The same SQL statement supplies body, effective tags, custom definitions
  // and their revisions. Never add an awaited tag read to this snapshot.
  const detail = tagAware ? projectTagSummaryRows([mapped],
    [snapshot.link as unknown as TagSummaryRow & { id: number }], true, includeContentFunctions)[0] : mapped;
  const selectionParams = new URLSearchParams({ include_automatic: "1", include_state: "1" });
  if (tagAware) selectionParams.set("tag_system", "1");
  const selection = selectionPayload(snapshot, id, selectionParams);
  const accepted = new Set<string>();
  for (const entry of snapshot.overrides) {
    if (entry.field !== "entities") continue;
    if (entry.action === "set_empty" || (entry.action === "reset" && entry.term === "")) accepted.clear();
    else if (entry.action === "accept") accepted.add(entry.term);
    else accepted.delete(entry.term);
  }
  const entity = snapshot.entity;
  const observations = snapshot.state.entities.observations;
  let archivedEntities: string[] = [];
  if (entity) {
    try {
      const stored: unknown = JSON.parse(entity.entities);
      if (Array.isArray(stored)) archivedEntities = stored.filter((value): value is string => typeof value === "string");
    } catch { /* Match the existing entity read's empty fallback for damaged history. */ }
  }
  const entities = {
    id, state: entity?.state ?? "not_run", state_content_revision: entity?.content_revision ?? 0,
    evidence_snapshot_id: entity?.evidence_snapshot_id ?? 0,
    content_hash: entity?.content_hash ?? "", stale: snapshot.entityStale,
    updated_at: entity?.updated_at ?? null,
    automatic: snapshot.automatic.entities,
    archived_entities: archivedEntities,
    observations,
    effective_observations: observations.filter((entry) => entry.effective),
    entities: snapshot.view.entities,
    human: snapshot.view.entities.filter((term) => accepted.has(term)),
    overrides: snapshot.overrides.filter((entry) => entry.field === "entities"),
    revision: snapshot.link.personal_revision
  };
  return json({ version: 1, body_unchanged: bodyUnchanged, detail,
    selection: { available: true, ...selection }, entities });
}

async function updateCuration(request: Request, env: Env, id: number, timing: TimingCollector, app = false): Promise<Response> {
  const body = await readEnrichmentBody(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => !["why", "curation_status", "classification", "expected_revision", "operation_key"].includes(key))) return error("invalid_curation");
  const guardedConfirm = "expected_revision" in body || "operation_key" in body;
  if (guardedConfirm && (!Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 0 ||
      typeof body.operation_key !== "string" || body.operation_key.length === 0 || body.operation_key.length > 200 ||
      !("classification" in body) || body.classification === null || "why" in body || "curation_status" in body)) {
    return error("invalid_curation");
  }
  const updates: string[] = [];
  const bindings: Array<string | number | null> = [];
  if ("why" in body) {
    if (typeof body.why !== "string" || Array.from(body.why).length > 200) return error("invalid_curation");
    updates.push("why = ?");
    bindings.push(body.why.trim());
  }
  if ("curation_status" in body) {
    if (!validCurationStatus(body.curation_status)) return error("invalid_curation");
    updates.push("curation_status = ?");
    bindings.push(body.curation_status);
  }
  if ("classification" in body) {
    const selection = validateSelection(body.classification);
    if (body.classification !== null && (selection === null || !record(body.classification) ||
      Object.keys(body.classification).some((key) => !["topics", "form", "use"].includes(key)))) return error("invalid_curation");
  }
  if (updates.length === 0 && !("classification" in body)) return error("invalid_curation");
  const exists = await timing.measure("db", () => env.DB.prepare(`SELECT id FROM links WHERE id = ?`).bind(id)
    .first<{ id: number }>());
  if (exists === null) return error("not_found", 404);
  if (updates.length > 0) {
    await timing.measure("db", () => env.DB.prepare(
      `UPDATE links SET ${updates.join(", ")} WHERE id = ?`
    ).bind(...bindings, id).run());
  }
  // The pre-v2 client writes only topics<=3 plus form/use. That write is
  // translated into the same field-level override log the v2 UI uses, so the
  // old endpoint and the new view derive from one effective result and the
  // hidden v2 dimensions are preserved (R2-03).
  if ("classification" in body) {
    const { view } = await computeEffective(env, id);
    const existing = {
      topics: view.topics, content_functions: view.content_functions, carriers: view.carriers,
      affordances: view.affordances, form: view.form, use: view.use
    };
    const selection = body.classification === null ? null : validateSelection(body.classification);
    const { selection: desired } = applyV1Write(existing, selection === null
      ? { topics: [], form: "", use: "" }
      : { topics: selection.topics, form: selection.form, use: selection.use });
    // Guarded confirmation has the revision and operation ID from a current
    // client. Old clients remain on the unguarded legacy path. A null value
    // restores only the v1-expressible dimensions (B05-T06/R2-03).
    const digest = guardedConfirm ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      canonicalJSON({ id, classification: selection, expected_revision: body.expected_revision }))) : null;
    const payloadHash = digest ? Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("") : "";
    const result = await persistSelectionOverrides(env, id, desired, {
      source: guardedConfirm ? "human" : "legacy_unknown",
      operationPrefix: guardedConfirm ? String(body.operation_key) : `v1-${id}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      expectedRevision: guardedConfirm ? Number(body.expected_revision) : undefined,
      confirmV1Selection: guardedConfirm,
      operation: guardedConfirm ? { key: String(body.operation_key), payloadHash } : undefined,
      rejectAutomaticExtras: true,
      resetFields: selection === null ? ["topics", "form", "use"] : undefined
    });
    if ("conflict" in result) return json({ error: "revision_conflict", revision: result.conflict }, 409);
    if ("operationConflict" in result) return error("operation_conflict", 409);
  }
  if (app) {
    const item = await timing.measure("db", () => env.DB.prepare(
      `SELECT ${LINK_COLUMNS}, ${ENRICHMENT_COLUMNS}, ${contentColumns(false)} FROM links WHERE id = ?`
    ).bind(id).first<LinkRow & EnrichmentListRow>());
    if (item === null) return error("not_found", 404);
    const mapped = mapAppLink(item, true);
    return json(request.headers.get("X-Cairn-Tag-System") === "1"
      ? (await attachTagSummaries(env, [mapped as unknown as Record<string, unknown>], false, contentFunctionsAware(request)))[0] : mapped);
  }
  return getEnrichmentJob(env, id, timing, false, request.headers.get("X-Cairn-Tag-System") === "1", contentFunctionsAware(request));
}

async function sourceClaimable(request: Request, env: Env, timing: TimingCollector): Promise<Response> {
  const row = await timing.measure("db", () => env.DB.prepare(SOURCE_CLAIM_CANDIDATE_SQL)
    .bind(...sourceClaimCandidateBindings(new Date(),
      request.headers.get("X-Cairn-Source-Component-Gate") === "1")).first<{ id: number }>());
  return json({ claimable: row !== null });
}

// Claim and acquire an expired component's single probe in one D1 transaction.
// The probe outlives the 15-minute source lease by one minute, so another
// process cannot begin a second probe while the first may still commit.
function sourceGateProbe(env: Env, leaseToken: string, now: Date): D1PreparedStatement {
  return env.DB.prepare(`UPDATE enrichment_component_gates SET state='probing',
    probe_token=?,probe_until=?,updated_at=? WHERE component=(
      SELECT ${SOURCE_NEXT_COMPONENT_SQL} FROM links WHERE enrichment_status='processing'
        AND enrichment_lease_token=?) AND state<>'closed'`)
    .bind(leaseToken, new Date(now.getTime() + ENRICHMENT_LEASE_MILLISECONDS + 60_000).toISOString(),
      now.toISOString(), leaseToken);
}

async function pausedSourceGate(env: Env, component?: "source" | "reading"): Promise<Response | null> {
  const nowIso = new Date().toISOString();
  const gate = await env.DB.prepare(`SELECT component,state,retry_at,probe_until
    FROM enrichment_component_gates WHERE component IN ('source','reading')
      AND (? IS NULL OR component=?)
      AND ((state='open' AND retry_at>?) OR (state='probing' AND probe_until>?))
    ORDER BY component LIMIT 1`).bind(component ?? null, component ?? null, nowIso, nowIso)
    .first<{ component: string; state: string; retry_at: string | null; probe_until: string | null }>();
  if (!gate) return null;
  const until = gate.state === "open" ? gate.retry_at : gate.probe_until;
  if (!until || Date.parse(until) <= Date.now()) return null;
  const delay = Date.parse(until) - Date.now();
  const response = json({ error: "component_paused", component: gate.component,
    retry_after_ms: delay }, 503);
  response.headers.set("Retry-After", String(Math.ceil(delay / 1000)));
  return response;
}

async function claimEnrichmentJob(request: Request, env: Env, timing: TimingCollector): Promise<Response> {
  if (request.headers.get("X-Cairn-Provider-Attempt-Ledger") !== "1") {
    return error("capability_mismatch", 409);
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseToken = crypto.randomUUID();
  const leaseUntil = new Date(now.getTime() + ENRICHMENT_LEASE_MILLISECONDS).toISOString();
  const gateAware = request.headers.get("X-Cairn-Source-Component-Gate") === "1";
  const stagePauseAware = gateAware && request.headers.get("X-Cairn-Source-Stage-Pause") === "1";
  const stageMask = request.headers.get("X-Cairn-Source-Stage-Mask") ?? "both";
  if ((!stagePauseAware && stageMask !== "both") ||
      (stageMask !== "both" && stageMask !== "source" && stageMask !== "reading")) {
    return error("invalid_enrichment", 400);
  }
  const guarded = request.headers.get("X-Cairn-Source-Lease-Admission") === "1";
  const results = await timing.measure("db", () =>
    env.DB.batch([env.DB.prepare(
      `UPDATE links
        SET enrichment_status = 'processing',
            enrichment_attempts = enrichment_attempts + CASE
              WHEN enrichment_status='processing' AND enrichment_paid_stage_started=0 THEN 0 ELSE 1 END,
            enrichment_paid_stage_started = ?,
            enrichment_paid_uncertain = ?,
            enrichment_paid_stage = ?,
            enrichment_next_retry_at = NULL,
            enrichment_lease_token = ?,
            enrichment_lease_until = ?,
            enrichment_error = NULL,
            enrichment_updated_at = ?
        WHERE id = (${sourceClaimSQL(stageMask)})
        RETURNING id, url, note, created_at, enrichment_attempts,
                  enrichment_lease_token, enrichment_lease_until, content_revision,
                  CASE WHEN refresh_requested_at IS NOT NULL THEN refresh_epoch ELSE 0 END AS refresh_epoch,
                  ${SOURCE_NEXT_COMPONENT_SQL} AS source_component`
    )
      .bind(guarded ? 0 : 1, guarded ? 0 : 1, guarded ? null : "legacy_unknown", leaseToken, leaseUntil, nowIso,
        ...sourceClaimCandidateBindings(now, gateAware, stageMask)), sourceGateProbe(env, leaseToken, now)])
  );
  const row = results[0].results[0] as EnrichmentJobRow | undefined;

  if (row === undefined) {
    return await pausedSourceGate(env) ?? new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (Number(results[1].meta.changes) === 1) {
    timing.addBusinessEvent({ kind: "component_gate", component: row.source_component, action: "probe_started" });
  }
  timing.addBusinessEvent({ kind: "source_claim", origin: "scheduled", outcome: "claimed", status: 200 });
  return json(mapEnrichmentJob(row, stagePauseAware));
}

async function claimEnrichmentJobById(
  request: Request,
  env: Env,
  id: number,
  timing: TimingCollector
): Promise<Response> {
  if (request.headers.get("X-Cairn-Provider-Attempt-Ledger") !== "1") {
    return error("capability_mismatch", 409);
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const budgetStart = nowIso.slice(0, 10) + "T00:00:00.000Z";
  const budgetEnd = new Date(Date.parse(budgetStart) + 86400000).toISOString();
  const leaseToken = crypto.randomUUID();
  const leaseUntil = new Date(now.getTime() + ENRICHMENT_LEASE_MILLISECONDS).toISOString();
  const gateAware = request.headers.get("X-Cairn-Source-Component-Gate") === "1";
  const guarded = request.headers.get("X-Cairn-Source-Lease-Admission") === "1";
  const results = await timing.measure("db", () =>
    env.DB.batch([env.DB.prepare(
      `UPDATE links
          SET enrichment_status = 'processing',
              enrichment_attempts = 1,
              enrichment_paid_stage_started = ?,
              enrichment_paid_uncertain = ?,
              enrichment_paid_stage = ?,
              enrichment_next_retry_at = NULL,
              enrichment_lease_token = ?,
              enrichment_lease_until = ?,
              enrichment_error = NULL,
              enrichment_updated_at = ?
        WHERE id = ?
          AND ${X_LINK_SQL}
          AND enrichment_paid_uncertain=0
          AND (COALESCE(enrichment_error,'') <> 'budget_exhausted'
            OR enrichment_next_retry_at IS NULL OR enrichment_next_retry_at<=?)
          AND COALESCE((SELECT total FROM enrichment_provider_daily_usage
            WHERE day=?),0) < ?
          AND (SELECT COUNT(*) FROM enrichment_provider_attempts a
            WHERE a.link_id=links.id AND a.created_at>=? AND a.created_at<?) < ?
          AND (
            enrichment_status <> 'processing'
            OR enrichment_lease_until IS NULL
            OR enrichment_lease_until <= ?
          )
          AND ${SOURCE_GATE_READY_SQL}
        RETURNING id, url, note, created_at, enrichment_attempts,
                  enrichment_lease_token, enrichment_lease_until, content_revision,
                  CASE WHEN refresh_requested_at IS NOT NULL THEN refresh_epoch ELSE 0 END AS refresh_epoch,
                  ${SOURCE_NEXT_COMPONENT_SQL} AS source_component`
    )
      .bind(guarded ? 0 : 1, guarded ? 0 : 1, guarded ? null : "legacy_unknown",
        leaseToken, leaseUntil, nowIso, id, nowIso,
        budgetStart.slice(0, 10), PROVIDER_ATTEMPT_LIMITS.daily_total,
        budgetStart, budgetEnd, PROVIDER_ATTEMPT_LIMITS.daily_item, nowIso,
        gateAware ? 1 : 0, nowIso, nowIso),
      sourceGateProbe(env, leaseToken, now)])
  );
  const row = results[0].results[0] as EnrichmentJobRow | undefined;
  if (row !== undefined) {
    if (Number(results[1].meta.changes) === 1) {
      timing.addBusinessEvent({ kind: "component_gate", component: row.source_component, action: "probe_started" });
    }
    timing.addBusinessEvent({ kind: "source_claim", origin: "by_id", outcome: "claimed", status: 200 });
    return json(mapEnrichmentJob(row, request.headers.get("X-Cairn-Source-Stage-Pause") === "1"));
  }

  const existing = await timing.measure("db-check", () =>
    env.DB.prepare(`SELECT id FROM links WHERE id = ? AND ${X_LINK_SQL}`)
      .bind(id)
      .first<{ id: number }>()
  );
  if (existing === null) return error("not_found", 404);
  const stage = await env.DB.prepare(`SELECT ${SOURCE_NEXT_COMPONENT_SQL} AS component
    FROM links WHERE id=?`).bind(id).first<{ component: "source" | "reading" }>();
  return await pausedSourceGate(env, stage?.component) ?? error("job_busy", 409);
}

// Admit one paid stage only while the caller still owns enough lease time for
// its request deadline and a bounded commit. A short lease is released in the
// same request. Only a lease that never admitted paid work refunds its claim
// attempt; otherwise a crashed or unknown provider call must remain counted.
async function admitPaidSourceStage(
  request: Request, env: Env, id: number, timing: TimingCollector
): Promise<Response> {
  if (request.headers.get("X-Cairn-Provider-Attempt-Ledger") !== "1") {
    return error("capability_mismatch", 409);
  }
  const body = await readEnrichmentBody(request);
  if (body instanceof Response) return body;
  const token = readBoundedString(body.lease_token, 1, 100);
  const minRemaining = body.min_remaining_ms;
  const stage = body.stage === undefined ? "legacy_unknown" : readBoundedString(body.stage, 1, 20);
  if (token === null || !Number.isSafeInteger(minRemaining) ||
      Number(minRemaining) < 1 || Number(minRemaining) > ENRICHMENT_LEASE_MILLISECONDS ||
      (stage !== "fetch" && stage !== "reading" && stage !== "legacy_unknown")) {
    return error("invalid_enrichment");
  }
  const now = new Date();
  const deadline = new Date(now.getTime() + Number(minRemaining)).toISOString();
  const component = stage === "fetch" ? "source" : stage;
  const admitted = await timing.measure("db", () => env.DB.prepare(`UPDATE links
    SET enrichment_paid_stage=?
    WHERE id=? AND enrichment_status='processing' AND enrichment_lease_token=?
      AND enrichment_lease_until>=? AND enrichment_paid_uncertain=0
      AND (enrichment_paid_stage IS NULL OR enrichment_paid_stage=?)
      AND ((?='legacy_unknown' AND NOT EXISTS(SELECT 1 FROM enrichment_component_gates g
          WHERE g.component IN ('source','reading') AND g.state<>'closed'))
        OR (?<>'legacy_unknown' AND EXISTS(SELECT 1 FROM enrichment_component_gates g
          WHERE g.component=? AND (g.state='closed' OR (g.state='probing'
            AND g.probe_token=? AND g.probe_until>?)))))
    RETURNING enrichment_lease_until`).bind(stage, id, token, deadline, stage,
      stage, stage, component, token, now.toISOString())
    .first<{ enrichment_lease_until: string }>());
  if (admitted) {
    return json({ id, status: "admitted",
      remaining_ms: Math.max(0, Date.parse(admitted.enrichment_lease_until) - Date.now()) });
  }
  const current = await timing.measure("db-check", () => env.DB.prepare(`SELECT id,enrichment_status,
    enrichment_lease_token,enrichment_lease_until,enrichment_paid_uncertain,enrichment_paid_stage FROM links WHERE id=?`).bind(id).first<{
    id: number; enrichment_status: string; enrichment_lease_token: string | null;
    enrichment_lease_until: string | null; enrichment_paid_uncertain: number;
    enrichment_paid_stage: string | null;
  }>());
  if (!current) return error("not_found", 404);
  if (current.enrichment_status !== "processing" || current.enrichment_lease_token !== token ||
      current.enrichment_lease_until === null) return error("lease_conflict", 409);
  if (stage !== "legacy_unknown" && current.enrichment_paid_uncertain === 0 &&
      current.enrichment_lease_until >= deadline &&
      (current.enrichment_paid_stage === null || current.enrichment_paid_stage === stage)) {
    const gate = await timing.measure("db-check", () => env.DB.prepare(`SELECT state,probe_token,probe_until,retry_at
      FROM enrichment_component_gates WHERE component=?`).bind(component)
      .first<{ state: string; probe_token: string | null; probe_until: string | null; retry_at: string | null }>());
    if (gate && gate.state !== "closed" &&
        !(gate.state === "probing" && gate.probe_token === token && gate.probe_until && gate.probe_until > now.toISOString())) {
      const released = await timing.measure("db", () => env.DB.prepare(`UPDATE links SET
        enrichment_status='pending',
        enrichment_attempts=CASE WHEN enrichment_paid_stage_started=0
          THEN MAX(0,enrichment_attempts-1) ELSE enrichment_attempts END,
        enrichment_paid_stage_started=0,enrichment_paid_stage=NULL,
        enrichment_lease_token=NULL,enrichment_lease_until=NULL,enrichment_updated_at=?
        WHERE id=? AND enrichment_status='processing' AND enrichment_lease_token=?
          AND enrichment_paid_uncertain=0 RETURNING id`)
        .bind(now.toISOString(), id, token).first<{ id: number }>());
      if (released) {
        const until = gate.state === "open" ? gate.retry_at : gate.probe_until;
        const delay = until ? Math.max(0, Date.parse(until) - Date.now()) : 0;
        const response = error("component_paused", 503);
        if (delay > 0) response.headers.set("Retry-After", String(Math.ceil(delay / 1000)));
        return response;
      }
    }
  }
  const released = await timing.measure("db", () => env.DB.prepare(`UPDATE links SET
    enrichment_status='pending',
    enrichment_attempts=CASE WHEN enrichment_paid_stage_started=0
      THEN MAX(0,enrichment_attempts-1) ELSE enrichment_attempts END,
    enrichment_paid_stage_started=0,
    enrichment_lease_token=NULL,enrichment_lease_until=NULL,
    enrichment_next_retry_at=NULL,enrichment_updated_at=?
    WHERE id=? AND enrichment_status='processing' AND enrichment_lease_token=?
      AND enrichment_lease_until=? AND enrichment_lease_until<?
    RETURNING id`).bind(now.toISOString(), id, token, current.enrichment_lease_until, deadline)
    .first<{ id: number }>());
  if (released) return error("lease_released", 409);
  return current.enrichment_paid_uncertain === 1
    ? error("provider_result_unknown", 409) : error("lease_conflict", 409);
}

// A budget denial before this stage obtained a permit is free. Release the
// lease, refund its queue attempt and wait until the next UTC budget window.
// A racing permit sets uncertain=1 in its INSERT trigger and fences this write.
async function deferSourceBudget(request: Request, env: Env, id: number, timing: TimingCollector): Promise<Response> {
  if (request.headers.get("X-Cairn-Provider-Attempt-Ledger") !== "1") {
    return error("capability_mismatch", 409);
  }
  const body = await readEnrichmentBody(request);
  if (body instanceof Response) return body;
  const token = readBoundedString(body.lease_token, 1, 100);
  const stage = body.stage;
  if (token === null || (stage !== "fetch" && stage !== "reading")) return error("invalid_enrichment");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const leaseHash = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = new Date();
  const nextWindow = new Date(Date.parse(now.toISOString().slice(0, 10) + "T00:00:00.000Z") + 86400000).toISOString();
  const updated = await timing.measure("db", () => env.DB.prepare(`UPDATE links SET
    enrichment_status='pending', enrichment_attempts=MAX(0,enrichment_attempts-1),
    enrichment_paid_stage_started=0,enrichment_paid_stage=NULL,
    enrichment_lease_token=NULL,enrichment_lease_until=NULL,
    enrichment_next_retry_at=?,enrichment_error='budget_exhausted',enrichment_updated_at=?
    WHERE id=? AND enrichment_status='processing' AND enrichment_lease_token=?
      AND enrichment_paid_stage=? AND enrichment_paid_uncertain=0
      AND NOT EXISTS (SELECT 1 FROM enrichment_provider_attempts a WHERE a.link_id=links.id
        AND a.lease_hash=? AND a.stage=?) RETURNING id`)
    .bind(nextWindow, now.toISOString(), id, token, stage, leaseHash, stage).first<{id:number}>());
  return updated ? json({ id, status: "deferred", retry_at: nextWindow }) : error("provider_result_unknown", 409);
}

// A per-process provider configuration pause cannot claim more of that stage.
// Return an unused lease to the shared queue so a healthy instance may take
// it. A prior paid stage keeps the job attempt; this stage must have no ledger
// reservation, including a reservation whose HTTP response was lost.
async function deferLocalSourceStage(request: Request, env: Env, id: number,
  timing: TimingCollector): Promise<Response> {
  if (request.headers.get("X-Cairn-Provider-Attempt-Ledger") !== "1") {
    return error("capability_mismatch", 409);
  }
  const body = await readEnrichmentBody(request);
  if (body instanceof Response) return body;
  const token = readBoundedString(body.lease_token, 1, 100);
  const stage = body.stage;
  if (token === null || (stage !== "fetch" && stage !== "reading")) return error("invalid_enrichment");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const leaseHash = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = new Date().toISOString();
  const component = stage === "fetch" ? "source" : "reading";
  const results = await timing.measure("db", () => env.DB.batch([
    env.DB.prepare(`UPDATE links SET enrichment_status='pending',
      enrichment_attempts=CASE WHEN enrichment_paid_stage_started=0
        THEN MAX(0,enrichment_attempts-1) ELSE enrichment_attempts END,
      enrichment_paid_stage_started=0,enrichment_paid_stage=NULL,
      enrichment_lease_token=NULL,enrichment_lease_until=NULL,
      enrichment_next_retry_at=NULL,enrichment_error=NULL,enrichment_updated_at=?
      WHERE id=? AND enrichment_status='processing' AND enrichment_lease_token=?
        AND enrichment_paid_uncertain=0
        AND (enrichment_paid_stage IS NULL OR enrichment_paid_stage=?)
        AND NOT EXISTS(SELECT 1 FROM enrichment_provider_attempts a
          WHERE a.link_id=links.id AND a.lease_hash=? AND a.stage=?) RETURNING id`)
      .bind(now, id, token, stage, leaseHash, stage),
    env.DB.prepare(`UPDATE enrichment_component_gates SET state='open',epoch=epoch+1,
      retry_at=?,probe_token=NULL,probe_until=NULL,updated_at=?
      WHERE component=? AND state='probing' AND probe_token=?
        AND EXISTS(SELECT 1 FROM links l WHERE l.id=? AND l.enrichment_status='pending'
          AND l.enrichment_lease_token IS NULL)
        AND NOT EXISTS(SELECT 1 FROM enrichment_provider_attempts a
          WHERE a.link_id=? AND a.lease_hash=? AND a.stage=?)`)
      .bind(now, now, component, token, id, id, leaseHash, stage)
  ]));
  const released = results[0].results.length > 0;
  timing.addBusinessEvent({ kind: "stage_lease", action: "local_defer", stage: component,
    outcome: released ? "deferred" : "refused", status: released ? 200 : 409 });
  return released ? json({ id, status: "deferred" }) : error("provider_result_unknown", 409);
}

async function completeEnrichmentJob(
  request: Request,
  env: Env,
  id: number,
  timing: TimingCollector,
  onResolved: (outcome: "stored" | "committed" | "replay" | "receipt_confirmed") => void
): Promise<Response> {
  const body = await readEnrichmentBody(request);
  if (body instanceof Response) return body;

  const leaseToken = readBoundedString(body.lease_token, 1, 100);
  // The source checkpoint may contain meaningful leading/trailing whitespace
  // (for example a code block). Validate it without rewriting those bytes.
  const originalText = typeof body.original_text === "string" &&
    body.original_text.trim().length > 0 && body.original_text.length <= MAX_ORIGINAL_TEXT_LENGTH &&
    new TextEncoder().encode(body.original_text).byteLength <= MAX_ORIGINAL_TEXT_LENGTH
    ? body.original_text : null;
  const aiTitle = readOptionalBoundedString(body.ai_title, 1, MAX_AI_TITLE_LENGTH);
  const originalLanguage = readOptionalBoundedString(body.original_language, 1, MAX_ORIGINAL_LANGUAGE_LENGTH);
  const translatedText = readOptionalBoundedString(body.translated_text, 1, MAX_TRANSLATED_TEXT_LENGTH);
  const summary = readBoundedString(body.summary, 1, MAX_SUMMARY_LENGTH);
  const model = readBoundedString(body.model, 1, MAX_MODEL_LENGTH);
  const relatedLinks = validateRelatedLinks(body.related_links);
  const images = body.images === undefined ? [] : validateStoredImages(body.images, id);
  const classification = body.classification === undefined ? undefined : validateClassification(body.classification);
  if (
    leaseToken === null || originalText === null || aiTitle === null || originalLanguage === null ||
    translatedText === null || summary === null || model === null || relatedLinks === null || images === null || classification === null
  ) {
    return error("invalid_enrichment");
  }

  const digest = async (value: string): Promise<string> => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const leaseHash = await digest(leaseToken);
  const payloadHash = await digest(JSON.stringify({ originalText, aiTitle, originalLanguage,
    translatedText, summary, model, relatedLinks, images, classification }));
  const readReceipt = () => env.DB.prepare(`SELECT link_id,payload_hash,response
    FROM enrichment_completion_receipts WHERE lease_hash=?`).bind(leaseHash)
    .first<{ link_id: number; payload_hash: string; response: string }>();
  const replay = async (): Promise<Response | null> => {
    const receipt = await timing.measure("receipt", readReceipt);
    if (!receipt) return null;
    if (receipt.link_id !== id || receipt.payload_hash !== payloadHash) return error("operation_conflict", 409);
    return json(JSON.parse(receipt.response));
  };
  const old = await replay();
  if (old) {
    if (old.status === 200) onResolved("replay");
    return old;
  }

  if (images.length > 0) {
    const storedImages = await timing.measure("r2-head", () =>
      Promise.all(images.map((image) => env.ENRICHMENT_IMAGES.head(image.key)))
    );
    if (storedImages.some((image) => image === null)) return error("invalid_enrichment");
  }

  const now = new Date().toISOString();
  const receiptBody = { id, status: "completed", enriched_at: now };
  const paidGuard = `AND (enrichment_paid_stage IS NULL OR
    (enrichment_paid_stage='reading' AND EXISTS
      (SELECT 1 FROM enrichment_provider_attempts a WHERE a.link_id=links.id
       AND a.lease_hash=? AND a.content_revision=links.content_revision
       AND a.stage='reading' AND a.state='responded' AND a.http_status=200)))`;
  // A reading completion may add aids but cannot replace fields from a saved
  // source. Keep this guard in the same D1 batch as the receipt and update so
  // a source change between validation and commit cannot create a false ack.
  const sourceGuard = `AND (NOT EXISTS (SELECT 1 FROM enrichment_sources s WHERE s.link_id=links.id)
    OR EXISTS (SELECT 1 FROM enrichment_sources s WHERE s.link_id=links.id
      AND s.url=links.url AND s.original_text=?
      AND json(json_extract(s.payload,'$.related_links'))=json(?)
      AND (json_extract(s.payload,'$.original_language')='' OR
        json_extract(s.payload,'$.original_language')=?)))`;
  const sourceBindings = [originalText, JSON.stringify(relatedLinks), originalLanguage ?? null];
  try {
    const results = await timing.measure("db", () => env.DB.batch([
      env.DB.prepare(`INSERT INTO enrichment_completion_receipts(lease_hash,link_id,payload_hash,response,created_at)
        SELECT ?,id,?,?,? FROM links WHERE id=? AND enrichment_status='processing'
          AND enrichment_lease_token=? ${paidGuard} ${sourceGuard}
        RETURNING lease_hash`)
        .bind(leaseHash, payloadHash, JSON.stringify(receiptBody), now, id, leaseToken, leaseHash,
          ...sourceBindings),
      env.DB.prepare(
      `UPDATE links
        SET enrichment_status = 'completed',
            manual_priority = 0,
            enrichment_next_retry_at = NULL,
            enrichment_lease_token = NULL,
            enrichment_lease_until = NULL,
            enrichment_paid_uncertain = 0,
            enrichment_paid_stage = NULL,
            ai_title = ?,
            original_language = ?,
            original_text = ?,
            translated_text = ?,
            summary = ?,
            related_links = ?,
            images = CASE WHEN EXISTS(SELECT 1 FROM enrichment_sources s WHERE s.link_id=links.id AND json_extract(s.payload,'$.model')='browser_capture') THEN images ELSE ? END,
            classification = COALESCE(?, classification),
            enrichment_model = ?,
            enrichment_error = NULL,
            enrichment_updated_at = ?,
            enriched_at = ?
        WHERE id = ?
          AND enrichment_status = 'processing'
          AND enrichment_lease_token = ?
          ${paidGuard}
          ${sourceGuard}
        RETURNING id`
    )
      .bind(
        aiTitle ?? null, originalLanguage ?? null, originalText, translatedText ?? null, summary,
        JSON.stringify(relatedLinks), JSON.stringify(images), classification ? JSON.stringify(classification) : null,
        model, now, now, id, leaseToken, leaseHash, ...sourceBindings
      ),
      env.DB.prepare(`UPDATE enrichment_component_gates SET state='closed',epoch=epoch+1,
        failures=0,retry_at=NULL,probe_token=NULL,probe_until=NULL,reason=NULL,updated_at=?
        WHERE component='reading' AND state='probing' AND probe_token=?
          AND EXISTS(SELECT 1 FROM enrichment_completion_receipts r JOIN links l ON l.id=r.link_id
            WHERE r.lease_hash=? AND l.id=? AND l.enrichment_status='completed')
          AND EXISTS(SELECT 1 FROM enrichment_provider_attempts a WHERE a.link_id=?
            AND a.lease_hash=? AND a.stage='reading' AND a.state='responded' AND a.http_status=200)`)
        .bind(now, leaseToken, leaseHash, id, id, leaseHash)
    ]));
    if (!results[0].results.length || !results[1].results.length) {
      const existing = await replay();
      if (existing?.status === 200) onResolved("replay");
      return existing ?? error("lease_conflict", 409);
    }
    if (Number(results[2].meta.changes) === 1) {
      timing.addBusinessEvent({ kind: "component_gate", component: "reading", action: "closed" });
    }
    onResolved("committed");
    return json(receiptBody);
  } catch (cause) {
    // A concurrent identical completion may win the UNIQUE lease-hash race.
    // D1 batch rolls back both writes on failure; a different failure remains
    // visible to the caller after the exact receipt check.
    const existing = await replay();
    if (existing) {
      if (existing.status === 200) onResolved("receipt_confirmed");
      return existing;
    }
    throw cause;
  }
}

async function failEnrichmentJob(
  request: Request,
  env: Env,
  id: number,
  timing: TimingCollector
): Promise<Response> {
  const body = await readEnrichmentBody(request);
  if (body instanceof Response) return body;

  const leaseToken = readBoundedString(body.lease_token, 1, 100);
  const failure = readBoundedString(body.error, 1, MAX_ENRICHMENT_ERROR_LENGTH);
  if (leaseToken === null || failure === null) return error("invalid_enrichment");
  const componentFault = body.component_fault;
  const retryAfterMS = body.retry_after_ms;
  if (componentFault !== undefined && componentFault !== "source_transient" &&
      componentFault !== "reading_transient") return error("invalid_enrichment");
  if (retryAfterMS !== undefined && (!Number.isSafeInteger(retryAfterMS) ||
      Number(retryAfterMS) < 0)) return error("invalid_enrichment");

  const current = await timing.measure("db", () =>
    env.DB.prepare(
      `SELECT enrichment_attempts
       FROM links
       WHERE id = ? AND enrichment_status = 'processing' AND enrichment_lease_token = ?`
    )
      .bind(id, leaseToken)
      .first<{ enrichment_attempts: number }>()
  );
  if (current === null) return error("lease_conflict", 409);

  // A transient observed before the provider reservation is evidence about
  // our own admission path, not about the provider. Release the unused lease
  // and stop this caller's round instead of opening a shared provider gate or
  // charging another bookmark's attempt on the next claim.
  const stage = componentFault === "source_transient" ? "fetch"
    : componentFault === "reading_transient" ? "reading" : null;
  const leaseBytes = stage ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(leaseToken)) : null;
  const leaseHash = leaseBytes
    ? [...new Uint8Array(leaseBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("") : null;
  if (stage) {
    const reserved = await timing.measure("db-check", () => env.DB.prepare(`SELECT 1
      FROM enrichment_provider_attempts WHERE link_id=? AND lease_hash=? AND stage=? LIMIT 1`)
      .bind(id, leaseHash, stage).first());
    if (!reserved) {
      const now = new Date().toISOString();
      const results = await timing.measure("db", () => env.DB.batch([
        env.DB.prepare(`UPDATE links SET enrichment_status='pending',
          enrichment_attempts=CASE WHEN enrichment_paid_stage_started=0
            THEN MAX(0,enrichment_attempts-1) ELSE enrichment_attempts END,
          enrichment_paid_stage_started=0,enrichment_paid_stage=NULL,
          enrichment_lease_token=NULL,enrichment_lease_until=NULL,
          enrichment_next_retry_at=NULL,enrichment_error=NULL,enrichment_updated_at=?
          WHERE id=? AND enrichment_status='processing' AND enrichment_lease_token=?
            AND enrichment_paid_uncertain=0
            AND NOT EXISTS(SELECT 1 FROM enrichment_provider_attempts a
              WHERE a.link_id=links.id AND a.lease_hash=? AND a.stage=?) RETURNING id`)
          .bind(now, id, leaseToken, leaseHash, stage),
        env.DB.prepare(`UPDATE enrichment_component_gates SET state='open',epoch=epoch+1,
          retry_at=?,probe_token=NULL,probe_until=NULL,updated_at=?
          WHERE component=? AND state='probing' AND probe_token=?
            AND EXISTS(SELECT 1 FROM links l WHERE l.id=? AND l.enrichment_status='pending'
              AND l.enrichment_lease_token IS NULL)
            AND NOT EXISTS(SELECT 1 FROM enrichment_provider_attempts a
              WHERE a.link_id=? AND a.lease_hash=? AND a.stage=?)`)
          .bind(now, now, stage === "fetch" ? "source" : "reading", leaseToken,
            id, id, leaseHash, stage)
      ]));
      const released = results[0].results.length > 0;
      timing.addBusinessEvent({ kind: "stage_lease", action: "fault_without_reservation",
        stage: stage === "fetch" ? "source" : "reading",
        outcome: released ? "deferred" : "refused", status: 409 });
      return released ? error("provider_attempt_missing", 409)
        : error("provider_result_unknown", 409);
    }
  }

  const now = new Date();
  const exhausted = current.enrichment_attempts >= MAX_ENRICHMENT_ATTEMPTS;
  const delayIndex = Math.max(0, Math.min(current.enrichment_attempts - 1, ENRICHMENT_RETRY_DELAYS_MILLISECONDS.length - 1));
  const nextRetryAt = exhausted
    ? null
    : new Date(now.getTime() + ENRICHMENT_RETRY_DELAYS_MILLISECONDS[delayIndex]).toISOString();
  const status = exhausted ? "exhausted" : "failed";
  const jobFailure = env.DB.prepare(
      `UPDATE links
        SET enrichment_status = ?,
            manual_priority = CASE WHEN ? = 'exhausted' THEN 0 ELSE manual_priority END,
            enrichment_next_retry_at = ?,
            enrichment_lease_token = CASE WHEN enrichment_paid_uncertain=1
              THEN enrichment_lease_token ELSE NULL END,
            enrichment_lease_until = CASE WHEN enrichment_paid_uncertain=1
              THEN enrichment_lease_until ELSE NULL END,
            enrichment_error = ?,
            enrichment_updated_at = ?
        WHERE id = ? AND enrichment_status = 'processing' AND enrichment_lease_token = ?
        RETURNING id`
    ).bind(status, status, nextRetryAt, failure, now.toISOString(), id, leaseToken);
  const ownedProbe = await timing.measure("db-check", () => env.DB.prepare(`SELECT component,epoch,failures
    FROM enrichment_component_gates WHERE component IN ('source','reading')
      AND state='probing' AND probe_token=? LIMIT 1`).bind(leaseToken)
    .first<{ component: "source" | "reading"; epoch: number; failures: number }>());
  const component = componentFault === "source_transient" ? "source"
    : componentFault === "reading_transient" ? "reading" : ownedProbe?.component;
  let row: { id: number } | null;
  if (component) {
    const gate = await timing.measure("db-check", () => env.DB.prepare(`SELECT epoch,failures,state,probe_token
      FROM enrichment_component_gates WHERE component=?`).bind(component)
      .first<{ epoch: number; failures: number; state: string; probe_token: string | null }>());
    const backoff = Math.min(600_000, 30_000 * 2 ** Math.min(gate?.failures ?? 0, 5));
    const hint = Math.min(Number(retryAfterMS ?? 0), 600_000);
    const retryAt = new Date(now.getTime() + Math.max(backoff, hint)).toISOString();
    const faultHash = leaseHash ?? [...new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(leaseToken)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const gateOpen = env.DB.prepare(`UPDATE enrichment_component_gates SET state='open',
      epoch=epoch+1,failures=MIN(failures+1,6),retry_at=?,probe_token=NULL,probe_until=NULL,
      reason=?,updated_at=? WHERE component=? AND epoch=?
      AND (state='closed' OR (state='probing' AND probe_token=?))
      AND EXISTS(SELECT 1 FROM links l WHERE l.id=? AND l.enrichment_status='processing'
        AND l.enrichment_lease_token=? AND l.enrichment_lease_until>?
        AND (?=1 OR l.enrichment_paid_stage=?))
      AND (?=1 OR EXISTS(SELECT 1 FROM enrichment_provider_attempts a
        WHERE a.link_id=? AND a.lease_hash=? AND a.stage=?))`)
      .bind(retryAt, componentFault ? "provider_transient" : "probe_failed", now.toISOString(),
        component, gate?.epoch ?? -1, leaseToken, id, leaseToken, now.toISOString(),
        ownedProbe?.component === component ? 1 : 0, component === "source" ? "fetch" : "reading",
        ownedProbe?.component === component ? 1 : 0, id, faultHash,
        component === "source" ? "fetch" : "reading");
    const results = await timing.measure("db", () => env.DB.batch([gateOpen, jobFailure]));
    if (Number(results[0].meta.changes) === 1) {
      timing.addBusinessEvent({ kind: "component_gate", component, action: "opened" });
    }
    row = results[1].results[0] as { id: number } | undefined ?? null;
  } else {
    row = await timing.measure("db", () => jobFailure.first<{ id: number }>());
  }

  if (row === null) return error("lease_conflict", 409);
  return json({ id: row.id, status, next_retry_at: nextRetryAt });
}

async function storeEnrichmentImages(
  request: Request,
  env: Env,
  id: number,
  timing: TimingCollector
): Promise<Response> {
  const body = await readEnrichmentBody(request);
  if (body instanceof Response) return body;

  const leaseToken = readBoundedString(body.lease_token, 1, 100);
  const imageUrls = validateImageUrls(body.image_urls);
  if (leaseToken === null || imageUrls === null) return error("invalid_images");

  const leased = await timing.measure("db-check", () =>
    env.DB.prepare(
      `SELECT id
         FROM links
        WHERE id = ? AND enrichment_status = 'processing' AND enrichment_lease_token = ?`
    )
      .bind(id, leaseToken)
      .first<{ id: number }>()
  );
  if (leased === null) return error("lease_conflict", 409);

  const images: EnrichmentImage[] = [];
  try {
    for (const imageUrl of imageUrls) {
      const image = await fetchAndStoreImage(env, id, imageUrl, timing);
      images.push(image);
      const current = await env.DB.prepare("SELECT id FROM links WHERE id=? AND enrichment_status='processing' AND enrichment_lease_token=?")
        .bind(id, leaseToken).first();
      if (!current) {
        // A delete during put is cleaned here; if this isolate dies, the durable
        // tombstone/scheduled scan catches the late object without trusting memory.
        await cleanupDeletedImages(env, id);
        return error("lease_conflict", 409);
      }
    }
  } catch {
    return error("image_fetch_failed", 502);
  }
  return json({ images });
}

async function fetchAndStoreImage(
  env: Env,
  id: number,
  imageUrl: string,
  timing: TimingCollector
): Promise<EnrichmentImage> {
  const response = await timing.measure("image-fetch", () =>
    fetch(imageUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000)
    })
  );
  if (!response.ok) throw new Error("image response was not successful");

  const contentType = normalizeImageContentType(response.headers.get("content-type"));
  if (contentType === null) throw new Error("unsupported image content type");

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_IMAGE_BYTES) {
      throw new Error("invalid image content length");
    }
  }

  const body = await readBodyWithinLimit(response, MAX_IMAGE_BYTES);
  if (body.byteLength === 0) throw new Error("empty image");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(imageUrl));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const extension = imageExtension(contentType);
  const key = `enrichment/${id}/${hash}.${extension}`;
  await timing.measure("r2-put", () =>
    env.ENRICHMENT_IMAGES.put(key, body, {
      httpMetadata: {
        contentType,
        cacheControl: "private, no-store"
      },
      customMetadata: { source_url: imageUrl }
    })
  );
  await env.DB.prepare("INSERT INTO library_sync_changes(link_id,kind) SELECT id,'upsert' FROM links WHERE id=?").bind(id).run();
  return { key, content_type: contentType };
}

async function readBodyWithinLimit(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) throw new Error("missing image body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error("image exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function getEnrichmentImage(request: Request, env: Env, key: string): Promise<Response> {
  if (!isValidImageKey(key)) return error("not_found", 404);

  const id = Number(key.split("/")[1]);
  const privacyAware = request.headers.get("X-Cairn-Image-Privacy") === "1";
  const visible = () => env.DB.prepare(`SELECT id FROM links WHERE id=?${privacyAware ? ` AND EXISTS(
    SELECT 1 FROM json_each(links.images) image WHERE json_extract(image.value,'$.key')=?)` : ""}`)
    .bind(...(privacyAware ? [id,key] : [id])).first();
  if (!Number.isSafeInteger(id) || !await visible()) return error("not_found", 404);
  const conditional = request.headers.get("if-none-match");
  const object = await env.ENRICHMENT_IMAGES.get(key, conditional ? { onlyIf: new Headers({ "If-None-Match": conditional }) } : undefined);
  // Recheck after storage I/O, including before conditional 304 responses.
  if (!await visible()) {
    if (object && "body" in object) await object.body.cancel();
    return error("not_found", 404);
  }
  if (object === null) return error("not_found", 404);

  const etag = object.httpEtag;
  if (request.headers.has("if-match") && request.headers.get("if-match") !== etag) {
    if ("body" in object) await object.body.cancel();
    return new Response(null, { status: 412, headers: { ETag: etag, "Cache-Control": "private, no-store", ...CORS_HEADERS } });
  }
  if (!("body" in object) || conditional === etag) {
    if ("body" in object) await object.body.cancel();
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "private, no-store", ...(privacyAware ? { "X-Cairn-Image-Privacy": "1" } : {}), ...CORS_HEADERS }
    });
  }

  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set("ETag", etag);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  if (privacyAware) headers.set("X-Cairn-Image-Privacy", "1");
  return new Response(object.body, { headers });
}

async function readEnrichmentBody(request: Request): Promise<Record<string, unknown> | Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().split(";")[0].trim() !== "application/json") {
    return error("invalid_content_type");
  }
  const raw = await readJson(request);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return error("invalid_json");
  }
  return raw as Record<string, unknown>;
}

function readBoundedString(value: unknown, minLength: number, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= minLength && trimmed.length <= maxLength ? trimmed : null;
}

function readOptionalBoundedString(value: unknown, minLength: number, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  return readBoundedString(value, minLength, maxLength);
}

function validateRelatedLinks(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_RELATED_LINKS) return null;
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const link = item.trim();
    if (!isValidHttpUrl(link)) return null;
    if (!seen.has(link)) {
      seen.add(link);
      unique.push(link);
    }
  }
  return unique;
}

function validateImageUrls(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_IMAGES) return null;
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const imageUrl = item.trim();
    if (!isAllowedImageUrl(imageUrl)) return null;
    if (!seen.has(imageUrl)) {
      seen.add(imageUrl);
      unique.push(imageUrl);
    }
  }
  return unique;
}

function isAllowedImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname.toLowerCase() === "pbs.twimg.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.startsWith("/media/");
  } catch {
    return false;
  }
}

function normalizeImageContentType(value: string | null): string | null {
  const contentType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const supported = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
  return supported.includes(contentType) ? contentType : null;
}

function imageExtension(contentType: string): string {
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif"
  };
  return extensions[contentType] ?? "bin";
}

function validateStoredImages(value: unknown, id: number): EnrichmentImage[] | null {
  if (!Array.isArray(value) || value.length > 24) return null;
  const images: EnrichmentImage[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.key !== "string" || typeof record.content_type !== "string") return null;
    if (!record.key.startsWith(`enrichment/${id}/`) || !isValidImageKey(record.key)) return null;
    const contentType = normalizeImageContentType(record.content_type);
    if (contentType === null) return null;
    if (!seen.has(record.key)) {
      seen.add(record.key);
      images.push({ key: record.key, content_type: contentType });
    }
  }
  return images;
}

function isValidImageKey(key: string): boolean {
  return /^enrichment\/[1-9]\d*\/[0-9a-f]{64}\.(?:jpg|png|webp|gif|avif)$/.test(key);
}

function decodePathComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function cachedJson(
  request: Request,
  env: Env,
  timing: TimingCollector,
  cacheUrlForGeneration: (generation: number) => string,
  producer: () => Promise<unknown | null>,
  ttlSeconds = READ_CACHE_TTL_SECONDS
): Promise<Response> {
  if (shouldBypassReadCache(request)) {
    timing.setCacheState("BYPASS");
    const body = await producer();
    if (body === null) return error("not_found", 404);
    return json(body, 200, { "X-Cairn-Cache": "BYPASS" });
  }

  const generation = await readLinksCacheGeneration(env, timing);
  const cacheUrl = cacheUrlForGeneration(generation);
  const cacheRequest = new Request(cacheUrl, { method: "GET" });
  const cached = await timing.measure("cache", () => caches.default.match(cacheRequest));
  if (cached !== undefined) {
    timing.setCacheState("HIT");
    return withCacheHeader(cached, "HIT", ttlSeconds);
  }

  timing.setCacheState("MISS");
  const body = await producer();
  if (body === null) return error("not_found", 404);

  const response = cacheableJson(body, "MISS", ttlSeconds);
  await timing.measure("cache-put", () => caches.default.put(cacheRequest, response.clone()));
  return response;
}

function shouldBypassReadCache(request: Request): boolean {
  if (request.headers.has("cookie")) {
    return true;
  }
  const cacheControl = request.headers.get("cache-control") ?? "";
  return /\bno-cache\b|\bno-store\b/i.test(cacheControl);
}

function requireApiToken(request: Request, env: Env): Response | null {
  return requireBearerToken(request, env.CAIRN_API_TOKEN);
}

function requireEnricherToken(request: Request, env: Env): Response | null {
  return requireBearerToken(request, env.CAIRN_ENRICHER_TOKEN);
}

function requireBearerToken(request: Request, configuredToken: string): Response | null {
  const expected = configuredToken?.trim();
  if (!expected) {
    return authError("auth_not_configured", 500);
  }

  const token = bearerToken(request.headers.get("authorization"));
  if (token === null) {
    return authError("missing_auth", 401);
  }
  if (!constantTimeEquals(token, expected)) {
    return authError("invalid_token", 401);
  }
  return null;
}

function bearerToken(authorization: string | null): string | null {
  if (authorization === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

function authError(code: "missing_auth" | "invalid_token" | "auth_not_configured", status: number): Response {
  const headers: HeadersInit = status === 401 ? { "WWW-Authenticate": "Bearer" } : {};
  return json({ error: code }, status, headers);
}

function constantTimeEquals(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;

  let diff = 0;
  for (let i = 0; i < leftBytes.length; i += 1) {
    diff |= leftBytes[i] ^ rightBytes[i];
  }
  return diff === 0;
}

function cacheableJson(body: unknown, cacheState: CacheState, ttlSeconds: number): Response {
  return json(body, 200, {
    "Cache-Control": cacheControlFor(ttlSeconds),
    "X-Cairn-Cache": cacheState
  });
}

function withCacheHeader(response: Response, cacheState: "HIT" | "BYPASS", ttlSeconds: number): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", cacheControlFor(ttlSeconds));
  headers.set("X-Cairn-Cache", cacheState);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function cacheControlFor(ttlSeconds: number): string {
  return `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`;
}

function withServerTiming(response: Response, timing: TimingCollector): Response {
  const headers = new Headers(response.headers);
  headers.set("Server-Timing", timing.headerValue());
  // Never expose internal generation-keyed cache headers for authenticated
  // private content to clients.
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function formatDuration(duration: number): string {
  return Math.max(0, duration).toFixed(1);
}

async function readLinksCacheGeneration(env: Env, timing: TimingCollector): Promise<number> {
  const row = await timing.measure("generation", () =>
    env.DB.prepare("SELECT value FROM cache_metadata WHERE key = ?")
      .bind(LINKS_CACHE_GENERATION_KEY)
      .first<{ value: number | string }>()
  );
  const value = Number(row?.value ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

async function bumpLinksCacheGeneration(env: Env, timing: TimingCollector): Promise<void> {
  await timing.measure("generation", () =>
    env.DB.prepare(
      `INSERT INTO cache_metadata (key, value, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = cache_metadata.value + 1,
          updated_at = excluded.updated_at`
    )
      .bind(LINKS_CACHE_GENERATION_KEY, new Date().toISOString())
      .run()
  );
}

function listCacheUrl(
  requestUrl: URL,
  parsed: {
    limit: number;
    beforeId: number | undefined;
    learned: boolean | undefined;
    query: string | undefined;
  },
  generation: number
): string {
  const url = new URL("/api/links", CACHE_ORIGIN);
  url.searchParams.set("v", CACHE_VERSION);
  url.searchParams.set("g", String(generation));
  url.searchParams.set("limit", String(parsed.limit));
  if (parsed.beforeId !== undefined) url.searchParams.set("before_id", String(parsed.beforeId));
  if (parsed.learned !== undefined) url.searchParams.set("learned", parsed.learned ? "true" : "false");
  if (parsed.query !== undefined) url.searchParams.set("q", parsed.query);
  for (const key of ["include", "include_cache_identity", "tag_system", "content_functions_view", "search_summary_view", "curation_status", "collection_id", ...SELECTION_FILTER_KEYS, "source", "uncertain", "since"]) {
    const value = requestUrl.searchParams.get(key);
    if (value) url.searchParams.set(key, value);
  }
  url.searchParams.set("host", requestUrl.host);
  return url.toString();
}

function enrichmentOverviewCacheUrl(requestUrl: URL, generation: number): string {
  const url = new URL("/api/enrichment/overview", CACHE_ORIGIN);
  url.searchParams.set("v", CACHE_VERSION);
  url.searchParams.set("g", String(generation));
  url.searchParams.set("host", requestUrl.host);
  return url.toString();
}

function detailCacheUrl(id: number, requestUrl: URL, generation: number): string {
  const url = new URL(`/api/links/${id}`, CACHE_ORIGIN);
  url.searchParams.set("v", CACHE_VERSION);
  url.searchParams.set("g", String(generation));
  if (includeEnrichment(requestUrl)) url.searchParams.set("include", "enrichment");
  if (requestUrl.searchParams.get("tag_system") === "1") url.searchParams.set("tag_system", "1");
  if (requestUrl.searchParams.get("content_functions_view") === "1") url.searchParams.set("content_functions_view", "1");
  if (includeCacheIdentity(requestUrl)) url.searchParams.set("include_cache_identity", "1");
  url.searchParams.set("host", requestUrl.host);
  return url.toString();
}

function routeMethod(
  request: Request,
  allowed: ReadonlyArray<"GET" | "POST" | "PATCH" | "DELETE">,
  handler: () => Promise<Response> | Response
): Promise<Response> | Response {
  if (allowed.includes(request.method as "GET" | "POST" | "PATCH" | "DELETE")) {
    return handler();
  }
  return json(
    { error: "method_not_allowed" },
    405,
    { Allow: [...allowed, "OPTIONS"].join(", ") }
  );
}

function parseSearchQuery(raw: string | null): string | undefined | null {
  if (raw === null || raw === "") return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value.length > MAX_QUERY_LENGTH) return null;
  return value;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function validateLinkBodyForCreate(
  body: Record<string, unknown>
): { url: string; note: string; clientId: string | null } | ErrorCode {
  if (typeof body.url !== "string") {
    return "invalid_url";
  }
  if (body.note !== undefined && typeof body.note !== "string") {
    return "invalid_note";
  }
  if (body.client_id !== undefined && (typeof body.client_id !== "string" || !CLIENT_ID_PATTERN.test(body.client_id))) {
    return "invalid_client_id";
  }

  const url = body.url.trim();
  const note = body.note === undefined ? "" : body.note;
  if (!isValidHttpUrl(url)) {
    return "invalid_url";
  }
  if (url.length > MAX_URL_LENGTH || note.length > MAX_NOTE_LENGTH) {
    return url.length > MAX_URL_LENGTH ? "invalid_url" : "invalid_note";
  }
  return { url, note, clientId: body.client_id === undefined ? null : body.client_id };
}

async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await readBoundedJSON(request, 1 << 20, false);
  } catch {
    return null;
  }
}

function isValidHttpUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  if (!/^https?:\/\/[^/?#]/i.test(value)) return false;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.hostname.length === 0) return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    return true;
  } catch {
    return false;
  }
}

function parseBoundedInt(raw: string | null, fallback: number, max: number): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) return null;
  return value;
}

function parseOptionalPositiveInt(raw: string | null): number | undefined | null {
  if (raw === null || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

function parseLearnedFilter(raw: string | null): boolean | undefined | null {
  if (raw === null || raw === "" || raw === "all") return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return null;
}

function parseEnrichmentStatus(raw: string | null): EnrichmentFilter | undefined | null {
  if (raw === null || raw === "" || raw === "all") return undefined;
  const statuses: ReadonlyArray<EnrichmentFilter> = [
    "pending",
    "processing",
    "completed",
    "failed",
    "exhausted",
    "unsupported"
  ];
  return statuses.includes(raw as EnrichmentFilter) ? raw as EnrichmentFilter : null;
}

function mapLink(row: LinkRow): LinkRecord {
  return {
    id: row.id,
    url: row.url,
    note: row.note,
    created_at: row.created_at,
    learned: row.learned === 1,
    learned_at: row.learned_at
  };
}

function mapAppLink(row: LinkRow & EnrichmentListRow, detail: boolean, withIdentity = false): LinkRecord & { enrichment: Record<string, unknown> } {
  return {
    ...mapLink(row),
    enrichment: {
      status: row.processable === 1 ? row.enrichment_status : "unsupported",
      source: bookmarkSource(row.url),
      ai_title: row.ai_title,
      summary: row.summary,
      original_language: row.original_language,
      classification: storedClassification(row.classification, row.curation),
      classification_reviewed: row.curation !== null,
      why: row.why,
      curation_status: row.curation_status,
      updated_at: row.enrichment_updated_at,
      enriched_at: row.enriched_at,
      content_loaded: detail,
      ...(withIdentity ? { cache_identity: {
        schema_version: 1, representation: detail ? "enrichment_detail" : "enrichment_summary",
        content_revision: row.content_revision, body_revision: row.app_body_revision, personal_revision: row.personal_revision,
        latest_decision_id: row.cache_decision_id, latest_entity_revision: row.cache_entity_revision
      } } : {}),
      ...(detail ? {
        original_text: row.original_text,
        translated_text: row.translated_text,
        formatted_content: row.formatted_content ?? null,
        formatting_status: row.formatting_status ?? null,
        related_links: parseStoredRelatedLinks(row.related_links),
        images: parseStoredImages(row.images, row.id)
      } : {})
    }
  };
}

function mapEnrichmentJob(row: EnrichmentJobRow, includeComponent = false): Record<string, unknown> {
  return {
    id: row.id,
    url: row.url,
    note: row.note,
    created_at: row.created_at,
    attempt: row.enrichment_attempts,
    lease_token: row.enrichment_lease_token,
    lease_until: row.enrichment_lease_until,
    content_revision: row.content_revision,
    // A non-zero epoch is an explicit, one-shot refresh intent the processor
    // must consume instead of reusing a stored source (R2-06).
    refresh_epoch: row.refresh_epoch ?? 0,
    ...(includeComponent ? { source_component: row.source_component } : {})
  };
}

function mapEnrichmentListItem(row: EnrichmentListRow, withIdentity = false): Record<string, unknown> {
  const processable = row.processable === 1;
  return {
    id: row.id,
    url: row.url,
    note: row.note,
    created_at: row.created_at,
    status: processable ? row.enrichment_status : "unsupported",
    processable,
    source: bookmarkSource(row.url),
    classification: storedClassification(row.classification, row.curation),
    classification_reviewed: row.curation !== null,
    why: row.why,
    curation_status: row.curation_status,
    attempts: row.enrichment_attempts,
    next_retry_at: row.enrichment_next_retry_at,
    ai_title: row.ai_title,
    original_language: row.original_language,
    original_text: row.original_text,
    translated_text: row.translated_text,
    ...(row.formatted_content !== undefined ? {formatted_content:row.formatted_content, formatting_status:row.formatting_status} : {}),
    summary: row.summary,
    related_links: parseStoredRelatedLinks(row.related_links),
    images: parseStoredImages(row.images, row.id),
    model: row.enrichment_model,
    error: row.enrichment_error,
    paid_call_unresolved: row.enrichment_paid_uncertain === 1,
    paid_stage: row.enrichment_paid_stage,
    updated_at: row.enrichment_updated_at,
    enriched_at: row.enriched_at,
    ...(withIdentity ? {cache_identity: {
      schema_version:1, content_revision:row.content_revision, body_revision:row.app_body_revision,
      personal_revision:row.personal_revision, latest_decision_id:row.cache_decision_id, latest_entity_revision:row.cache_entity_revision
    }} : {})
  };
}

function mapEnrichmentCounts(row: EnrichmentCountRow | null): EnrichmentCountRow {
  return {
    total: Number(row?.total ?? 0),
    pending: Number(row?.pending ?? 0),
    processing: Number(row?.processing ?? 0),
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
    exhausted: Number(row?.exhausted ?? 0),
    unsupported: Number(row?.unsupported ?? 0)
  };
}

function parseStoredRelatedLinks(raw: string | null): string[] {
  if (raw === null || raw === "") return [];
  try {
    return validateRelatedLinks(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

function parseStoredImages(raw: string | null, id: number): EnrichmentImage[] {
  if (raw === null || raw === "") return [];
  try {
    return validateStoredImages(JSON.parse(raw), id) ?? [];
  } catch {
    return [];
  }
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function error(code: ErrorCode, status = 400): Response {
  return json({ error: code }, status);
}

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...extraHeaders
    }
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: HTML_HEADERS
  });
}

function apiDebugHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cairn Share API 调试台</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f4ee;
      --card: #ffffff;
      --text: #1e1b16;
      --muted: #6f6559;
      --line: #e5ddd2;
      --primary: #6d4c21;
      --primary-contrast: #ffffff;
      --danger: #9b1c1c;
      --code: #15120f;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #15120f;
        --card: #211d18;
        --text: #f3ece2;
        --muted: #cfc2b3;
        --line: #3c342c;
        --primary: #e8bf79;
        --primary-contrast: #271805;
        --danger: #ffb4a8;
        --code: #090806;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top left, rgba(232, 191, 121, .22), transparent 34rem), var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
    }
    main {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 44px;
    }
    header {
      display: grid;
      gap: 12px;
      margin-bottom: 22px;
    }
    h1, h2, p { margin: 0; }
    h1 { font-size: clamp(30px, 5vw, 56px); letter-spacing: -.04em; line-height: 1.02; }
    h2 { font-size: 18px; }
    .lead { max-width: 760px; color: var(--muted); font-size: 17px; }
    .warning {
      border: 1px solid rgba(155, 28, 28, .35);
      background: rgba(155, 28, 28, .08);
      color: var(--danger);
      border-radius: 18px;
      padding: 14px 16px;
      font-weight: 650;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      align-items: start;
    }
    .card {
      background: color-mix(in oklab, var(--card), transparent 0%);
      border: 1px solid var(--line);
      border-radius: 24px;
      padding: 18px;
      box-shadow: 0 18px 42px rgba(55, 41, 23, .08);
    }
    .card.full { grid-column: 1 / -1; }
    .row { display: grid; gap: 10px; margin-top: 14px; }
    .inline {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 11px 12px;
      background: var(--card);
      color: var(--text);
      font: inherit;
    }
    input[type="checkbox"] { width: auto; }
    textarea { min-height: 92px; resize: vertical; }
    button {
      border: 0;
      border-radius: 999px;
      padding: 11px 16px;
      background: var(--primary);
      color: var(--primary-contrast);
      font: inherit;
      font-weight: 750;
      cursor: pointer;
    }
    button.secondary {
      background: transparent;
      color: var(--primary);
      border: 1px solid color-mix(in oklab, var(--primary), transparent 55%);
    }
    button.danger {
      background: var(--danger);
      color: #fff;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 14px;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    pre {
      min-height: 260px;
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--code);
      color: #f7f0e6;
      border-radius: 18px;
      padding: 16px;
      font-size: 13px;
    }
    .meta {
      color: var(--muted);
      font-size: 13px;
      margin-top: 10px;
    }
    a { color: var(--primary); }
    @media (max-width: 820px) {
      .grid, .inline { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="meta">Cairn Share · Cloudflare Worker + D1</p>
      <h1>API 调试台</h1>
      <p class="lead">这个页面直接调用当前域名下的 API。填写访问 Token 后，可以创建、查询、搜索、修改和删除链接，用来验证 Android App 背后的 Cloudflare 接口。</p>
      <div class="warning">链接 API 已启用 Bearer Token 保护。不要在非可信设备上保存 Token，也不要把 Token 放进 URL 查询参数。</div>
    </header>

    <section class="grid">
      <section class="card full">
        <h2>访问 Token</h2>
        <div class="row">
          <label>API Token
            <input id="api-token" type="password" autocomplete="off" placeholder="Authorization: Bearer ...">
          </label>
        </div>
        <div class="actions">
          <button type="button" id="save-token">保存到浏览器</button>
          <button type="button" class="secondary" id="clear-token">清除</button>
        </div>
        <p class="meta">Token 只保存在当前浏览器的 localStorage 中。/health 不需要 Token，其它 /api/links 请求都会自动带上 Authorization 头。</p>
      </section>

      <form class="card" id="create-form">
        <h2>创建链接</h2>
        <div class="row">
          <label>URL
            <input id="create-url" required placeholder="https://example.com/a?x=1#fragment">
          </label>
          <label>备注
            <textarea id="create-note" maxlength="2000" placeholder="可选，例如：稍后阅读、项目资料"></textarea>
          </label>
        </div>
        <div class="actions">
          <button type="submit">POST /api/links</button>
        </div>
      </form>

      <form class="card" id="list-form">
        <h2>查询列表</h2>
        <div class="row">
          <div class="inline">
            <label>学习状态
              <select id="list-learned">
                <option value="all">全部</option>
                <option value="false">未学习</option>
                <option value="true">已学习</option>
              </select>
            </label>
            <label>数量
              <input id="list-limit" type="number" min="1" max="100" value="20">
            </label>
          </div>
          <div class="inline">
            <label>搜索关键词
              <input id="list-q" maxlength="200" placeholder="链接或备注">
            </label>
            <label>before_id
              <input id="list-before" type="number" min="1" placeholder="分页用，可空">
            </label>
          </div>
        </div>
        <div class="actions">
          <button type="submit">GET /api/links</button>
          <button type="button" class="secondary" id="health-button">GET /health</button>
        </div>
      </form>

      <form class="card" id="read-form">
        <h2>读取或删除单条</h2>
        <div class="row">
          <label>链接 ID
            <input id="read-id" type="number" min="1" placeholder="1">
          </label>
        </div>
        <div class="actions">
          <button type="submit">GET /api/links/:id</button>
          <button type="button" class="danger" id="delete-button">DELETE /api/links/:id</button>
        </div>
      </form>

      <form class="card" id="update-form">
        <h2>修改链接</h2>
        <div class="row">
          <label>链接 ID
            <input id="update-id" type="number" min="1" placeholder="1">
          </label>
          <label>新 URL（可空）
            <input id="update-url" placeholder="https://example.com/updated">
          </label>
          <label>新备注
            <textarea id="update-note" maxlength="2000" placeholder="新的备注"></textarea>
          </label>
          <label class="check">
            <input id="update-note-enabled" type="checkbox">
            提交备注字段，可用于清空备注
          </label>
          <label>学习状态
            <select id="update-learned">
              <option value="">不修改</option>
              <option value="true">已学习</option>
              <option value="false">未学习</option>
            </select>
          </label>
        </div>
        <div class="actions">
          <button type="submit">PATCH /api/links/:id</button>
        </div>
      </form>

      <section class="card full">
        <h2>响应</h2>
        <p class="meta">所有请求都从浏览器直接发往 <code id="origin"></code>，没有隐藏代理。</p>
        <pre id="output">等待请求...</pre>
      </section>
    </section>
  </main>

  <script>
    const out = document.getElementById("output");
    const tokenInput = document.getElementById("api-token");
    const tokenStorageKey = "cairn-share-api-token";
    document.getElementById("origin").textContent = location.origin;
    tokenInput.value = localStorage.getItem(tokenStorageKey) || "";

    function value(id) {
      return document.getElementById(id).value.trim();
    }

    function show(payload) {
      out.textContent = JSON.stringify(payload, null, 2);
    }

    function apiToken() {
      return tokenInput.value.trim();
    }

    async function send(method, path, body) {
      out.textContent = "请求中...";
      const options = { method, headers: { "Accept": "application/json" } };
      if (path.startsWith("/api/")) {
        const token = apiToken();
        if (token) {
          options.headers["Authorization"] = "Bearer " + token;
        }
      }
      if (body !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }
      const response = await fetch(path, options);
      const text = await response.text();
      let parsed = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (_) {}
      show({
        method,
        path,
        status: response.status,
        ok: response.ok,
        cache: response.headers.get("x-cairn-cache"),
        serverTiming: response.headers.get("server-timing"),
        body: parsed
      });
    }

    document.getElementById("save-token").addEventListener("click", function () {
      localStorage.setItem(tokenStorageKey, apiToken());
      show({ ok: true, message: "Token 已保存到当前浏览器。" });
    });

    document.getElementById("clear-token").addEventListener("click", function () {
      localStorage.removeItem(tokenStorageKey);
      tokenInput.value = "";
      show({ ok: true, message: "Token 已清除。" });
    });

    document.getElementById("create-form").addEventListener("submit", function (event) {
      event.preventDefault();
      send("POST", "/api/links", { url: value("create-url"), note: document.getElementById("create-note").value });
    });

    document.getElementById("list-form").addEventListener("submit", function (event) {
      event.preventDefault();
      const params = new URLSearchParams();
      params.set("learned", value("list-learned"));
      params.set("limit", value("list-limit") || "20");
      if (value("list-q")) params.set("q", value("list-q"));
      if (value("list-before")) params.set("before_id", value("list-before"));
      send("GET", "/api/links?" + params.toString());
    });

    document.getElementById("health-button").addEventListener("click", function () {
      send("GET", "/health");
    });

    document.getElementById("read-form").addEventListener("submit", function (event) {
      event.preventDefault();
      send("GET", "/api/links/" + value("read-id"));
    });

    document.getElementById("delete-button").addEventListener("click", function () {
      const id = value("read-id");
      if (!id || !confirm("确认删除链接 #" + id + "？")) return;
      send("DELETE", "/api/links/" + id);
    });

    document.getElementById("update-form").addEventListener("submit", function (event) {
      event.preventDefault();
      const body = {};
      const url = value("update-url");
      const learned = value("update-learned");
      if (url) body.url = url;
      if (document.getElementById("update-note-enabled").checked) {
        body.note = document.getElementById("update-note").value;
      }
      if (learned) body.learned = learned === "true";
      send("PATCH", "/api/links/" + value("update-id"), body);
    });
  </script>
</body>
</html>`;
}
