import type { Env } from "./index";
import { canonicalJSON, validSnapshot, snapshotCompleteness, type EvidenceSnapshot, type EvidenceBlock } from "./domain";
import { readJSONObject } from "./json-body";

const capability = "X-Cairn-App-Manual-Material";
const maxTextBytes = 100_000;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const text = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim() && v.length <= max;
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", [capability]: "1" } });
const fail = (error: string, status = 409) => reply({ error }, status);
async function hash(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(value))))]
    .map(x => x.toString(16).padStart(2, "0")).join("");
}
type GapKind = "external_link" | "image_text" | "truncation";
type Gap = { kind: GapKind; source_ref: string; role: EvidenceBlock["role"]; url: string };
type SourceRow = {
  id: number; url: string; original_text: string | null; curation_status: string; content_revision: number; images: string | null; related_links: string | null;
  snapshot_id: number | null; source_hash: string | null; payload: string | null;
  generation: number | null; protocol: string | null; spec_id: string | null; spec_hash: string | null;
  registered: number; source_busy: number; classification_busy: number; result_unknown: number;
};
// A known HTTP success is not a durable classification result. Match the
// actual reservation to stored raw calls, or to the normal queue completion's
// immutable operation receipt (which survives run archival/retention).
const completedClassification = `(EXISTS(SELECT 1 FROM classification_operations op WHERE op.link_id=l.id AND op.status='applied'
  AND op.operation_key=CASE WHEN json_valid(r.identity) THEN
    printf('classify-%d-rev-%d-input-%d-gen-%d',r.link_id,json_extract(r.identity,'$.revision'),json_extract(r.identity,'$.input_revision'),json_extract(r.identity,'$.target_generation')) END
  AND CASE WHEN json_valid(op.response) THEN json_extract(op.response,'$.status')='completed' ELSE 0 END)
  OR EXISTS(SELECT 1 FROM classification_runs cr,json_each(CASE WHEN json_valid(cr.raw_judgments) THEN cr.raw_judgments ELSE '{}' END,'$.calls') call
    WHERE cr.link_id=l.id AND cr.status='succeeded' AND CASE WHEN call.type='object' THEN json_extract(call.value,'$.reservation_key') END=r.reservation_key))`;
export const unknownClassification = `EXISTS (SELECT 1 FROM classification_reservations r
  LEFT JOIN classification_provider_attempts a ON a.reservation_key=r.reservation_key
  WHERE r.link_id=l.id AND (a.id IS NULL OR CASE WHEN json_valid(a.call_json) THEN
    COALESCE(json_extract(a.call_json,'$.http_status'),0)=0 OR
    (json_extract(a.call_json,'$.http_status')>=400 AND COALESCE(json_extract(a.call_json,'$.usage_missing'),1)<>0) OR
    (json_extract(a.call_json,'$.http_status') BETWEEN 200 AND 299 AND COALESCE(json_extract(a.call_json,'$.error_class'),'none')='none'
      AND NOT ${completedClassification})
    ELSE 1 END))`;
