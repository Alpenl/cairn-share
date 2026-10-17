import type { Env } from "./index";
import { canonicalJSON, validSnapshot, type EvidenceSnapshot } from "./domain";
import { unknownClassification } from "./manual-material";
import { readJSONObject } from "./json-body";
import { X_LINK_SQL } from "./source-claim";
import { validEnrichmentSource } from "./source-validation";

const capability = "X-Cairn-App-Processing";
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", [capability]: "1" } });
const fail = (error: string, status = 409) => reply({ error }, status);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
async function hash(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(value))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
type Action = "save_primary" | "retry_reading" | "retry_classification";
type Row = {
  id: number; url: string; original_text: string | null; source_context_text: string; images: string | null; related_links: string | null;
  original_language: string | null; ai_title: string | null; summary: string | null; translated_text: string | null;
  classification: string | null; content_revision: number; personal_revision: number; app_body_revision: number; curation_status: string;
  enrichment_status: string; enrichment_attempts: number; enrichment_next_retry_at: string | null;
  enrichment_lease_token: string | null; enrichment_lease_until: string | null; enrichment_updated_at: string | null;
  enrichment_error: string | null; enrichment_paid_uncertain: number; manual_priority: number; reading_supported: number;
  snapshot_id: number | null; source_hash: string | null; payload: string | null; saved_payload: string | null;
  generation: number; protocol: string; spec_id: string; registered: number;
  job_revision: number; job_status: string | null; job_input_revision: number; job_target: number | null;
  job_lease_token: string | null; job_lease_until: string | null; job_updated_at: string | null; job_error: string | null;
  class_unknown: number; reading_unknown: number; reading_revision: number | null;
  run_id: number | null; run_revision: number | null; run_target: number | null; run_status: string | null;
  run_snapshot: number | null; run_hash: string | null; run_coverage: string | null;
  human_events: number; human_overrides: number; pending_reading: number;
};

