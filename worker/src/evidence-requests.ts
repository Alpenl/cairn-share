import type { Env } from "./index";
import { canonicalJSON, contentHash, objectivePayload, snapshotCompleteness, validSnapshot, type EvidenceSnapshot } from "./domain";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (error: string, status = 409) => reply({ error }, status);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
async function hash(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(value))))].map(x => x.toString(16).padStart(2, "0")).join("");
}
interface Row {
  id: string; link_id: number; content_revision: number; status: string; scope: string; budget: string;
  protocol: number; evidence_snapshot_id: number; source_hash: string; target_generation: number;
  url: string; payload_hash: string; owner_token: string | null; lease_until: string | null; attempts: number;
  checkpoint: string | null; checkpoint_hash: string | null; receipt: string | null;
}
const columns = "id,link_id,content_revision,status,scope,budget,protocol,evidence_snapshot_id,source_hash,target_generation,url,payload_hash,owner_token,lease_until,attempts,checkpoint,checkpoint_hash,receipt";
function view(row: Row, owned = false) {
  return { id: row.id, link_id: row.link_id, status: row.status, scope: row.scope, budget: JSON.parse(row.budget),
    content_revision: row.content_revision, evidence_snapshot_id: row.evidence_snapshot_id, source_hash: row.source_hash,
    target_generation: row.target_generation, url: row.url, attempts: row.attempts, owned,
    owner_token: owned ? row.owner_token : null, lease_until: row.lease_until,
    checkpoint_hash: row.checkpoint_hash, receipt: row.receipt ? JSON.parse(row.receipt) : null };
}
async function read(env: Env, id: string) { return env.DB.prepare(`SELECT ${columns} FROM evidence_requests WHERE id=?`).bind(id).first<Row>(); }

export async function createOwnedEvidenceRequest(env: Env, linkID: number, body: Record<string, unknown>): Promise<Response> {
  const budget = body.budget as Record<string, unknown> | null;
  if (body.protocol !== 1 || body.scope !== "external_link" || !text(body.dedupe_key, 200) || !text(body.url, 2048) ||
      !Number.isSafeInteger(body.evidence_snapshot_id) || Number(body.evidence_snapshot_id) < 1 ||
      !Number.isSafeInteger(body.content_revision) || !Number.isSafeInteger(body.target_generation) || !text(body.source_hash, 64) ||
      !budget || Object.keys(budget).some(key => !["max_bytes", "timeout_ms"].includes(key)) || !Number.isSafeInteger(budget.max_bytes) || Number(budget.max_bytes) < 1 || Number(budget.max_bytes) > 2 * 1024 * 1024 ||
      !Number.isSafeInteger(budget.timeout_ms) || Number(budget.timeout_ms) < 1 || Number(budget.timeout_ms) > 30000) return fail("invalid_evidence_request", 400);
  let url: URL;
  try { url = new URL(body.url); } catch { return fail("invalid_evidence_url", 400); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) return fail("invalid_evidence_url", 400);
  const payloadHash = await hash({ link_id: linkID, scope: body.scope, url: body.url, budget,
    evidence_snapshot_id: body.evidence_snapshot_id, source_hash: body.source_hash,
    content_revision: body.content_revision, target_generation: body.target_generation });
  const existingResponse = async (): Promise<Response | null> => {
    const row = await env.DB.prepare(`SELECT ${columns} FROM evidence_requests WHERE dedupe_key=?`).bind(body.dedupe_key).first<Row>();
    if (!row) return null;
    if (row.link_id !== linkID || row.protocol !== 1 || row.payload_hash !== payloadHash) return fail("operation_conflict");
    return reply({ id: row.id, status: row.status, replayed: true });
  };
  const previous = await existingResponse(); if (previous) return previous;
  const requestID = crypto.randomUUID();
  const result = await env.DB.prepare(`INSERT INTO evidence_requests(id,link_id,content_revision,scope,status,budget,dedupe_key,created_at,
      protocol,evidence_snapshot_id,source_hash,target_generation,url,payload_hash)
    SELECT ?,l.id,l.content_revision,'external_link','pending',?,?,?,1,?,?,?,?,?
    FROM links l JOIN evidence_snapshots s ON s.link_id=l.id AND s.content_revision=l.content_revision
    JOIN enrichment_sources src ON src.link_id=l.id
    WHERE l.id=? AND s.id=? AND s.content_hash=? AND l.content_revision=?
      AND (SELECT generation FROM classification_target_state WHERE id=1)=?
      AND EXISTS (SELECT 1 FROM json_each(json_extract(src.payload,'$.related_links')) WHERE value=?)
    ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`)
    .bind(requestID, canonicalJSON(budget), body.dedupe_key, new Date().toISOString(), body.evidence_snapshot_id,
      body.source_hash, body.target_generation, body.url, payloadHash,
      linkID, body.evidence_snapshot_id, body.source_hash, body.content_revision, body.target_generation, body.url).all();
  if (result.results.length) return reply({ id: requestID, status: "pending", replayed: false });
  return await existingResponse() ?? fail("evidence_identity_conflict");
}

