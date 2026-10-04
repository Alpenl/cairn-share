import type { Env } from './index';
import { readJSONObject } from './json-body';
import { digest } from './browser-capture';
const reply = (v: unknown, s = 200) => Response.json(v, { status: s, headers: { 'Cache-Control': 'private, no-store' } });
export const presentationColumns = `(SELECT p.formatted_content FROM content_presentations p WHERE p.link_id=links.id AND p.status='completed') AS formatted_content,
 (SELECT p.status FROM content_presentations p WHERE p.link_id=links.id) AS formatting_status`;
type Input = {
    id: number;
    original_text: string | null;
    translated_text: string | null;
    images: string | null;
};
async function enqueue(env: Env, id: number, force = false) {
    const row = await env.DB.prepare('SELECT id,original_text,translated_text,images FROM links WHERE id=?').bind(id).first<Input>();
    if (!row)
        return reply({ error: 'not_found' }, 404);
    const text = row.translated_text?.trim() ? row.translated_text : row.original_text;
    if (!text?.trim())
        return reply({ error: 'source_required' }, 409);
    const kind = row.translated_text?.trim() ? 'translation' : 'original';
    const images = row.images || '[]';
    const hash = await digest(JSON.stringify([text, images, kind]));
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO content_presentations(link_id,input_text,input_images,input_kind,input_hash,updated_at)
 SELECT id,?,?,?,?,? FROM links WHERE id=? AND original_text IS ? AND translated_text IS ? AND images IS ?
 ON CONFLICT(link_id) DO UPDATE SET input_text=excluded.input_text,input_images=excluded.input_images,input_kind=excluded.input_kind,
 input_hash=excluded.input_hash,status='pending',lease_token=NULL,lease_until=NULL,attempts=0,error=NULL,updated_at=excluded.updated_at
 WHERE content_presentations.input_hash<>excluded.input_hash OR content_presentations.status IN ('failed','stale') OR (? AND content_presentations.status='completed')`)
        .bind(text, images, kind, hash, now, id, row.original_text, row.translated_text, row.images, force ? 1 : 0).run();
    return reply({ status: 'queued' }, 202);
}
export function validPresentation(input: string, output: unknown): output is string {
    if (typeof output !== 'string' || !output.trim() || new TextEncoder().encode(output).length > 160000)
        return false;
    const plain = (s: string) => s.replace(/[\s#*_`>\-|\[\]()]/g, '');
    if (plain(output).length < plain(input).length * .8 || output.length > input.length * 2 + 1000)
        return false;
    const counts = new Map<string, number>();
    for (const char of plain(output))
        counts.set(char, (counts.get(char) || 0) + 1);
    let missing = 0;
    for (const char of plain(input)) {
        const n = counts.get(char) || 0;
        if (n)
            counts.set(char, n - 1);
        else
            missing++;
    }
    if (missing > Math.max(3, plain(input).length * .03))
        return false;
    const refs = (s: string) => s.match(/https?:\/\/[^\s<>\])]+|cairn-image:\d+/g) || [];
    const before = new Set(refs(input)), after = new Set(refs(output));
    if ([...before].some(v => !after.has(v)) || [...after].some(v => !before.has(v)))
        return false;
    if ((input.match(/\d+(?:[.,]\d+)*/g) || []).some(v => !output.includes(v)))
        return false;
    const code = [...input.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(m => m[1]);
    return code.every(block => output.includes(block)) && !/<(?:script|iframe|style)\b/i.test(output);
}
export async function presentationRoute(request: Request, env: Env, path: string): Promise<Response> {
    const match = path.match(/\/(\d+)\/presentation$/);
    if (match) {
        const id = Number(match[1]);
        if (request.method === 'POST') {
            const body = await readJSONObject(request, 4096);
            if (!body)
                return reply({ error: 'invalid_json' }, 400);
            return enqueue(env, id, body.force === true);
        }
        if (request.method === 'GET') {
            const row = await env.DB.prepare(`SELECT status,CASE WHEN status='completed' THEN formatted_content ELSE NULL END AS formatted_content,model,prompt_version,updated_at,error FROM content_presentations WHERE link_id=?`).bind(id).first();
            return reply(row || { status: 'none' });
        }
        return reply({ error: 'method_not_allowed' }, 405);
    }
    if (request.method !== 'POST')
        return reply({ error: 'method_not_allowed' }, 405);
    const body = await readJSONObject(request);
    if (!body)
        return reply({ error: 'invalid_json' }, 400);
    if (path.endsWith('/claim')) {
        if (body.auto === true) {
            const candidates = await env.DB.prepare(`SELECT id FROM links WHERE COALESCE(NULLIF(translated_text,''),original_text,'')<>''
    AND (enrichment_status='completed' OR url NOT LIKE '%/status/%')
    AND NOT EXISTS(SELECT 1 FROM browser_captures b WHERE b.link_id=links.id AND b.completed=0)
    AND NOT EXISTS(SELECT 1 FROM content_presentations p WHERE p.link_id=links.id AND p.status<>'stale') ORDER BY id DESC LIMIT 5`).all<{
                id: number;
            }>();
            for (const row of candidates.results)
                await enqueue(env, row.id);
        }
        const now = new Date().toISOString(), day = now.slice(0, 10), token = crypto.randomUUID();
        const limit = typeof body.daily_limit === 'number' ? Math.max(1, Math.min(100, Math.trunc(body.daily_limit))) : 20;
        await env.DB.batch([
            env.DB.prepare("UPDATE content_presentations SET status='failed',error='整理任务中断，可手动重试',lease_token=NULL WHERE status='processing' AND lease_until<? AND attempts>=3").bind(now),
            env.DB.prepare('INSERT INTO presentation_budget(day,calls) VALUES(?,0) ON CONFLICT DO NOTHING').bind(day),
            env.DB.prepare(`UPDATE content_presentations SET status='processing',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=?
    WHERE link_id=(SELECT link_id FROM content_presentations WHERE (status='pending' OR (status='processing' AND lease_until<?)) AND attempts<3 ORDER BY updated_at LIMIT 1)
    AND (SELECT calls FROM presentation_budget WHERE day=?)<?`).bind(token, new Date(Date.now() + 240000).toISOString(), now, now, day, limit),
            env.DB.prepare('UPDATE presentation_budget SET calls=calls+1 WHERE day=? AND EXISTS(SELECT 1 FROM content_presentations WHERE lease_token=?)').bind(day, token)
        ]);
        const job = await env.DB.prepare('SELECT link_id,input_text,input_images,input_kind,input_hash,lease_token FROM content_presentations WHERE lease_token=?').bind(token).first();
        return job ? reply(job) : new Response(null, { status: 204 });
    }
    if (path.endsWith('/complete') || path.endsWith('/fail')) {
        if (!Number.isSafeInteger(body.link_id) || typeof body.lease_token !== 'string')
            return reply({ error: 'invalid_json' }, 400);
        const row = await env.DB.prepare(`SELECT input_text FROM content_presentations WHERE link_id=? AND lease_token=? AND status='processing' AND lease_until>?`).bind(body.link_id, body.lease_token, new Date().toISOString()).first<{
            input_text: string;
        }>();
        if (!row)
            return reply({ error: 'input_changed' }, 409);
        const complete = path.endsWith('/complete');
        if (complete && (!validPresentation(row.input_text, body.formatted_content) || typeof body.model !== 'string' || body.model.length > 200 || body.prompt_version !== 'format-v1'))
            return reply({ error: 'invalid_presentation' }, 400);
        const result = await env.DB.prepare(`UPDATE content_presentations SET status=?,formatted_content=CASE WHEN ? THEN ? ELSE formatted_content END,
   model=?,prompt_version=?,error=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE link_id=? AND lease_token=? AND status='processing' AND lease_until>?`)
            .bind(complete ? 'completed' : 'failed', complete ? 1 : 0, complete ? body.formatted_content : null, typeof body.model === 'string' ? body.model.slice(0, 200) : '', 'format-v1', complete ? null : '整理未完成，可手动重试', new Date().toISOString(), body.link_id, body.lease_token, new Date().toISOString()).run();
        return result.meta.changes ? reply({ status: complete ? 'completed' : 'failed' }) : reply({ error: 'input_changed' }, 409);
    }
    return reply({ error: 'not_found' }, 404);
}