async function current(env: Env, id: number): Promise<Row | null> {
  return env.DB.prepare(`SELECT l.id,l.url,l.original_text,l.source_context_text,l.images,l.related_links,l.original_language,
    l.ai_title,l.summary,l.translated_text,l.classification,l.content_revision,l.personal_revision,l.app_body_revision,l.curation_status,
    l.enrichment_status,l.enrichment_attempts,l.enrichment_next_retry_at,l.enrichment_lease_token,l.enrichment_lease_until,
    l.enrichment_updated_at,l.enrichment_error,l.enrichment_paid_uncertain,l.manual_priority,CASE WHEN ${X_LINK_SQL.replaceAll("lower(url)", "lower(l.url)")} THEN 1 ELSE 0 END AS reading_supported,
    s.id AS snapshot_id,s.content_hash AS source_hash,s.payload,es.payload AS saved_payload,t.generation,t.protocol,t.spec_id,
    EXISTS(SELECT 1 FROM question_specs q WHERE q.spec_id=t.spec_id AND q.spec_hash=t.spec_hash) AS registered,
    COALESCE(j.revision,0) AS job_revision,j.status AS job_status,COALESCE(j.input_revision,0) AS job_input_revision,
    j.target_generation AS job_target,j.lease_token AS job_lease_token,j.lease_until AS job_lease_until,j.updated_at AS job_updated_at,j.error AS job_error,
    ${unknownClassification} AS class_unknown,
    (l.enrichment_paid_uncertain=1 OR EXISTS(SELECT 1 FROM enrichment_provider_attempts a WHERE a.link_id=l.id
      AND (a.state='reserved' OR COALESCE(a.http_status,0)=0))) AS reading_unknown,
    (SELECT a.content_revision FROM enrichment_provider_attempts a WHERE a.link_id=l.id AND a.stage='reading'
      AND a.state='responded' AND a.http_status=200 AND (EXISTS(SELECT 1 FROM enrichment_completion_receipts c
        WHERE c.link_id=l.id AND c.lease_hash=a.lease_hash) OR EXISTS(SELECT 1 FROM enrichment_provider_reading_recoveries r
        WHERE r.operation_key=a.operation_key)) ORDER BY a.created_at DESC,a.operation_key DESC LIMIT 1) AS reading_revision,
    r.id AS run_id,r.content_revision AS run_revision,r.target_generation AS run_target,r.status AS run_status,
    r.evidence_snapshot_id AS run_snapshot,r.source_hash AS run_hash,r.coverage AS run_coverage,
    (SELECT COUNT(*) FROM curation_events e WHERE e.link_id=l.id) AS human_events,
    (SELECT COUNT(*) FROM curation_overrides o WHERE o.link_id=l.id) AS human_overrides,
    (SELECT COUNT(*) FROM links INDEXED BY links_manual_priority_idx WHERE manual_priority=1
      AND enrichment_status IN ('pending','failed','processing') AND enrichment_status='pending') AS pending_reading
    FROM links l LEFT JOIN evidence_snapshots s ON s.link_id=l.id AND s.content_revision=l.content_revision
    LEFT JOIN enrichment_sources es ON es.link_id=l.id
    JOIN classification_target_state ts ON ts.id=1 JOIN classification_targets t ON t.generation=ts.generation
    LEFT JOIN classification_jobs j ON j.link_id=l.id
    LEFT JOIN classification_runs r ON r.id=(SELECT id FROM classification_runs WHERE link_id=l.id ORDER BY id DESC LIMIT 1)
    WHERE l.id=?`).bind(id).first<Row>();
}
async function snapshot(row: Row): Promise<EvidenceSnapshot | null> {
  try {
    const value: unknown = JSON.parse(row.payload ?? "null");
    if (!validSnapshot({ ...(value && typeof value === "object" ? value : {}), fetched_at: "" }) ||
      !hex(row.source_hash) || await hash(value) !== row.source_hash) return null;
    return value as EvidenceSnapshot;
  } catch { return null; }
}
const busy = (status: string | null, until: string | null, now: string) => status === "processing" && (!until || until > now);
async function fence(row: Row): Promise<string> {
  // Capacity is checked again at commit. An unrelated bookmark entering the
  // queue does not invalidate this bookmark's explicit source/operation intent.
  const { pending_reading: _capacity, ...identity } = row;
  return hash(identity);
}
function readingCheckpoint(row: Row, originalText: string) {
  try { return { original_text: originalText, original_language: row.original_language ?? "", context_text: row.source_context_text,
    related_links: JSON.parse(row.related_links ?? "[]") ?? [], image_urls: [], model: "manual_primary" }; }
  catch { return null; }
}
function reason(action: Action, row: Row, source: EvidenceSnapshot | null, now: string): string | null {
  if (row.curation_status === "drop") return "excluded_from_processing";
  if (row.protocol !== "v2" || !row.registered || !integer(row.generation)) return "v2_required";
  if (row.payload !== null && !source) return "source_snapshot_unavailable";
  if (action === "save_primary") {
    if (row.original_text?.trim() || source?.blocks.some(block => block.role === "primary")) return "primary_already_present";
    if (row.reading_unknown || row.class_unknown) return "provider_result_unknown";
    if (busy(row.enrichment_status, row.enrichment_lease_until, now) || busy(row.job_status, row.job_lease_until, now)) return "processing_busy";
    if (source && source.blocks.length >= 64) return "source_limit";
    if (!validEnrichmentSource(readingCheckpoint(row, "source"))) return "source_metadata_unavailable";
    if (row.reading_supported && row.manual_priority !== 1 && row.pending_reading >= 100) return "manual_queue_full";
    return null;
  }
  if (!row.original_text?.trim() || !source || source.blocks.filter(block => block.role === "primary").length !== 1 ||
    !source.blocks.some(block => block.role === "primary" && block.text === row.original_text)) return "primary_source_required";
  if (action === "retry_reading" && !row.reading_supported) return "reading_unsupported";
  const reading = action === "retry_reading", state = reading ? row.enrichment_status : row.job_status;
  if (reading ? row.reading_unknown : row.class_unknown) return "provider_result_unknown";
  if (busy(state, reading ? row.enrichment_lease_until : row.job_lease_until, now)) return "processing_busy";
  if (state === "pending") return "already_queued";
  if (reading && row.manual_priority !== 1 && row.pending_reading >= 100) return "manual_queue_full";
  return null;
}
function queueState(status: string | null, until: string | null, unknown: number, now: string): string {
  if (unknown) return "result_unknown";
  if (status === "processing") return busy(status, until, now) ? "running" : "lease_expired";
  if (status === "pending") return "queued";
  if (["completed", "failed", "exhausted", "waiting_source"].includes(status ?? "")) return status!;
  return status === null ? "not_run" : "unknown";
}
function classificationOutput(row: Row): string {
  if (row.run_id === null) return "absent";
  if (row.run_status !== "succeeded") return "failed";
  if (row.run_revision !== row.content_revision || row.run_target !== row.generation) return "stale";
  if (row.run_snapshot === null || !hex(row.run_hash)) return "unversioned";
  if (row.run_snapshot !== row.snapshot_id || row.run_hash !== row.source_hash) return "stale";
  return row.run_coverage === "complete" ? "current" : row.run_coverage === "partial" ? "partial" : "unknown";
}

