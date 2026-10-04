import type { Env } from './index';
import { readBoundedJSON, JSONBodyError } from './json-body';
import { canonicalJSON, contentHash, objectivePayload, type EvidenceSnapshot } from './domain';
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
export async function digest(value: string | Uint8Array): Promise<string> {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeURL(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 8192)
        return false;
    try {
        const u = new URL(value);
        return /^https?:$/.test(u.protocol) && !u.username && !u.password;
    }
    catch {
        return false;
    }
}
export async function browserCapture(request: Request, env: Env): Promise<Response> {
    let body;
    try {
        body = await readBoundedJSON(request, 7 * 1024 * 1024) as Record<string, any>;
    }
    catch (e) {
        return reply({ error: e instanceof JSONBodyError ? e.code : 'invalid_json' }, 400);
    }
    const c = body?.capture;
    if (!safeURL(body?.url) || typeof body.note !== 'string' || body.note.length > 2000 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.client_id) ||
        !c || typeof c.text !== 'string' || !c.text.trim() || new TextEncoder().encode(c.text).length > 100000 ||
        typeof c.title !== 'string' || c.title.length > 300 || typeof c.language !== 'string' || c.language.length > 32 ||
        !Array.isArray(c.images) || c.images.length > 24)
        return reply({ error: 'invalid_capture' }, 400);
    const assets: {
        bytes: Uint8Array;
        content_type: string;
        suffix: string;
        hash: string;
    }[] = [];
    let total = 0;
    for (const image of c.images) {
        const suffix = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' } as Record<string, string>)[image?.content_type];
        if (!suffix || typeof image.data !== 'string' || image.data.length > 1400000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data))
            return reply({ error: 'invalid_capture' }, 400);
        let bytes: Uint8Array;
        try {
            bytes = Uint8Array.from(atob(image.data), x => x.charCodeAt(0));
        }
        catch {
            return reply({ error: 'invalid_capture' }, 400);
        }
        total += bytes.length;
        if (bytes.length === 0 || total > 4200000)
            return reply({ error: 'invalid_capture' }, 400);
        assets.push({ bytes, content_type: image.content_type, suffix, hash: await digest(bytes) });
    }
    const hash = await digest(canonicalJSON(body));
    const now = new Date().toISOString();
    const old = await env.DB.prepare('SELECT * FROM browser_captures WHERE client_id=?').bind(body.client_id).first<{
        link_id: number;
        payload_hash: string;
        completed: number;
    }>();
    if (old && !await env.DB.prepare('SELECT id FROM links WHERE id=?').bind(old.link_id).first())
        return reply({ error: 'capture_deleted' }, 410);
    if (old && old.payload_hash !== hash)
        return reply({ error: 'capture_conflict' }, 409);
    if (!old) {
        if (await env.DB.prepare('SELECT id FROM links WHERE client_id=?').bind(body.client_id).first())
            return reply({ error: 'capture_conflict' }, 409);
        // The reservation is not claimable by source retrieval until all browser assets are durable.
        await env.DB.batch([
            env.DB.prepare(`INSERT INTO links(url,note,created_at,client_id,enrichment_status) VALUES(?,?,?,?,'completed') ON CONFLICT(client_id) DO NOTHING`).bind(body.url, body.note, now, body.client_id),
            env.DB.prepare(`INSERT INTO browser_captures(client_id,link_id,payload_hash,created_at) SELECT ?,id,?,? FROM links WHERE client_id=? ON CONFLICT(client_id) DO NOTHING`).bind(body.client_id, hash, now, body.client_id)
        ]);
    }
    const receipt = await env.DB.prepare('SELECT * FROM browser_captures WHERE client_id=?').bind(body.client_id).first<{
        link_id: number;
        payload_hash: string;
        completed: number;
    }>();
    if (!receipt || receipt.payload_hash !== hash)
        return reply({ error: 'capture_conflict' }, 409);
    const id = receipt.link_id;
    const getLink = () => env.DB.prepare('SELECT id,url,note,created_at,learned,learned_at FROM links WHERE id=?').bind(id).first<Record<string, unknown>>();
    if (!await getLink())
        return reply({ error: 'capture_deleted' }, 410);
    if (!receipt.completed) {
        const current = await env.DB.prepare('SELECT original_text,url FROM links WHERE id=?').bind(id).first<{
            original_text: string | null;
            url: string;
        }>();
        if (current?.original_text || current?.url !== body.url)
            return reply({ error: 'capture_conflict' }, 409);
        const refs = [];
        for (const asset of assets) {
            const key = `enrichment/${id}/${asset.hash}.${asset.suffix}`;
            await env.ENRICHMENT_IMAGES.put(key, asset.bytes, { httpMetadata: { contentType: asset.content_type } });
            refs.push({ key, content_type: asset.content_type });
        }
        const source = { original_text: c.text, model: 'browser_capture', original_language: c.language || 'und', context_text: '', related_links: [], image_urls: [] };
        const evidence: EvidenceSnapshot = { blocks: [{ id: 'primary', role: 'primary', text: c.text, url: body.url, acquired: 'browser_dom' }], fetched_at: now, retrieval: 'browser_capture', truncation: { truncated: c.truncated === true, ...(c.truncated === true ? { reason: 'browser_capture_limit' } : {}) } };
        const evidenceHash = await contentHash(evidence);
        const guard = `EXISTS(SELECT 1 FROM browser_captures b WHERE b.link_id=links.id AND b.client_id=? AND b.completed=0) AND links.url=?`;
        await env.DB.batch([
            env.DB.prepare(`UPDATE links SET original_text=?,original_language=?,ai_title=?,images=?,related_links='[]',enrichment_status='pending',enrichment_updated_at=? WHERE id=? AND ${guard} AND original_text IS NULL`)
                .bind(c.text, c.language || 'und', c.title, JSON.stringify(refs), now, id, body.client_id, body.url),
            env.DB.prepare(`INSERT INTO enrichment_sources(link_id,url,original_text,payload,fetched_at) SELECT id,url,original_text,?,? FROM links WHERE id=? AND ${guard} AND original_text=? ON CONFLICT(link_id) DO NOTHING`)
                .bind(JSON.stringify(source), now, id, body.client_id, body.url, c.text),
            env.DB.prepare(`INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,truncated,completeness,created_at) SELECT id,content_revision,?,?,?,?,? FROM links WHERE id=? AND ${guard} AND original_text=? ON CONFLICT(link_id,content_revision) DO NOTHING`)
                .bind(evidenceHash, objectivePayload(evidence), c.truncated === true ? 1 : 0, c.truncated === true ? 'truncated' : 'complete', now, id, body.client_id, body.url, c.text),
            env.DB.prepare('UPDATE browser_captures SET completed=1 WHERE client_id=? AND EXISTS(SELECT 1 FROM links WHERE id=link_id AND original_text=? AND url=?)').bind(body.client_id, c.text, body.url)
        ]);
        if (!await getLink()) {
            await Promise.all(refs.map(ref => env.ENRICHMENT_IMAGES.delete(ref.key)));
            return reply({ error: 'capture_deleted' }, 410);
        }
        const done = await env.DB.prepare('SELECT completed FROM browser_captures WHERE client_id=?').bind(body.client_id).first('completed');
        if (!done)
            return reply({ error: 'capture_conflict' }, 409);
    }
    const link = await getLink();
    if (!link)
        return reply({ error: 'capture_deleted' }, 410);
    return reply({ ...link, learned: link.learned === 1 }, 201);
}