export async function evidenceExecutionRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === "/api/v2/evidence-requests/recoverable" && request.method === "GET") {
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 10);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) return fail("invalid_limit", 400);
    const rows = await env.DB.prepare(`SELECT ${columns} FROM evidence_requests WHERE protocol=1
      AND (status IN ('pending','checkpointed') OR (status='fetching' AND lease_until<=?)) ORDER BY created_at,id LIMIT ?`)
      .bind(new Date().toISOString(), limit).all<Row>();
    return reply({ requests: rows.results.map(row => view(row)) });
  }
  const match = path.match(/^\/api\/v2\/evidence-requests\/([A-Za-z0-9_-]{1,64})\/(claim|checkpoint|finalize)$/);
  if (!match) return null;
  if (request.method !== "POST") return fail("method_not_allowed", 405);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return fail("invalid_json", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("invalid_json", 400);
  const row = await read(env, match[1]);
  if (!row) return fail("not_found", 404);
  if (row.protocol !== 1) return fail("unowned_legacy_request");
  if (match[2] === "claim") return claim(env, row, body);
  if (match[2] === "checkpoint") return checkpoint(env, row, body);
  return finalize(env, row, body);
}

async function claim(env: Env, row: Row, body: Record<string, unknown>): Promise<Response> {
  if (!text(body.owner_token, 100)) return fail("invalid_owner", 400);
  const now = new Date().toISOString();
  if (row.status === "fetching" && row.owner_token === body.owner_token && row.lease_until && row.lease_until > now) return reply(view(row, true));
  if (!['pending', 'fetching'].includes(row.status)) return reply(view(row));
  if (row.status === "fetching" && row.lease_until && row.lease_until > now) return reply(view(row));
  if (row.attempts >= 2) {
    await env.DB.prepare(`UPDATE evidence_requests SET status='failed',decided_at=?,result=? WHERE id=? AND status='fetching' AND lease_until<=? AND attempts>=2`)
      .bind(now, canonicalJSON({ reason: "fetch attempt budget exhausted after interrupted owner" }), row.id, now).run();
    return reply(view((await read(env, row.id))!));
  }
  const current = await env.DB.prepare(`SELECT 1 AS valid FROM links l JOIN evidence_snapshots s ON s.link_id=l.id
    WHERE l.id=? AND l.content_revision=? AND s.id=? AND s.content_hash=? AND s.content_revision=l.content_revision
      AND (SELECT generation FROM classification_target_state WHERE id=1)=?`)
    .bind(row.link_id, row.content_revision, row.evidence_snapshot_id, row.source_hash, row.target_generation).first();
  if (!current) {
    await env.DB.prepare(`UPDATE evidence_requests SET status='rejected',decided_at=?,result=? WHERE id=?
      AND (status='pending' OR (status='fetching' AND lease_until<=?))`)
      .bind(now, canonicalJSON({ reason: "stale input or target" }), row.id, now).run();
    return reply(view((await read(env, row.id))!));
  }
  const lease = new Date(Date.now() + 120000).toISOString();
  await env.DB.prepare(`UPDATE evidence_requests SET status='fetching',owner_token=?,lease_until=?,attempts=attempts+1
    WHERE id=? AND attempts<2 AND (status='pending' OR (status='fetching' AND lease_until<=?))
      AND EXISTS (SELECT 1 FROM links WHERE id=evidence_requests.link_id AND content_revision=evidence_requests.content_revision)
      AND (SELECT generation FROM classification_target_state WHERE id=1)=target_generation`)
    .bind(body.owner_token, lease, row.id, now).run();
  const stored = (await read(env, row.id))!;
  return reply(view(stored, stored.status === "fetching" && stored.owner_token === body.owner_token));
}