/** One explicit detail read, not a homepage poll. Mutations carry an opaque
 * fence over the observed row and an immutable operation key. No route fetches
 * a URL or calls a provider. Protocol/target management is never App-accessible. */
export async function processingRoute(request: Request, env: Env, id: number): Promise<Response> {
  if (!["GET", "POST"].includes(request.method)) return fail("method_not_allowed", 405);
  const url = new URL(request.url);
  if (request.headers.get(capability) !== "1") return fail("capability_mismatch");
  if (!integer(id) || id < 1 || !url.pathname.endsWith(`/${id}/processing`) || url.searchParams.size) return fail("invalid_request", 400);
  const now = new Date().toISOString();
  if (request.method === "GET") {
    const row = await current(env, id);
    if (!row) return fail("not_found", 404);
    const source = await snapshot(row), primary = !!row.original_text?.trim();
    const actions = Object.fromEntries((["save_primary", "retry_reading", "retry_classification"] as Action[]).map(action => {
      const blocked = reason(action, row, source, now);
      return [action, { allowed: blocked === null, blocked_reason: blocked, model_calls_now: 0,
        may_call_model_later: true, queues: action === "save_primary"
          ? [...(row.reading_supported ? ["reading"] : []), "classification"] : [action.slice(6)] }];
    }));
    const hasReading = !!(row.ai_title || row.summary || row.translated_text);
    return reply({ version: 1, id, fence: await fence(row), content_revision: row.content_revision,
      evidence_snapshot_id: row.snapshot_id, source_hash: row.source_hash, target_generation: row.generation,
      stages: {
        source: { state: primary ? source ? "available" : "snapshot_unavailable" : "missing_primary", archived_blocks: source?.blocks.length ?? 0 },
        reading: { state: queueState(row.enrichment_status, row.enrichment_lease_until, row.reading_unknown, now),
          output_state: !hasReading ? "absent" : row.reading_revision === null ? "unversioned"
            : row.reading_revision === row.content_revision ? "current" : "stale", content_revision: row.reading_revision,
          supported: row.reading_supported === 1 },
        classification: { state: queueState(row.job_status, row.job_lease_until, row.class_unknown, now),
          run_id: row.run_id, coverage: row.run_coverage, output_state: classificationOutput(row) },
        human: { state: row.human_events || row.human_overrides ? "recorded" : "no_recorded_action",
          revision: row.personal_revision, events: row.human_events, overrides: row.human_overrides }
      }, actions, policy_replay: { supported: false, reason: "local_policy_executor_required" }, max_text_bytes: 100000, model_calls: 0 });
  }
  const body = await readJSONObject(request, 128 << 10);
  const keys = ["version", "operation_key", "fence", "action", "expected_content_revision", "target_generation", ...(body?.action === "save_primary" ? ["text"] : [])];
  if (!body || Object.keys(body).length !== keys.length || keys.some(key => !(key in body)) ||
    body.version !== 1 || typeof body.operation_key !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(body.operation_key) || !hex(body.fence) ||
    !["save_primary", "retry_reading", "retry_classification"].includes(String(body.action)) ||
    !integer(body.expected_content_revision) || body.expected_content_revision < 1 || !integer(body.target_generation) ||
    (body.action === "save_primary" && (typeof body.text !== "string" || !body.text.trim() || new TextEncoder().encode(body.text).length > 100000 ||
      new TextDecoder().decode(new TextEncoder().encode(body.text)) !== body.text)))
    return fail("invalid_action", 400);
  const digest = await hash({ id, ...body }), key = `app-processing:${body.operation_key}`;
  const stored = () => env.DB.prepare("SELECT link_id,payload_hash,status,response FROM classification_operations WHERE operation_key=?")
    .bind(key).first<{ link_id: number; payload_hash: string; status: string; response: string }>();
  const replay = (old: Awaited<ReturnType<typeof stored>>) => {
    if (!old) return null;
    if (old.link_id !== id || old.payload_hash !== digest || old.status !== "app_processing") return fail("operation_conflict");
    try { return reply({ ...JSON.parse(old.response), replayed: true }); }
    catch { return fail("receipt_unavailable", 503); }
  };
  const prior = replay(await stored());
  if (prior) return prior;
  const row = await current(env, id);
  if (!row) return fail("not_found", 404);
  if (await fence(row) !== body.fence || row.content_revision !== body.expected_content_revision || row.generation !== body.target_generation) return fail("state_conflict");
  const source = await snapshot(row), action = body.action as Action, blocked = reason(action, row, source, now);
  if (blocked) return fail(blocked);
  const revision = row.content_revision + (action === "save_primary" ? 1 : 0);
  if (!Number.isSafeInteger(revision) || row.job_revision >= Number.MAX_SAFE_INTEGER || row.job_input_revision >= Number.MAX_SAFE_INTEGER) return fail("source_limit", 413);
  let payload: string | null = null, sourceHash = row.source_hash;
  if (action === "save_primary") {
    const blocks = [...(source?.blocks ?? [])];
    // Legacy context remains explicitly unattributed. It is never promoted to primary.
    if (row.source_context_text && !blocks.some(block => block.text === row.source_context_text))
      blocks.push({ id: "manual-legacy-context", role: "legacy_unknown", text: row.source_context_text, acquired: "legacy_archive" });
    blocks.push({ id: `manual-primary-${(await hash(body.text)).slice(0, 24)}`, role: "primary", text: body.text as string,
      url: row.url, acquired: "manual", relation: canonicalJSON({ scope: "missing_primary", supplied_by: "human", model_calls: 0 }) });
    const next = { ...(source ?? { retrieval: "manual_primary", truncation: { truncated: false } }), blocks,
      ...(row.saved_payload === null ? {} : { previous_source_checkpoint: row.saved_payload }) };
    if (!validSnapshot({ ...next, fetched_at: "" })) return fail("source_limit", 413);
    payload = canonicalJSON(next);
    if (new TextEncoder().encode(payload).length > (8 << 20)) return fail("source_limit", 413);
    sourceHash = await hash(next);
  }
  // Read the whole same identity again inside the transaction. The fence covers
  // queue epochs, source/media, human revision, paid state and target together.
  // A competing request cannot consume a preflight check from an earlier state.
  const guard = `EXISTS(SELECT 1 FROM links l LEFT JOIN classification_jobs j ON j.link_id=l.id
    LEFT JOIN evidence_snapshots s ON s.link_id=l.id AND s.content_revision=l.content_revision
    LEFT JOIN enrichment_sources es ON es.link_id=l.id
    WHERE (l.id=? AND l.content_revision=? AND l.app_body_revision=? AND l.personal_revision=? AND l.curation_status IS ?)
      AND (l.url IS ? AND l.original_text IS ? AND l.source_context_text IS ? AND l.images IS ? AND l.related_links IS ?)
      AND (l.enrichment_status IS ? AND l.enrichment_attempts=? AND l.enrichment_next_retry_at IS ?)
      AND (l.enrichment_lease_token IS ? AND l.enrichment_lease_until IS ? AND l.enrichment_updated_at IS ?)
      AND (l.enrichment_paid_uncertain=? AND l.manual_priority=?)
      AND (COALESCE(j.revision,0)=? AND COALESCE(j.input_revision,0)=? AND j.status IS ? AND j.lease_token IS ? AND j.lease_until IS ?)
      AND (j.updated_at IS ? AND s.id IS ? AND s.content_hash IS ? AND s.payload IS ? AND es.payload IS ?)
      AND (SELECT MAX(id) FROM classification_runs WHERE link_id=l.id) IS ?
      AND (SELECT generation FROM classification_target_state WHERE id=1)=?
      AND (?=0 OR l.manual_priority=1 OR (SELECT COUNT(*) FROM links INDEXED BY links_manual_priority_idx
        WHERE manual_priority=1 AND enrichment_status IN ('pending','failed','processing') AND enrichment_status='pending')<100)
      AND (${unknownClassification})=?
      AND (l.enrichment_paid_uncertain=1 OR EXISTS(SELECT 1 FROM enrichment_provider_attempts a WHERE a.link_id=l.id
        AND (a.state='reserved' OR COALESCE(a.http_status,0)=0)))=?)`;
  const values = [id, row.content_revision, row.app_body_revision, row.personal_revision, row.curation_status, row.url, row.original_text,
    row.source_context_text, row.images, row.related_links, row.enrichment_status, row.enrichment_attempts, row.enrichment_next_retry_at,
    row.enrichment_lease_token, row.enrichment_lease_until, row.enrichment_updated_at, row.enrichment_paid_uncertain, row.manual_priority,
    row.job_revision, row.job_input_revision, row.job_status, row.job_lease_token, row.job_lease_until, row.job_updated_at,
    row.snapshot_id, row.source_hash, row.payload, row.saved_payload, row.run_id, row.generation,
    action === "retry_reading" || action === "save_primary" && row.reading_supported === 1 ? 1 : 0, row.class_unknown, row.reading_unknown];
  const response = { version: 1, id, operation_key: body.operation_key, action, status: action === "save_primary" ? "source_saved" : "queued",
    content_revision: revision, source_hash: sourceHash, target_generation: row.generation,
    classification_queued: action !== "retry_reading", reading_queued: action === "retry_reading" || action === "save_primary" && row.reading_supported === 1,
    model_calls: 0 };
  const marker = "EXISTS(SELECT 1 FROM classification_operations WHERE operation_key=? AND payload_hash=? AND status='app_processing_applying')";
  const bindings = [key, digest];
  const statements = [env.DB.prepare(`INSERT INTO classification_operations(operation_key,link_id,payload_hash,status,response,created_at)
    SELECT ?,?,?,'app_processing_applying',?,? WHERE ${guard} ON CONFLICT DO NOTHING RETURNING operation_key`)
    .bind(key, id, digest, canonicalJSON(response), now, ...values)];
  if (action === "save_primary") {
    // Old URL-only saves can carry NULL instead of an empty related-link list.
    // Normalize that absence in this same source update, so reading completion
    // does not manufacture a second source revision for NULL -> [].
    const checkpoint = readingCheckpoint(row, body.text as string)!;
    statements.push(env.DB.prepare(`UPDATE links SET original_text=?,related_links=? WHERE id=? AND ${marker}`)
      .bind(body.text, canonicalJSON(checkpoint.related_links), id, ...bindings));
    // Persist the reading checkpoint here too. Otherwise the consumer's legacy
    // adoption route would clear the retained reading aids on its first claim.
    // Normalize the queue epoch once below, after all legacy source triggers.
    statements.push(env.DB.prepare(`INSERT INTO enrichment_sources(link_id,url,original_text,payload,fetched_at)
      SELECT ?,?,?,?,? WHERE ${marker} ON CONFLICT(link_id) DO UPDATE SET url=excluded.url,original_text=excluded.original_text,
        payload=excluded.payload,fetched_at=excluded.fetched_at`).bind(id, row.url, body.text, canonicalJSON(checkpoint), now, ...bindings));
    statements.push(env.DB.prepare(`INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,truncated,completeness,created_at)
      SELECT ?,?,?,?,?,?,? WHERE ${marker}`).bind(id, revision, sourceHash!, payload!, source?.truncation.truncated ? 1 : 0,
        source?.truncation.truncated ? "truncated" : "complete", now, ...bindings));
    // The old input trigger clears the legacy projection; retain its bytes as
    // historical output, with freshness exposed separately above.
    statements.push(env.DB.prepare(`UPDATE links SET classification=? WHERE id=? AND ${marker}`).bind(row.classification, id, ...bindings));
  }
  if (action !== "retry_reading") {
    statements.push(env.DB.prepare(`INSERT INTO classification_jobs(link_id,status,revision,input_revision,target_generation,spec_id,
      content_revision,evidence_snapshot_id,evidence_hash,updated_at)
      SELECT ?,'pending',?,?,?,?,?,(SELECT id FROM evidence_snapshots WHERE link_id=? AND content_revision=?),?,? WHERE ${marker}
      ON CONFLICT(link_id) DO UPDATE SET status='pending',revision=excluded.revision,input_revision=excluded.input_revision,
        target_generation=excluded.target_generation,spec_id=excluded.spec_id,content_revision=excluded.content_revision,
        evidence_snapshot_id=excluded.evidence_snapshot_id,evidence_hash=excluded.evidence_hash,updated_at=excluded.updated_at,
        attempts=0,next_retry_at=NULL,error=NULL,result=NULL,lease_token=NULL,lease_until=NULL`)
      .bind(id, row.job_revision + 1, Math.max(1, row.job_input_revision + (action === "save_primary" ? 1 : 0)), row.generation, row.spec_id,
        revision, id, revision, sourceHash!, now, ...bindings));
  }
  if (response.reading_queued) {
    statements.push(env.DB.prepare(`UPDATE links SET enrichment_status='pending',enrichment_attempts=0,enrichment_next_retry_at=NULL,
      enrichment_lease_token=NULL,enrichment_lease_until=NULL,enrichment_error=NULL,enrichment_updated_at=?,manual_priority=1
      WHERE id=? AND ${marker}`).bind(now, id, ...bindings));
  }
  statements.push(env.DB.prepare(`UPDATE classification_operations SET status='app_processing'
    WHERE operation_key=? AND payload_hash=? AND status='app_processing_applying' RETURNING response`).bind(...bindings));
  try {
    const result = await env.DB.batch(statements);
    if (result[0].results.length) return reply({ ...response, replayed: false });
    return replay(await stored()) ?? fail("state_conflict");
  } catch (error) {
    const raced = replay(await stored());
    if (raced) return raced;
    throw error;
  }
}
