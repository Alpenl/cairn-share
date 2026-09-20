import type { Env } from "./index";
import { record, taxonomy, validateClassification } from "./curation";

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const conflict = () => reply({ error: "lease_conflict" }, 409);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1 << 20) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return record(value) ? value : null;
  } catch { return null; }
}

// All routes are protected by the enricher token in index.ts.
export async function classificationRoute(request: Request, env: Env, path: string): Promise<Response> {
  const match = path.match(/^\/api\/enrichment\/classifications\/(\d+)(?:\/(complete|fail|retry))?$/);
  const id = match ? Number(match[1]) : 0;
  if (match && !match[2] && request.method === "GET") {
    const row = await env.DB.prepare(`SELECT link_id AS id, revision, status, attempts, next_retry_at,
      taxonomy_version, policy_version, requested_model, error, result, updated_at
      FROM classification_jobs WHERE link_id = ?`).bind(id).first();
    return row ? reply(row) : reply({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  const body = await bodyOf(request);
  if (!body) return reply({ error: "invalid_json" }, 400);
  const now = new Date().toISOString();
  if (path === "/api/enrichment/classifications/claim") {
    if (body.taxonomy_version !== taxonomy.version || !text(body.policy_version, 100) || !text(body.model, 200)) {
      return reply({ error: "invalid_classification_config" }, 400);
    }
    const token = crypto.randomUUID();
    const until = new Date(Date.now() + 15 * 60_000).toISOString();
    await env.DB.prepare(`UPDATE classification_jobs SET status='exhausted', lease_token=NULL, lease_until=NULL,
      error='classification lease expired', updated_at=? WHERE status='processing' AND lease_until<=? AND attempts>=5`)
      .bind(now, now).run();
    const job = await env.DB.prepare(`UPDATE classification_jobs SET status='processing',
      attempts=CASE WHEN taxonomy_version<>? OR policy_version<>? OR requested_model<>? THEN 1 ELSE attempts+1 END,
      lease_token=?, lease_until=?, next_retry_at=NULL, error=NULL,
      taxonomy_version=?, policy_version=?, requested_model=?, updated_at=?
      WHERE link_id=(SELECT j.link_id FROM classification_jobs j JOIN links l ON l.id=j.link_id
        WHERE COALESCE(l.original_text,'')<>'' AND l.curation_status<>'drop'
        AND (j.status<>'processing' OR j.lease_until<=?)
        AND ((j.attempts<5 AND (j.status='pending' OR (j.status='failed' AND j.next_retry_at<=?)
          OR (j.status='processing' AND j.lease_until<=?)))
          OR j.taxonomy_version<>? OR j.policy_version<>? OR j.requested_model<>?)
        ORDER BY COALESCE(j.updated_at,''), j.link_id LIMIT 1)
      RETURNING link_id AS id, revision, attempts AS attempt, lease_token, lease_until`)
      .bind(taxonomy.version, body.policy_version, body.model, token, until,
        taxonomy.version, body.policy_version, body.model, now, now, now, now,
        taxonomy.version, body.policy_version, body.model).first<{ id: number; revision: number }>();
    if (!job) return new Response(null, { status: 204, headers });
    const source = await env.DB.prepare(`SELECT l.url,l.note,l.original_text,
      CASE WHEN s.original_text=l.original_text AND s.url=l.url THEN COALESCE(json_extract(s.payload,'$.context_text'),'') ELSE '' END AS context_text
      FROM links l LEFT JOIN enrichment_sources s ON s.link_id=l.id
      JOIN classification_jobs j ON j.link_id=l.id
      WHERE l.id=? AND j.lease_token=? AND j.revision=?`).bind(job.id, token, job.revision).first();
    return source ? reply({ ...job, ...source }) : conflict();
  }
  if (!match) return reply({ error: "not_found" }, 404);
  if (match[2] === "retry") {
    const row = await env.DB.prepare(`INSERT INTO classification_jobs(link_id)
      SELECT id FROM links WHERE id=? AND COALESCE(original_text,'')<>''
      ON CONFLICT(link_id) DO UPDATE SET status='pending',attempts=0,next_retry_at=NULL,
        lease_token=NULL,lease_until=NULL,error=NULL,revision=revision+1
        WHERE classification_jobs.status<>'processing' OR classification_jobs.lease_until<=?
      RETURNING link_id`).bind(id, now).first();
    return row ? reply({ id, status: "pending" }) : conflict();
  }
  if (!text(body.lease_token, 100) || !Number.isSafeInteger(body.revision)) return reply({ error: "invalid_classification" }, 400);
  if (match[2] === "complete") {
    if (!record(body.result)) return reply({ error: "invalid_classification" }, 400);
    const result = body.result;
    const classification = validateClassification(result.classification);
    if (!classification || !text(result.model, 200) || !text(result.policy_version, 100) || !record(result.answers)) {
      return reply({ error: "invalid_classification" }, 400);
    }
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE links SET classification=? WHERE id=? AND EXISTS(
        SELECT 1 FROM classification_jobs WHERE link_id=? AND status='processing' AND lease_token=?
        AND revision=? AND lease_until>? AND policy_version=? AND taxonomy_version=?) RETURNING id`)
        .bind(JSON.stringify(classification), id, id, body.lease_token, body.revision, now, result.policy_version, taxonomy.version),
      env.DB.prepare(`UPDATE classification_jobs SET status='completed',result=?,error=NULL,
        lease_token=NULL,lease_until=NULL,updated_at=? WHERE link_id=? AND status='processing'
        AND lease_token=? AND revision=? AND lease_until>? AND policy_version=? AND taxonomy_version=? RETURNING link_id`)
        .bind(JSON.stringify({ ...result, classification }), now, id, body.lease_token, body.revision, now, result.policy_version, taxonomy.version)
    ]);
    return results[0].results.length ? reply({ id, status: "completed" }) : conflict();
  }
  if (match[2] === "fail") {
    if (!text(body.error, 1800)) return reply({ error: "invalid_classification" }, 400);
    const current = await env.DB.prepare(`SELECT attempts FROM classification_jobs WHERE link_id=?
      AND status='processing' AND lease_token=? AND revision=? AND lease_until>?`)
      .bind(id, body.lease_token, body.revision, now).first<{ attempts: number }>();
    if (!current) return conflict();
    const status = current.attempts >= 5 ? "exhausted" : "failed";
    const delay = [60_000, 300_000, 1800_000, 7200_000][Math.min(current.attempts - 1, 3)];
    const retry = status === "exhausted" ? null : new Date(Date.now() + delay).toISOString();
    const row = await env.DB.prepare(`UPDATE classification_jobs SET status=?,error=?,next_retry_at=?,
      lease_token=NULL,lease_until=NULL,updated_at=? WHERE link_id=? AND status='processing'
      AND lease_token=? AND revision=? AND lease_until>? RETURNING link_id`)
      .bind(status, body.error, retry, now, id, body.lease_token, body.revision, now).first();
    return row ? reply({ id, status }) : conflict();
  }
  return reply({ error: "not_found" }, 404);
}

export async function sourceRoute(request: Request, env: Env, id: number): Promise<Response> {
  if (request.method === "GET") {
    const row = await env.DB.prepare(`SELECT s.payload FROM enrichment_sources s JOIN links l ON l.id=s.link_id
      WHERE l.id=? AND s.url=l.url AND s.original_text=l.original_text`).bind(id).first<{ payload: string }>();
    return row ? new Response(row.payload, { headers }) : new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  const body = await bodyOf(request);
  if (!body || !text(body.lease_token, 100) || !record(body.source)) return reply({ error: "invalid_source" }, 400);
  const source = body.source;
  if (!text(source.original_text, 100_000) || !text(source.model, 200) ||
    typeof source.original_language !== "string" || source.original_language.length > 32 ||
    typeof source.context_text !== "string" || source.context_text.length > 100_000 ||
    !Array.isArray(source.related_links) || source.related_links.length > 50 ||
    !source.related_links.every((v) => safeURL(v, false)) ||
    !Array.isArray(source.image_urls) || source.image_urls.length > 8 || !source.image_urls.every((v) => safeURL(v, true))) {
    return reply({ error: "invalid_source" }, 400);
  }
  const now = new Date().toISOString();
  const guard = "id=? AND enrichment_status='processing' AND enrichment_lease_token=? AND enrichment_lease_until>?";
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE links SET original_text=?,original_language=?,related_links=?,
      ai_title=NULL,translated_text=NULL,summary=NULL,images=CASE WHEN original_text IS ? THEN images ELSE '[]' END,
      enrichment_updated_at=? WHERE ${guard} RETURNING id`)
      .bind(source.original_text, source.original_language || null, JSON.stringify(source.related_links), source.original_text, now, id, body.lease_token, now),
    env.DB.prepare(`INSERT INTO enrichment_sources(link_id,url,original_text,payload,fetched_at)
      SELECT id,url,?,?,? FROM links WHERE ${guard}
      ON CONFLICT(link_id) DO UPDATE SET url=excluded.url,original_text=excluded.original_text,
        payload=excluded.payload,fetched_at=excluded.fetched_at`)
      .bind(source.original_text, JSON.stringify(source), now, id, body.lease_token, now)
  ]);
  return results[0].results.length ? reply({ id, status: "source_saved" }) : conflict();
}

function safeURL(value: unknown, image: boolean): boolean {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && (image
      ? url.protocol === "https:" && url.hostname === "pbs.twimg.com" && !url.port && url.pathname.startsWith("/media/")
      : ["http:", "https:"].includes(url.protocol));
  } catch { return false; }
}
