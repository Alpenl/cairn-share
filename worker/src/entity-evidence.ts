import { validBlock } from "./domain";
import type { Env } from "./index";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Cairn-Entity-Evidence": "1",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const fail = (error: string, status: number) => reply({ error }, status);
const contextCodePoints = 480;
const fields = ["snapshot_id", "content_revision", "block_id", "start", "end"];

function integer(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Only immutable stored material is readable here; this route never retrieves or judges content. */
export async function entityEvidenceRoute(request: Request, env: Env, id: number): Promise<Response> {
  if (request.method !== "GET") return fail("method_not_allowed", 405);
  if (!Number.isSafeInteger(id) || id < 1) return fail("invalid_id", 400);
  const query = new URL(request.url).searchParams;
  if (Array.from(query.keys()).some(key => !fields.includes(key)) ||
      fields.some(key => query.getAll(key).length !== 1)) return fail("invalid_evidence_reference", 400);
  const snapshot = integer(query.get("snapshot_id"));
  const revision = integer(query.get("content_revision"));
  const start = integer(query.get("start"));
  const end = integer(query.get("end"));
  const blockID = query.get("block_id")!;
  if (snapshot === null || snapshot < 1 || revision === null || revision < 1 ||
      start === null || end === null || end <= start || end > 100_000 || end - start > 2048 ||
      blockID.length === 0 || blockID.length > 64) return fail("invalid_evidence_reference", 400);

  // Read the selected block instead of transporting every snapshot block into
  // the Worker. The snapshot and its owning, still-existing bookmark are bound
  // in the same statement. Never substitute the latest snapshot on a miss.
  const row = await env.DB.prepare(`SELECT s.id, s.content_revision, s.content_hash,
      s.truncated, s.completeness, l.content_revision AS current_revision,
      (SELECT b.value FROM json_each(s.payload, '$.blocks') b
       WHERE b.type = 'object' AND json_extract(b.value, '$.id') = ? LIMIT 1) AS block
    FROM evidence_snapshots s JOIN links l ON l.id = s.link_id
    WHERE s.id = ? AND s.link_id = ?`).bind(blockID, snapshot, id)
    .first<{ id: number; content_revision: number; content_hash: string; truncated: number;
      completeness: string; current_revision: number; block: string | null }>();
  if (!row) return fail("evidence_unavailable", 404);
  if (row.content_revision !== revision) return fail("evidence_reference_changed", 409);
  if (row.block === null) return fail("evidence_unavailable", 404);
  let block: unknown;
  try { block = JSON.parse(row.block); }
  catch { return fail("evidence_material_invalid", 500); }
  if (!validBlock(block)) return fail("evidence_material_invalid", 500);
  const text = Array.from(block.text);
  if (end > text.length) return fail("invalid_evidence_span", 400);
  const left = Math.max(0, start - contextCodePoints);
  const right = Math.min(text.length, end + contextCodePoints);
  return reply({
    version: 1, bookmark_id: id, evidence_snapshot_id: row.id,
    content_revision: row.content_revision, content_hash: row.content_hash,
    current: row.content_revision === row.current_revision, block_id: block.id, role: block.role,
    span_start: start, span_end: end, context_start: left,
    before: text.slice(left, start).join(""), quote: text.slice(start, end).join(""),
    after: text.slice(end, right).join(""), clipped_before: left > 0, clipped_after: right < text.length,
    truncated: row.truncated === 1, completeness: row.completeness,
  });
}