async function sourceRow(env: Env, id: number, now: string): Promise<SourceRow | null> {
  return env.DB.prepare(`SELECT l.id,l.url,l.original_text,l.curation_status,l.content_revision,l.images,l.related_links,
    s.id AS snapshot_id,s.content_hash AS source_hash,s.payload,
    t.generation,t.protocol,t.spec_id,t.spec_hash,
    EXISTS(SELECT 1 FROM question_specs WHERE spec_id=t.spec_id AND spec_hash=t.spec_hash) AS registered,
    (l.enrichment_status='processing' AND (l.enrichment_lease_until IS NULL OR l.enrichment_lease_until>?)) AS source_busy,
    EXISTS(SELECT 1 FROM classification_jobs WHERE link_id=l.id AND status='processing' AND (lease_until IS NULL OR lease_until>?)) AS classification_busy,
    (l.enrichment_paid_uncertain=1 OR ${unknownClassification}) AS result_unknown
    FROM links l LEFT JOIN evidence_snapshots s ON s.link_id=l.id AND s.content_revision=l.content_revision
    LEFT JOIN classification_target_state ts ON ts.id=1
    LEFT JOIN classification_targets t ON t.generation=ts.generation WHERE l.id=?`).bind(now, now, id).first<SourceRow>();
}
function parsedSnapshot(row: SourceRow): EvidenceSnapshot | null {
  try {
    const value: unknown = JSON.parse(row.payload ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return validSnapshot({ ...value, fetched_at: "" }) ? value as EvidenceSnapshot : null;
  } catch { return null; }
}
function stringArray(value: string | null): unknown[] {
  try { const parsed: unknown = JSON.parse(value ?? "[]"); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
function references(row: SourceRow, snapshot: EvidenceSnapshot): Gap[] {
  const gaps: Gap[] = [];
  for (const ref of stringArray(row.related_links).slice(0, 50)) {
    if (!text(ref, 2048)) continue;
    try { const url = new URL(ref); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue; }
    catch { continue; }
    // A manual fragment does not pretend that an entire external article was fetched.
    if (!snapshot.blocks.some(block => block.role === "external_article" && block.url === ref && block.acquired !== "manual"))
      gaps.push({ kind: "external_link", source_ref: ref, role: "external_article", url: ref });
  }
  for (const image of stringArray(row.images).slice(0, 20)) {
    const key = typeof image === "string" ? image : image && typeof image === "object" && "key" in image ? image.key : null;
    if (typeof key === "string" && new RegExp(`^enrichment/${row.id}/[a-f0-9]{64}\\.(jpg|png|webp|gif|avif)$`).test(key))
      gaps.push({ kind: "image_text", source_ref: key, role: "legacy_unknown", url: row.url });
  }
  if (snapshot.truncation.truncated) for (const block of snapshot.blocks.filter(block => block.acquired !== "manual"))
    gaps.push({ kind: "truncation", source_ref: block.id,
      role: block.role === "primary" ? "author_continuation" : block.role, url: block.url || row.url });
  return gaps.filter((gap, i) => gaps.findIndex(other => other.kind === gap.kind && other.source_ref === gap.source_ref) === i);
}
function blocked(row: SourceRow, snapshot: EvidenceSnapshot | null): string | null {
  if (!snapshot || !positive(row.snapshot_id) || !hex(row.source_hash)) return "source_snapshot_unavailable";
  // This action supplements an existing primary source. It must not claim an
  // image fragment is primary authorship or queue work the consumer cannot run.
  if (!row.original_text?.trim() || snapshot.blocks.filter(block => block.role === "primary").length !== 1 ||
    !snapshot.blocks.some(block => block.role === "primary" && block.text === row.original_text)) return "primary_source_required";
  if (row.curation_status === "drop") return "excluded_from_classification";
  if (row.protocol !== "v2" || !row.registered || !Number.isSafeInteger(row.generation) || Number(row.generation) < 0) return "v2_required";
  if (row.result_unknown) return "provider_result_unknown";
  if (row.source_busy || row.classification_busy) return "processing_busy";
  return null;
}
type ReceiptRow = { id: string; link_id: number; protocol: number; scope: string; payload_hash: string; receipt: string | null };

/** A deliberate human fragment, bound to a real, current material gap. It
 * appends immutable evidence and queues the changed input; no provider or URL
 * fetch is called here. Protocol 2 rows are terminal, never executable by the
 * protocol 1 controlled-fetch consumer. Existing source/media/human values stay.
 */
export async function manualMaterialRoute(request: Request, env: Env, id: number): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return fail("method_not_allowed", 405);
  if (request.headers.get(capability) !== "1") return fail("capability_mismatch");
  const url = new URL(request.url), pathID = url.pathname.match(/\/(\d+)\/manual-material$/)?.[1];
  if (!positive(id) || pathID !== String(id) || url.searchParams.size) return fail("invalid_request", 400);
  const now = new Date().toISOString();
  if (request.method === "GET") {
    const row = await sourceRow(env, id, now);
    if (!row) return fail("not_found", 404);
    const snapshot = parsedSnapshot(row), reason = blocked(row, snapshot) ??
      (snapshot && await hash(snapshot) !== row.source_hash ? "source_snapshot_unavailable" : null), options = snapshot ? references(row, snapshot) : [];
    return reply({ version: 1, id, source: snapshot && positive(row.snapshot_id) && hex(row.source_hash) &&
      Number.isSafeInteger(row.generation) && Number(row.generation) >= 0 ? {
      content_revision: row.content_revision, evidence_snapshot_id: row.snapshot_id, source_hash: row.source_hash, target_generation: row.generation
    } : null, can_submit: reason === null && options.length > 0,
      blocked_reason: reason ?? (options.length ? null : "no_observed_gap"), max_text_bytes: maxTextBytes,
      options: options.map(({ kind, source_ref, role }) => ({ kind, source_ref, role })) });
  }
  const body = await readJSONObject(request, 128 << 10);
  const keys = ["version", "operation_key", "expected_content_revision", "evidence_snapshot_id", "source_hash", "target_generation", "kind", "source_ref", "text"];
  if (!body || Object.keys(body).some(key => !keys.includes(key)) || keys.some(key => !(key in body)) ||
    body.version !== 1 || !text(body.operation_key, 200) || !positive(body.expected_content_revision) || !positive(body.evidence_snapshot_id) ||
    !hex(body.source_hash) || !Number.isSafeInteger(body.target_generation) || Number(body.target_generation) < 0 ||
    !["external_link", "image_text", "truncation"].includes(String(body.kind)) || !text(body.source_ref, 2048) ||
    !text(body.text, maxTextBytes) || new TextEncoder().encode(body.text).length > maxTextBytes) return fail("invalid_material", 400);
  const digest = await hash({ id, ...body }), dedupe = `manual-material:${body.operation_key}`;
  const stored = () => env.DB.prepare(`SELECT id,link_id,protocol,scope,payload_hash,receipt FROM evidence_requests WHERE dedupe_key=?`)
    .bind(dedupe).first<ReceiptRow>();
  const replay = (old: ReceiptRow | null): Response | null => {
    if (!old) return null;
    if (old.link_id !== id || old.protocol !== 2 || old.scope !== "manual_material" || old.payload_hash !== digest || !old.receipt)
      return fail("operation_conflict");
    try { return reply({ ...JSON.parse(old.receipt), replayed: true }); }
    catch { return fail("receipt_unavailable", 503); }
  };
  const prior = replay(await stored());
  if (prior) return prior;
  const row = await sourceRow(env, id, now);
  if (!row) return fail("not_found", 404);
  if (row.content_revision !== body.expected_content_revision || row.snapshot_id !== body.evidence_snapshot_id ||
    row.source_hash !== body.source_hash || row.generation !== body.target_generation) return fail("source_conflict");
  const snapshot = parsedSnapshot(row), reason = blocked(row, snapshot);
  if (reason || !snapshot) return fail(reason ?? "source_snapshot_unavailable");
  if (await hash(snapshot) !== row.source_hash) return fail("source_snapshot_unavailable");
  const option = references(row, snapshot).find(gap => gap.kind === body.kind && gap.source_ref === body.source_ref);
  if (!option) return fail("gap_unavailable");
  const relation = canonicalJSON({ why_needed: body.kind, source_ref: body.kind === "external_link" ? "" : body.source_ref,
    scope: "manual_material", partial: true, model_calls: 0 });
  const block: EvidenceBlock = { id: `manual-${(await hash({ kind: body.kind, ref: body.source_ref, text: body.text })).slice(0, 32)}`,
    role: option.role, text: body.text, url: option.url, relation, acquired: "manual" };
  const present = snapshot.blocks.find(old => old.id === block.id);
  if (present && canonicalJSON(present) !== canonicalJSON(block)) return fail("block_identity_conflict");
  const changed = !present;
  if (changed && row.content_revision >= Number.MAX_SAFE_INTEGER) return fail("material_limit", 413);
  const next = changed ? { ...snapshot, blocks: [...snapshot.blocks, block] } : snapshot;
  if (!validSnapshot({ ...next, fetched_at: "" })) return fail("material_limit", 413);
  const payload = canonicalJSON(next);
  if (new TextEncoder().encode(payload).length > (8 << 20)) return fail("material_limit", 413);
  // Hash the exact archived objective JSON, including fields unknown to this
  // client. The consumer verifies these same bytes before inference.
  const nextHash = changed ? await hash(next) : row.source_hash!;
  const revision = row.content_revision + (changed ? 1 : 0), requestID = crypto.randomUUID();
  const guard = `EXISTS(SELECT 1 FROM links l JOIN evidence_snapshots s ON s.link_id=l.id AND s.content_revision=l.content_revision
    JOIN classification_target_state ts ON ts.id=1 JOIN classification_targets t ON t.generation=ts.generation
    JOIN question_specs q ON q.spec_id=t.spec_id AND q.spec_hash=t.spec_hash
    WHERE l.id=? AND l.content_revision=? AND s.id=? AND s.content_hash=? AND t.generation=? AND t.protocol='v2'
      AND l.related_links IS ? AND l.images IS ?
      AND l.enrichment_paid_uncertain=0 AND l.curation_status<>'drop'
      AND NOT(l.enrichment_status='processing' AND (l.enrichment_lease_until IS NULL OR l.enrichment_lease_until>?))
      AND NOT EXISTS(SELECT 1 FROM classification_jobs WHERE link_id=l.id AND status='processing' AND (lease_until IS NULL OR lease_until>?))
      AND NOT ${unknownClassification})`;
  const guardValues = [id, row.content_revision, row.snapshot_id!, row.source_hash!, row.generation!, row.related_links, row.images, now, now];
  const marker = "EXISTS(SELECT 1 FROM evidence_requests WHERE id=? AND payload_hash=? AND status='applying' AND protocol=2)";
  const statements = [env.DB.prepare(`INSERT INTO evidence_requests(id,link_id,content_revision,scope,status,budget,dedupe_key,created_at,
    protocol,evidence_snapshot_id,source_hash,target_generation,url,payload_hash,checkpoint,checkpoint_hash)
    SELECT ?,?,?,'manual_material','applying',?,?,?,2,?,?,?,?,?,?,? WHERE ${guard}
    ON CONFLICT DO NOTHING RETURNING id`).bind(requestID, id, row.content_revision,
      canonicalJSON({ max_bytes: maxTextBytes, timeout_ms: 0 }), dedupe, now, row.snapshot_id!, row.source_hash!, row.generation!, option.url,
      digest, canonicalJSON({ ...body, scope: "manual_material", acquired: "manual", partial: true,
        budget: { max_bytes: maxTextBytes, max_model_calls: 0, max_network_requests: 0 } }), digest, ...guardValues)];
  if (changed) {
    statements.push(env.DB.prepare(`INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,truncated,completeness,created_at)
      SELECT ?,?,?,?,?,?,? WHERE ${marker}`).bind(id, revision, nextHash, payload, snapshot.truncation.truncated ? 1 : 0,
        snapshotCompleteness(next), now, requestID, digest));
    statements.push(env.DB.prepare(`UPDATE links SET content_revision=? WHERE id=? AND content_revision=? AND ${marker}`)
      .bind(revision, id, row.content_revision, requestID, digest));
    statements.push(env.DB.prepare(`INSERT INTO classification_jobs(link_id,status,target_generation,spec_id,content_revision,evidence_snapshot_id,evidence_hash,updated_at)
      SELECT ?,'pending',?,?,?,(SELECT id FROM evidence_snapshots WHERE link_id=? AND content_revision=?),?,? WHERE ${marker}
      ON CONFLICT(link_id) DO UPDATE SET status='pending',attempts=0,next_retry_at=NULL,error=NULL,result=NULL,lease_token=NULL,lease_until=NULL,
      revision=classification_jobs.revision+1,input_revision=classification_jobs.input_revision+1,target_generation=excluded.target_generation,
      spec_id=excluded.spec_id,content_revision=excluded.content_revision,evidence_snapshot_id=excluded.evidence_snapshot_id,
      evidence_hash=excluded.evidence_hash,updated_at=excluded.updated_at`)
      .bind(id, row.generation!, row.spec_id!, revision, id, revision, nextHash, now, requestID, digest));
  }
  statements.push(env.DB.prepare(`UPDATE evidence_requests SET status='completed',decided_at=?,result=checkpoint,
    receipt=(SELECT json_object('version',1,'id',?,'operation_key',?,'request_id',?,'status','material_saved',
      'content_revision',?,'evidence_snapshot_id',s.id,'source_hash',?,'changed',json(?),'classification_queued',json(?),'model_calls',0)
      FROM evidence_snapshots s WHERE s.link_id=? AND s.content_revision=? AND s.content_hash=?)
    WHERE id=? AND payload_hash=? AND status='applying' RETURNING receipt`)
    .bind(now, id, body.operation_key, requestID, revision, nextHash, String(changed), String(changed), id, revision, nextHash, requestID, digest));
  try {
    const result = await env.DB.batch(statements);
    const receipt = (result[result.length - 1].results[0] as { receipt?: unknown } | undefined)?.receipt;
    if (typeof receipt === "string") return reply({ ...JSON.parse(receipt), replayed: false });
    return replay(await stored()) ?? fail("source_conflict");
  } catch (error) {
    const raced = replay(await stored());
    if (raced) return raced;
    throw error;
  }
}
