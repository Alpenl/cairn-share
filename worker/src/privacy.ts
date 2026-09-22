import { pruneEntityCache } from "./entity-cache";
import { pruneRerankCache } from "./rerank-cache";
// Durable R2 deletion after the D1 transaction. All work is bounded per tick.
// Retained numeric tombstones also cover a Worker dying during a late R2 put.
export interface PrivacyEnv { DB: D1Database; ENRICHMENT_IMAGES: R2Bucket }
const RETRY_MS = 5 * 60_000;
const RECHECK_MS = 24 * 60 * 60_000;

export async function cleanupDeletedImages(env: PrivacyEnv, id: number, now = Date.now()): Promise<boolean> {
  const receipt = await env.DB.prepare("SELECT link_id FROM privacy_deletions WHERE link_id=? AND NOT EXISTS (SELECT 1 FROM links WHERE id=?)")
    .bind(id, id).first();
  if (!receipt) return false;
  let complete = false;
  try {
    // Always restart at the prefix, so deleting a page cannot invalidate a cursor.
    // R2 may return fewer than limit even when truncated; never infer EOF by count.
    for (let page = 0; page < 4; page++) {
      const objects = await env.ENRICHMENT_IMAGES.list({ prefix: `enrichment/${id}/`, limit: 100 });
      if (objects.objects.length) await env.ENRICHMENT_IMAGES.delete(objects.objects.map(o => o.key));
      if (!objects.truncated) { complete = true; break; }
    }
  } catch { /* durable receipt remains; do not log content, keys, URLs or errors */ }
  await env.DB.prepare("UPDATE privacy_deletions SET next_cleanup_at=? WHERE link_id=?")
    .bind(new Date(now + (complete ? RECHECK_MS : RETRY_MS)).toISOString(), id).run();
  return complete;
}

export async function maintainPrivacy(env: PrivacyEnv, now = Date.now()): Promise<void> {
  await pruneRerankCache(env);
  await pruneEntityCache(env);
  const due = await env.DB.prepare("SELECT link_id FROM privacy_deletions WHERE next_cleanup_at<=? AND NOT EXISTS (SELECT 1 FROM links WHERE id=privacy_deletions.link_id) ORDER BY next_cleanup_at,link_id LIMIT 20")
    .bind(new Date(now).toISOString()).all<{link_id:number}>();
  for (const row of due.results) await cleanupDeletedImages(env, row.link_id, now);
  // Also discover orphan objects left by versions that did not create receipts.
  // Advance one bounded page per tick and wrap at EOF, so late writes are revisited.
  const cursor = await env.DB.prepare("SELECT cursor FROM privacy_maintenance_state WHERE key='r2_orphans'").first<string>("cursor");
  const page = await env.ENRICHMENT_IMAGES.list({prefix:"enrichment/",limit:100, ...(cursor ? {cursor} : {})});
  const ids = new Set<number>();
  for (const object of page.objects) {
    const match = /^enrichment\/([1-9]\d*)\//.exec(object.key);
    const id = match ? Number(match[1]) : NaN;
    if (Number.isSafeInteger(id)) ids.add(id);
  }
  for (const id of ids) {
    await env.DB.prepare(`INSERT OR IGNORE INTO privacy_deletions(link_id,deleted_at,next_cleanup_at)
      SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM links WHERE id=?)`)
      .bind(id,new Date(now).toISOString(),new Date(now).toISOString(),id).run();
  }
  await env.DB.prepare("INSERT INTO privacy_maintenance_state(key,cursor) VALUES ('r2_orphans',?) ON CONFLICT(key) DO UPDATE SET cursor=excluded.cursor")
    .bind(page.truncated ? page.cursor : "").run();
}