async function checkpoint(env: Env, row: Row, body: Record<string, unknown>): Promise<Response> {
  const outcome = body.outcome as Record<string, unknown> | null;
  if (!text(body.owner_token, 100) || !outcome || !["completed", "failed", "blocked"].includes(String(outcome.state)) ||
      (outcome.state === "completed" && (!text(outcome.text, 80000) || outcome.url !== row.url || typeof outcome.truncated !== "boolean" || new TextEncoder().encode(String(outcome.text)).length > Math.min(80000, Number(JSON.parse(row.budget).max_bytes)))) ||
      new TextEncoder().encode(canonicalJSON(outcome)).length > 100000) return fail("invalid_checkpoint", 400);
  const payloadHash = await hash(outcome);
  if (row.checkpoint_hash) return row.checkpoint_hash === payloadHash && row.owner_token === body.owner_token
    ? reply({ id: row.id, checkpoint_hash: payloadHash, replayed: true }) : fail("operation_conflict");
  const result = await env.DB.prepare(`UPDATE evidence_requests SET checkpoint=?,checkpoint_hash=?,status='checkpointed',lease_until=NULL
    WHERE id=? AND status='fetching' AND owner_token=? AND lease_until>? RETURNING id`)
    .bind(canonicalJSON(outcome), payloadHash, row.id, body.owner_token, new Date().toISOString()).all();
  if (!result.results.length) {
    const stored = (await read(env, row.id))!;
    if (stored.checkpoint_hash === payloadHash && stored.owner_token === body.owner_token) return reply({ id: row.id, checkpoint_hash: payloadHash, replayed: true });
    return fail("owner_conflict");
  }
  return reply({ id: row.id, checkpoint_hash: payloadHash, replayed: false });
}

