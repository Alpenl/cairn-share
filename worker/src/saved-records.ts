import type { Env } from "./index";

export type SavedRecordKind = "sources" | "entities" | "overrides" | "events";
const capability = "X-Cairn-App-Saved-Records";
const positive = (value: string | null) => value !== null && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
const operationKey = (value: string | null) => value !== null && value.trim().length > 0 && value.length <= 200;

/** Saved rows only: no projection rebuild, inference, source retrieval or writes.
 * Entity receipts are scoped to one immutable source, using its existing index;
 * their keys are opaque and sorted in SQLite binary order, not by model time.
 */
export async function savedRecordsRoute(request: Request, env: Env, id: number, kind: SavedRecordKind): Promise<Response> {
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", [capability]: "1" } });
  if (request.method !== "GET") return respond({ error: "method_not_allowed" }, 405);
  if (request.headers.get(capability) !== "1") return respond({ error: "capability_mismatch" }, 409);
  if (!Number.isSafeInteger(id) || id < 1) return respond({ error: "invalid_id" }, 400);
  const params = new URL(request.url).searchParams;
  const source = params.get("source_revision"), key = params.get("record_key"), after = params.get("after_key");
  if ([...params.keys()].some(k => !["source_revision", "record_key", "after_key"].includes(k) || params.getAll(k).length !== 1) ||
    params.has("record_key") && params.has("after_key") ||
    (kind === "entities" ? !positive(source) : params.has("source_revision")) ||
    [key, after].some(v => v !== null && !(kind === "entities" ? operationKey(v) : positive(v))))
    return respond({ error: "invalid_query" }, 400);
  if (!await env.DB.prepare("SELECT id FROM links WHERE id=?").bind(id).first())
    return respond({ error: "saved_record_unavailable" }, 404);

  // Numeric identities are immutable content revisions or AUTOINCREMENT IDs.
  // Keep payloads out of pages; at most one full payload is read on selection.
  const schemas = {
    sources: { table: "evidence_snapshots", identity: "content_revision",
      summary: "id AS snapshot_id,content_revision,content_hash,truncated,completeness,created_at", detail: "payload" },
    overrides: { table: "curation_overrides", identity: "id",
      summary: "field,action,source,confirmed,revision,created_at", detail: "term,operation_key,payload_hash" },
    events: { table: "curation_events", identity: "id",
      summary: "kind AS action,revision,created_at", detail: "payload,operation_key" },
  } as const;
  const envelope = { version: 1, bookmark_id: id, kind, source_revision: source === null ? null : Number(source) };
  let rows: Record<string, unknown>[];
  if (kind === "entities") {
    // Absence may be retention or an old unbound result, never proof of not_run.
    const snapshot = await env.DB.prepare("SELECT id FROM evidence_snapshots WHERE link_id=? AND content_revision=?")
      .bind(id, Number(source)).first<{ id: number }>();
    if (!snapshot) return respond({ error: "saved_record_unavailable" }, 404);
    const selected = `e.operation_key AS key,e.content_revision,e.evidence_snapshot_id,e.content_hash,e.outcome,e.applied,e.created_at,
      CASE WHEN json_valid(e.payload) THEN CASE WHEN json_type(e.payload,'$.state')='text'
        THEN json_extract(e.payload,'$.state') END END AS state`;
    const result = await env.DB.prepare(`SELECT ${selected}${key === null ? "" : ",e.payload,e.request_hash"}
      FROM entity_operations e WHERE e.evidence_snapshot_id=? AND e.link_id=?
      ${key !== null ? "AND e.operation_key=?" : after !== null ? "AND e.operation_key<?" : ""}
      ORDER BY e.operation_key DESC LIMIT ?`).bind(snapshot.id, id, ...(key !== null ? [key] : after !== null ? [after] : []), key === null ? 51 : 1).all<Record<string, unknown>>();
    rows = result.results;
  } else {
    const schema = schemas[kind];
    const result = await env.DB.prepare(`SELECT CAST(${schema.identity} AS TEXT) AS key,${schema.summary}${key === null ? "" : `,${schema.detail}`}
      FROM ${schema.table} WHERE link_id=? ${key !== null ? `AND ${schema.identity}=?` : after !== null ? `AND ${schema.identity}<?` : ""}
      ORDER BY ${schema.identity} DESC LIMIT ?`).bind(id, ...(key !== null ? [Number(key)] : after !== null ? [Number(after)] : []), key === null ? 51 : 1).all<Record<string, unknown>>();
    rows = result.results;
  }
  let value: unknown;
  if (key !== null) {
    if (!rows.length) return respond({ error: "saved_record_unavailable" }, 404);
    const row = rows[0];
    if ("payload" in row) {
      // Never substitute {} for corrupt/missing historical material.
      try { row.payload = JSON.parse(row.payload as string); }
      catch { return respond({ error: "saved_record_corrupt" }, 503); }
    }
    value = { ...envelope, record: row };
  } else {
    const page = rows.slice(0, 50);
    value = { ...envelope, records: page, next_after: rows.length > 50 ? page[page.length - 1].key : null };
  }
  const encoded = JSON.stringify(value), limit = key === null ? 128 << 10 : kind === "sources" ? 10 << 20 : 2 << 20;
  if (new TextEncoder().encode(encoded).length > limit) return respond({ error: "saved_record_too_large" }, 413);
  return new Response(encoded, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", [capability]: "1" } });
}
