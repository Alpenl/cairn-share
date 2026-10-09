import type { Env } from './index';
import { readBoundedJSON, JSONBodyError } from './json-body';
import { canonicalJSON, contentHash, objectivePayload, type EvidenceSnapshot } from './domain';
import { resolveURLIdentity } from './url-identity';
import { registerMedia, validMediaDeclarations } from './archived-media';
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
export async function browserCapture(request: Request, env: Env, staged = false): Promise<Response> {
    let body;
    try {
        body = await readBoundedJSON(request, staged ? 400000 : 7 * 1024 * 1024) as Record<string, any>;
    }
    catch (e) {
        return reply({ error: e instanceof JSONBodyError ? e.code : 'invalid_json' }, 400);
    }
    const c = body?.capture;
    if (!safeURL(body?.url) || typeof body.note !== 'string' || body.note.length > 2000 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.client_id) ||
        !c || typeof c.text !== 'string' || !c.text.trim() || new TextEncoder().encode(c.text).length > 100000 ||
        typeof c.title !== 'string' || c.title.length > 300 || typeof c.language !== 'string' || c.language.length > 32 ||
        !Array.isArray(c.images) || c.images.length > 24 || !validMediaDeclarations(c.media))
        return reply({ error: 'invalid_capture' }, 400);
    const assets: {
        bytes: Uint8Array;
        content_type: string;
        suffix: string;
        hash: string;
    }[] = [];
    let total = 0;
    if (staged && (c.images.some((image: any) => !image || typeof image.url !== 'string' || image.url.length > 8192 || (image.url && !safeURL(image.url))) ||
        (body.legacy_hash !== undefined && !/^[a-f0-9]{64}$/.test(body.legacy_hash)))) return reply({error:'invalid_capture'},400);
    for (const image of staged ? [] : c.images) {
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
    const manifestHash = await digest(canonicalJSON(body));
    const hash = staged && body.legacy_hash ? body.legacy_hash : manifestHash;
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
        const identity = await resolveURLIdentity(env, body.url);
        // Both the existence check and insert run in SQLite, so simultaneous
        // captures cannot create two bookmarks. Existing notes/IDs stay intact.
        await env.DB.batch([
            env.DB.prepare(`INSERT INTO links(url,note,created_at,client_id,enrichment_status,url_identity,enrichment_next_retry_at)
              SELECT ?,?,?,?,'pending',?,'9999-12-31T00:00:00Z' WHERE NOT EXISTS(SELECT 1 FROM links WHERE url_identity=?)
              ON CONFLICT(client_id) DO NOTHING`).bind(body.url, body.note, now, body.client_id, identity, identity),
            env.DB.prepare(`INSERT INTO browser_captures(client_id,link_id,payload_hash,created_at,expected_revision,expected_body_revision,was_existing)
              SELECT ?,id,?,?,content_revision,app_body_revision,CASE WHEN client_id IS ? THEN 0 ELSE 1 END
              FROM links WHERE url_identity=? ORDER BY id LIMIT 1 ON CONFLICT(client_id) DO NOTHING`).bind(body.client_id, hash, now, body.client_id, identity)
        ]);
    }
    const receipt = await env.DB.prepare('SELECT * FROM browser_captures WHERE client_id=?').bind(body.client_id).first<{
        link_id: number;
        payload_hash: string;
        completed: number;
        expected_revision: number;
        expected_body_revision: number;
        was_existing: number;
    }>();
    if (!receipt || receipt.payload_hash !== hash)
        return reply({ error: 'capture_conflict' }, 409);
    const id = receipt.link_id;
    if (staged) {
        await env.DB.prepare('INSERT INTO capture_upload_sessions(client_id,manifest_hash,request_json) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM links WHERE id=?) ON CONFLICT(client_id) DO NOTHING').bind(body.client_id,manifestHash,JSON.stringify(body),id).run();
        const session = await env.DB.prepare('SELECT manifest_hash FROM capture_upload_sessions WHERE client_id=?').bind(body.client_id).first('manifest_hash');
        if (session !== manifestHash) return reply({error:'capture_conflict'},409);
    }
    const getLink = () => env.DB.prepare('SELECT id,url,note,created_at,learned,learned_at FROM links WHERE id=?').bind(id).first<Record<string, unknown>>();
    if (!await getLink())
        return reply({ error: 'capture_deleted' }, 410);
    if (!receipt.completed) {
        const current = await env.DB.prepare('SELECT original_text,images,url,content_revision,app_body_revision FROM links WHERE id=?').bind(id).first<{
            original_text: string | null;
            images: string | null;
            url: string;
            content_revision: number;
            app_body_revision: number;
        }>();
        if (!current || current.content_revision !== receipt.expected_revision || current.app_body_revision !== receipt.expected_body_revision)
            return reply({ error: 'capture_conflict' }, 409);
        if (Number(c.missing_images)>0 && current.images && current.images!=='[]') return reply({error:'capture_images_incomplete'},409);
        const refs: {key:string;content_type:string}[] = [];
        if (staged) for (let ordinal=0;ordinal<c.images.length;ordinal++) {
            refs.push({key:`enrichment/${id}/${await digest(body.client_id+':image:'+ordinal)}.jpg`,content_type:'image/jpeg'});
        }
        for (const asset of assets) {
            const key = `enrichment/${id}/${asset.hash}.${asset.suffix}`;
            await env.ENRICHMENT_IMAGES.put(key, asset.bytes, { httpMetadata: { contentType: asset.content_type } });
            refs.push({ key, content_type: asset.content_type });
        }
        const source = { original_text: c.text, model: 'browser_capture', original_language: c.language || 'und', context_text: '', related_links: [], image_urls: [] };
        const evidence: EvidenceSnapshot = { blocks: [{ id: 'primary', role: 'primary', text: c.text, url: current.url, acquired: 'browser_dom' }], fetched_at: now, retrieval: 'browser_capture', truncation: { truncated: c.truncated === true, ...(c.truncated === true ? { reason: 'browser_capture_limit' } : {}) } };
        const evidenceHash = await contentHash(evidence);
        const guard = `EXISTS(SELECT 1 FROM browser_captures b WHERE b.link_id=links.id AND b.client_id=? AND b.completed=0) AND links.url=?`;
        const applied = `${guard} AND links.last_capture_id=?`;
        await env.DB.batch([
            ...(staged ? c.images.map((_:unknown,ordinal:number)=>env.DB.prepare('INSERT INTO capture_image_uploads(capture_id,ordinal,link_id) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(body.client_id,ordinal,id)) : []),
            env.DB.prepare(`UPDATE links SET original_text=?,original_language=?,ai_title=?,images=?,related_links='[]',source_context_text='',
              translated_text=CASE WHEN original_text IS ? THEN translated_text ELSE NULL END,
              summary=CASE WHEN original_text IS ? THEN summary ELSE NULL END,
              note=CASE WHEN note='' THEN ? ELSE note END,
              enrichment_status=CASE WHEN original_text IS ? AND enrichment_status='completed' THEN 'completed' ELSE 'pending' END,
              enrichment_attempts=0,enrichment_error=NULL,enrichment_next_retry_at=${staged && c.images.length ? "'9999-12-31T00:00:00Z'" : 'NULL'},enrichment_lease_token=NULL,enrichment_lease_until=NULL,
              enrichment_paid_uncertain=CASE WHEN original_text IS ? THEN enrichment_paid_uncertain ELSE 0 END,
              enrichment_paid_stage=CASE WHEN original_text IS ? THEN enrichment_paid_stage ELSE NULL END,
              enrichment_paid_stage_started=CASE WHEN original_text IS ? THEN enrichment_paid_stage_started ELSE 0 END,
              enrichment_updated_at=?,last_capture_id=? WHERE id=? AND ${guard} AND content_revision=? AND app_body_revision=?`)
                .bind(c.text, c.language || 'und', c.title, JSON.stringify(refs), c.text, c.text, body.note, c.text, c.text, c.text, c.text, now, body.client_id, id, body.client_id, current.url, receipt.expected_revision, receipt.expected_body_revision),
            env.DB.prepare(`INSERT INTO enrichment_sources(link_id,url,original_text,payload,fetched_at) SELECT id,url,original_text,?,? FROM links WHERE id=? AND ${applied} AND original_text=? AND images=?
              ON CONFLICT(link_id) DO UPDATE SET url=excluded.url,original_text=excluded.original_text,payload=excluded.payload,fetched_at=excluded.fetched_at
              WHERE enrichment_sources.payload<>excluded.payload OR enrichment_sources.url<>excluded.url OR enrichment_sources.original_text<>excluded.original_text`)
                .bind(JSON.stringify(source), now, id, body.client_id, current.url, body.client_id, c.text, JSON.stringify(refs)),
            env.DB.prepare(`INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,truncated,completeness,created_at) SELECT id,content_revision,?,?,?,?,? FROM links WHERE id=? AND ${applied} AND original_text=? ON CONFLICT(link_id,content_revision) DO NOTHING`)
                .bind(evidenceHash, objectivePayload(evidence), c.truncated === true ? 1 : 0, c.truncated === true ? 'truncated' : 'complete', now, id, body.client_id, current.url, body.client_id, c.text),
            env.DB.prepare('UPDATE browser_captures SET completed=1 WHERE client_id=? AND EXISTS(SELECT 1 FROM links WHERE id=link_id AND original_text=? AND url=? AND images=? AND last_capture_id=?)').bind(body.client_id, c.text, current.url, JSON.stringify(refs), body.client_id)
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
    if (!staged) await registerMedia(env, body.client_id, c.media || []);
    const imageCounts = staged ? await env.DB.prepare("SELECT count(*) AS total,coalesce(sum(status='ready'),0) AS ready FROM capture_image_uploads WHERE capture_id=?").bind(body.client_id).first<{total:number;ready:number}>() : null;
    // Preserve the v0.2.0 request-echo contract; the canonical saved URL is
    // explicit metadata for clients that understand updates.
    return reply({ ...link, url: body.url, note: body.note, learned: link.learned === 1,
      capture_result: { client_id:body.client_id, action:receipt.was_existing ? 'updated' : 'created', stored_url:link.url,
        images_saved:staged ? (imageCounts?.total ? imageCounts.ready : body.legacy_hash && old?.completed ? c.images.length : 0) : assets.length, media_count:c.media?.length || 0, missing_images:Number(c.missing_images)||0, note_preserved:link.note !== body.note } }, 201);
}