async function finalize(env: Env, row: Row, body: Record<string, unknown>): Promise<Response> {
  if (!row.checkpoint_hash || body.checkpoint_hash !== row.checkpoint_hash) return fail("checkpoint_conflict");
  if (row.receipt) return reply(JSON.parse(row.receipt));
  if (row.status !== "checkpointed" || !row.checkpoint) return fail("checkpoint_not_ready");
  const outcome = JSON.parse(row.checkpoint) as { state: string; text?: string; url?: string; truncated?: boolean };
  let applicationReason: string | undefined;
  const now = new Date().toISOString();
  let snapshot: EvidenceSnapshot | null = null;
  let changed = false;
  let nextHash = row.source_hash;
  if (outcome.state === "completed") {
    const source = await env.DB.prepare("SELECT payload FROM evidence_snapshots WHERE id=? AND link_id=? AND content_hash=?")
      .bind(row.evidence_snapshot_id, row.link_id, row.source_hash).first<{ payload: string }>();
    if (!source) return fail("source_snapshot_missing");
    snapshot = JSON.parse(source.payload) as EvidenceSnapshot;
    // Role and URL determine whether this material is already archived; custom
    // block IDs are never treated as source roles. Every existing byte/field stays.
    const already = snapshot.blocks.some(block => block.role === "external_article" && block.url === row.url && block.text === outcome.text);
    if (!already) {
      snapshot.blocks.push({ id: `external-${row.id}`, role: "external_article", text: outcome.text!, url: row.url, acquired: "controlled_fetch" });
      if (outcome.truncated) snapshot.truncation = { ...snapshot.truncation, truncated: true };
    }
    // Objective archives intentionally omit fetched_at; do not invent or store a fetch timestamp.
    if (!validSnapshot({ ...snapshot, fetched_at: "" })) {
      outcome.state = "blocked";
      applicationReason = "appended snapshot exceeds archive limits";
    } else {
      nextHash = await contentHash(snapshot);
      changed = nextHash !== row.source_hash;
    }
  }
  const receipt = { id: row.id, status: outcome.state, changed, requeued: changed, ...(applicationReason ? { reason: applicationReason } : {}), content_revision: row.content_revision + (changed ? 1 : 0), content_hash: nextHash };
  const marker = `EXISTS (SELECT 1 FROM evidence_requests WHERE id=? AND status='applying' AND checkpoint_hash=?)`;
  const identity = `EXISTS (SELECT 1 FROM links WHERE id=evidence_requests.link_id AND content_revision=evidence_requests.content_revision)
    AND (SELECT generation FROM classification_target_state WHERE id=1)=target_generation`;
  const statements: D1PreparedStatement[] = [env.DB.prepare(`UPDATE evidence_requests SET status='applying'
    WHERE id=? AND status='checkpointed' AND checkpoint_hash=? AND ${outcome.state === "completed" ? identity : "1=1"}
      AND (?=0 OR EXISTS (SELECT 1 FROM classification_jobs WHERE link_id=evidence_requests.link_id
        AND (status<>'processing' OR lease_until<=?))) RETURNING id`)
    .bind(row.id, row.checkpoint_hash, changed ? 1 : 0, now)];
  if (changed && snapshot) {
    statements.push(env.DB.prepare(`INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,truncated,completeness,created_at)
      SELECT ?,?,?,?,?,?,? WHERE ${marker}`).bind(row.link_id, row.content_revision + 1, nextHash, objectivePayload(snapshot), snapshot.truncation.truncated ? 1 : 0, snapshotCompleteness(snapshot), now, row.id, row.checkpoint_hash));
    statements.push(env.DB.prepare(`UPDATE links SET content_revision=content_revision+1 WHERE id=? AND ${marker}`).bind(row.link_id, row.id, row.checkpoint_hash));
    statements.push(env.DB.prepare(`UPDATE classification_jobs SET status='pending',attempts=0,next_retry_at=NULL,error=NULL,result=NULL,
      lease_token=NULL,lease_until=NULL,revision=revision+1,input_revision=input_revision+1,updated_at=?
      WHERE link_id=? AND ${marker}`).bind(now, row.link_id, row.id, row.checkpoint_hash));
  }
  statements.push(env.DB.prepare(`UPDATE evidence_requests SET status=?,decided_at=?,result=?,receipt=?,lease_until=NULL
    WHERE id=? AND status='applying' AND checkpoint_hash=?`).bind(outcome.state, now, row.checkpoint, canonicalJSON(receipt), row.id, row.checkpoint_hash));
  const result = await env.DB.batch(statements);
  if (result[0].results.length) return reply(receipt);
  const latest = (await read(env, row.id))!;
  if (latest.receipt) return reply(JSON.parse(latest.receipt));
  // Stale objective input is terminal; an active competing classification is
  // transient and leaves the durable checkpoint available for the next poll.
  const staleReceipt = { id: row.id, status: "rejected", changed: false, requeued: false, reason: "stale input or target" };
  const stale = await env.DB.prepare(`UPDATE evidence_requests SET status='rejected',decided_at=?,receipt=?,result=?
    WHERE id=? AND status='checkpointed' AND NOT (${identity}) RETURNING id`)
    .bind(now, canonicalJSON(staleReceipt), row.checkpoint, row.id).all();
  return stale.results.length ? reply(staleReceipt) : fail("classification_busy");
}
