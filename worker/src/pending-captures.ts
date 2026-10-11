import type { Env } from './index';

const reply = (body: unknown, status = 200) => Response.json(body, {status, headers: {'Cache-Control': 'private, no-store'}});
export const MISSING_CAPTURE_SQL = "(original_text IS NULL OR original_text='') AND curation_status<>'drop'";

// A bounded ID snapshot: new mobile bookmarks belong to the next batch, while
// bookmarks filled/deleted during this batch disappear from subsequent pages.
export async function pendingCaptures(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== 'GET') return reply({error:'method_not_allowed'},405);
  const url = new URL(request.url);
  const id = path.match(/^\/api\/captures\/v2\/pending\/(\d+)$/)?.[1];
  const columns = 'id,url,ai_title AS title,content_revision,app_body_revision';
  if (id) {
    const item = await env.DB.prepare(`SELECT ${columns} FROM links WHERE id=? AND ${MISSING_CAPTURE_SQL}`).bind(Number(id)).first();
    return reply({batch_version:1,item});
  }
  if (path !== '/api/captures/v2/pending') return reply({error:'not_found'},404);
  const number = (key: string, fallback: number) => url.searchParams.has(key) ? Number(url.searchParams.get(key)) : fallback;
  const after = number('after',0);
  const upper = url.searchParams.has('upper') ? number('upper',0) : Number(await env.DB.prepare('SELECT coalesce(max(id),0) AS id FROM links').first('id'));
  if (![after,upper].every(n => Number.isSafeInteger(n) && n >= 0) || after > upper) return reply({error:'invalid_cursor'},400);
  const rows = await env.DB.prepare(`SELECT ${columns} FROM links WHERE id>? AND id<=? AND ${MISSING_CAPTURE_SQL} ORDER BY id LIMIT 101`).bind(after,upper).all<{id:number}>();
  const items = rows.results.slice(0,100);
  return reply({batch_version:1,items,upper,next_after:rows.results.length>100 ? items.at(-1)!.id : null});
}
