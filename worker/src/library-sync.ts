import type { Env } from "./index";
import { taxonomyWithDisplayOverrides } from "./taxonomy-routes";

type Cursor = { v: 1; epoch: string; mode: "snapshot" | "changes"; seq: number; upper: number; before: number; issued: number };
type Change = { seq: number; link_id: number | null; kind: string };
const MAX_AGE = 30 * 86400;
const encoder = new TextEncoder();
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "X-Cairn-Sync": "1" } });
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unbase64(value: string): Uint8Array { return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)); }
async function key(request: Request, env: Env): Promise<CryptoKey> {
  // Deployment origin + current authorized credential scope. Tokens are never in the cursor.
  return crypto.subtle.importKey("raw", encoder.encode(`${new URL(request.url).origin}\0${env.CAIRN_API_TOKEN.trim()}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function encode(value: Cursor, key: CryptoKey) {
  const body = base64(encoder.encode(JSON.stringify(value)));
  return `${body}.${base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))))}`;
}
async function decode(value: string, key: CryptoKey): Promise<Cursor | null> {
  try {
    if (value.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(value)) return null;
    const [body, signature] = value.split(".");
    if (!await crypto.subtle.verify("HMAC", key, unbase64(signature), encoder.encode(body))) return null;
    const c = JSON.parse(new TextDecoder().decode(unbase64(body))) as Cursor;
    if (c.v !== 1 || !["snapshot", "changes"].includes(c.mode) || typeof c.epoch !== "string" ||
      ![c.seq, c.upper, c.before, c.issued].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
    return c;
  } catch { return null; }
}

export async function maintainLibrarySync(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE library_sync_state SET floor=MAX(floor,COALESCE((SELECT MAX(seq) FROM library_sync_changes WHERE created_at<unixepoch()-?),0)) WHERE id=1").bind(MAX_AGE),
    env.DB.prepare("DELETE FROM library_sync_changes WHERE seq<=(SELECT floor FROM library_sync_state WHERE id=1)"),
  ]);
}

/** Bounded baseline + replay from its initial watermark. Never advances across an unread event. */
export async function librarySyncRoute(request: Request, env: Env,
  read: (ids: number[]) => Promise<Record<string, unknown>[]>): Promise<Response> {
  if (request.headers.get("X-Cairn-Sync") !== "1" || request.headers.get("X-Cairn-Tag-System") !== "1" || request.headers.get("X-Cairn-Content-Functions") !== "1") return reply({ error: "capability_mismatch" }, 409);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some(k => !["cursor", "limit"].includes(k) || url.searchParams.getAll(k).length !== 1)) return reply({ error: "invalid_query" }, 400);
  const limit = Number(url.searchParams.get("limit") ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return reply({ error: "invalid_limit" }, 400);
  const signingKey = await key(request, env);
  const raw = url.searchParams.get("cursor");
  let cursor = raw ? await decode(raw, signingKey) : null;
  if (raw && !cursor) return reply({ error: "invalid_cursor" }, 400);
  const meta = await env.DB.prepare(`SELECT epoch,floor,
    MAX(floor,COALESCE((SELECT MAX(seq) FROM library_sync_changes),0)) AS high,
    COALESCE((SELECT MAX(id) FROM links),0) AS upper FROM library_sync_state WHERE id=1`).first<{epoch:string;floor:number;high:number;upper:number}>();
  if (!meta) return reply({ error: "sync_unavailable" }, 503);
  const now = Math.floor(Date.now() / 1000);
  if (cursor && (cursor.epoch !== meta.epoch || cursor.seq < meta.floor || cursor.seq > meta.high || cursor.issued < now - MAX_AGE)) return reply({ error: "reset_required" }, 409);
  cursor ??= { v: 1, epoch: meta.epoch, mode: "snapshot", seq: meta.high, upper: meta.upper, before: meta.upper + 1, issued: now };
  const mode = cursor.mode;
  const anchor = cursor.seq;
  let ids: number[];
  let events: Change[] = [];
  let more: boolean;
  let taxonomyChanged = !raw;
  if (mode === "snapshot") {
    const rows = await env.DB.prepare("SELECT id FROM links WHERE id<=? AND id<? ORDER BY id DESC LIMIT ?").bind(cursor.upper, cursor.before, limit + 1).all<{id:number}>();
    ids = rows.results.slice(0, limit).map(r => r.id);
    more = rows.results.length > limit;
    cursor = { ...cursor, mode: more ? "snapshot" : "changes", before: ids.at(-1) ?? 0 };
    // A terminal baseline page must be followed by change replay, even for an empty library.
  } else {
    // Fixed upper bound from the watermark read. Later writes remain for the next request.
    const rows = await env.DB.prepare("SELECT seq,link_id,kind FROM library_sync_changes WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?").bind(cursor.seq, meta.high, limit + 1).all<Change>();
    events = rows.results.slice(0, limit);
    more = rows.results.length > limit;
    ids = [...new Set(events.map(e => e.link_id).filter((id): id is number => id !== null))];
    taxonomyChanged = events.some(e => e.kind === "taxonomy");
    cursor = { ...cursor, seq: more ? events.at(-1)!.seq : meta.high, issued: now };
  }
  const items = await read(ids);
  const present = new Set(items.map(item => item.id));
  // Current projections may be newer than the bounded event page, never older. The next
  // page replays any intervening changes; absent IDs produce an idempotent tombstone.
  const deleted = ids.filter(id => !present.has(id));
  const media = await Promise.all(items.flatMap(item => {
    const enrichment = item.enrichment as { images?: Array<{key:string}> };
    return (enrichment?.images ?? []).map(async image => {
      const object = await env.ENRICHMENT_IMAGES.head(image.key);
      return { link_id: item.id, key: image.key, version: object?.etag ?? "missing", bytes: object?.size ?? 0,
        content_type: object?.httpMetadata?.contentType ?? "", available: object !== null };
    });
  }));
  // Retention can run while the payload is being read; never acknowledge a pruned gap.
  const final = await env.DB.prepare("SELECT epoch,floor FROM library_sync_state WHERE id=1").first<{epoch:string;floor:number}>();
  if (!final || final.epoch !== meta.epoch || anchor < final.floor) return reply({ error: "reset_required" }, 409);
  return reply({ protocol_version: 1, epoch: meta.epoch, mode, items, deleted, media,
    taxonomy: taxonomyChanged || (mode === "changes" && !more) ? await taxonomyWithDisplayOverrides(env, true, true) : null,
    cursor: await encode(cursor, signingKey), has_more: mode === "snapshot" || more });
}
