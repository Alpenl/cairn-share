import type { Env } from './index';

// Identity is separate from the saved URL. Never strip arbitrary query values:
// they can identify different articles, files, revisions or application routes.
export function urlIdentity(value: string): string {
  const u = new URL(value);
  if (u.hostname === 'mp.weixin.qq.com') {
    if (/^\/s\/[A-Za-z0-9_-]+\/?$/.test(u.pathname))
      return `https://mp.weixin.qq.com${u.pathname.replace(/\/$/, '')}`;
    if (u.pathname === '/s' && ['__biz', 'mid', 'idx'].every(k => u.searchParams.get(k))) {
      const q = new URLSearchParams();
      for (const k of ['__biz', 'mid', 'idx']) q.set(k, u.searchParams.get(k)!);
      return `https://mp.weixin.qq.com/s?${q}`;
    }
  }
  if (/^(www\.|mobile\.)?(x|twitter)\.com$/.test(u.hostname)) {
    const id = u.pathname.match(/^\/(?:[^/]+\/status|i\/web\/status)\/(\+?\d+)(?:\/|$)/)?.[1];
    if (id) return `https://x.com/i/web/status/${id}`;
  }
  for (const k of [...u.searchParams.keys()])
    if (/^utm_/i.test(k) || ['fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid'].includes(k.toLowerCase())) u.searchParams.delete(k);
  // Preserve hash-router routes, but ordinary in-document anchors are not articles.
  if (!/^#(?:!|\/)/.test(u.hash)) u.hash = '';
  return u.href;
}

export async function resolveURLIdentity(env: Env, value: string): Promise<string> {
  const identity = urlIdentity(value);
  // Incremental legacy backfill. Each page is bounded; this only runs until all
  // pre-upgrade/old-client rows have their identity, without changing content.
  for (let page = 0; page < 20; page++) {
    const rows = await env.DB.prepare('SELECT id,url FROM links WHERE url_identity IS NULL ORDER BY id LIMIT 100').all<{id:number;url:string}>();
    if (!rows.results.length) return identity;
    await env.DB.batch(rows.results.map(row => {
      let key = row.url;
      try { key = urlIdentity(row.url); } catch { /* Keep malformed legacy URLs distinct. */ }
      return env.DB.prepare('UPDATE links SET url_identity=? WHERE id=? AND url=? AND url_identity IS NULL').bind(key,row.id,row.url);
    }));
  }
  throw new Error('url_identity_backfill_in_progress');
}
