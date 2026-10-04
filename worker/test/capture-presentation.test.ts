import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { validPresentation } from '../src/presentations';
import { urlIdentity } from '../src/url-identity';
const bindings = { ...env, CAIRN_API_TOKEN: 'app-test', CAIRN_ENRICHER_TOKEN: 'internal-test' };
const call = (path: string, body?: unknown, internal = false) => worker.fetch(new Request('https://share.alpenl.com' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${internal ? 'internal-test' : 'app-test'}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), bindings);
const capture = { url: 'https://x.com/person/status/123', note: 'keep', client_id: '3f55e9e8-4d52-4f45-a33d-89be8ef7ab45', capture: { title: 'Browser title', language: 'zh', text: '# 标题\n\n正文保留 123。\n\n![图](cairn-image:0)', images: [{ content_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a42kAAAAASUVORK5CYII=' }] } };
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
it('fresh browser evidence releases only the old revision block and preserves its paid receipt', async () => {
    const saved: any = await (await call('/api/captures', capture)).json();
    const before: any = await env.DB.prepare('SELECT content_revision FROM links WHERE id=?').bind(saved.id).first();
    await env.DB.prepare(`INSERT INTO enrichment_provider_attempts(operation_key,link_id,lease_hash,content_revision,stage,variant,attempt_number,request_hash,reservation_hash,model,created_at)
      VALUES(?,?,?,?,'reading','fixture',1,?,?,'fixture','2026-10-04T00:00:00Z')`)
      .bind('a'.repeat(64), saved.id, 'b'.repeat(64), before.content_revision, 'c'.repeat(64), 'd'.repeat(64)).run();
    await env.DB.prepare("UPDATE links SET enrichment_status='failed',enrichment_paid_stage='reading',enrichment_lease_token='old-lease' WHERE id=?").bind(saved.id).run();
    const receipt = await env.DB.prepare('SELECT * FROM enrichment_provider_attempts').first();
    // A duplicate submission cannot authorize another call for the same evidence.
    expect((await call('/api/captures', { ...capture, client_id: crypto.randomUUID() })).status).toBe(201);
    expect(await env.DB.prepare('SELECT enrichment_paid_uncertain FROM links WHERE id=?').bind(saved.id).first('enrichment_paid_uncertain')).toBe(1);
    expect((await call('/api/captures', { ...capture, client_id: crypto.randomUUID(), capture: { ...capture.capture, text: '新采集的完整正文。' } })).status).toBe(201);
    const row: any = await env.DB.prepare('SELECT * FROM links WHERE id=?').bind(saved.id).first();
    expect(row).toMatchObject({ enrichment_status: 'pending', enrichment_paid_uncertain: 0, enrichment_paid_stage: null, enrichment_paid_stage_started: 0, enrichment_lease_token: null });
    expect(row.content_revision).toBeGreaterThan(before.content_revision);
    expect(await env.DB.prepare('SELECT * FROM enrichment_provider_attempts').first()).toEqual(receipt);
    expect((await call(`/api/enrichment/jobs/${saved.id}/complete`, { lease_token: 'old-lease', original_text: 'stale', ai_title: 'stale', original_language: 'zh', translated_text: 'stale', summary: 'stale', related_links: [], images: [], model: 'fixture' }, true)).status).toBe(409);
    expect(await env.DB.prepare('SELECT original_text FROM links WHERE id=?').bind(saved.id).first('original_text')).toBe('新采集的完整正文。');
});

it('repairs the oldest original bookmark when historical duplicates already exist', async () => {
    for (const url of ['https://twitter.com/old/status/123', 'https://x.com/person/status/123']) {
        await env.DB.prepare("INSERT INTO links(url,note,created_at,enrichment_status) VALUES(?,'保留','2026-10-01','failed')").bind(url).run();
    }
    const result: any = await (await call('/api/captures', capture)).json();
    expect(result.id).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM links').first('COUNT(*)')).toBe(2);
    expect(await env.DB.prepare('SELECT note FROM links WHERE id=1').first('note')).toBe('保留');
    expect(await env.DB.prepare('SELECT original_text FROM links WHERE id=2').first('original_text')).toBeNull();
});
it('archives browser evidence and image bytes once; replay cannot overwrite or resurrect', async () => {
    const first = await call('/api/captures', capture);
    expect(first.status).toBe(201);
    const saved: any = await first.json();
    expect((await call('/api/captures', capture)).status).toBe(201);
    const row: any = await env.DB.prepare('SELECT * FROM links WHERE id=?').bind(saved.id).first();
    expect(row.original_text).toBe(capture.capture.text);
    expect(row.enrichment_status).toBe('pending');
    const source: any = await env.DB.prepare('SELECT payload FROM enrichment_sources WHERE link_id=?').bind(saved.id).first();
    expect(JSON.parse(source.payload)).toMatchObject({ model: 'browser_capture', image_urls: [] });
    const image = JSON.parse(row.images)[0];
    expect(await env.ENRICHMENT_IMAGES.head(image.key)).not.toBeNull();
    expect((await call('/api/captures', { ...capture, capture: { ...capture.capture, text: 'changed' } })).status).toBe(409);
    await env.DB.prepare('DELETE FROM links WHERE id=?').bind(saved.id).run();
    expect((await call('/api/captures', capture)).status).toBe(410);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM links').first('n')).toBe(0);
});
it('formatting is optional, source-bound, idempotent, private, and never rewrites original evidence', async () => {
    const saved: any = await (await call('/api/captures', capture)).json();
    expect((await call(`/api/links/${saved.id}/presentation`, {})).status).toBe(202);
    expect((await call('/api/enrichment/presentations/claim', {})).status).toBe(401);
    const claim: any = await (await call('/api/enrichment/presentations/claim', {}, true)).json();
    expect(claim.input_text).toBe(capture.capture.text);
    const result = { link_id: saved.id, lease_token: claim.lease_token, formatted_content: capture.capture.text, model: 'fixture', prompt_version: 'format-v1' };
    expect((await call('/api/enrichment/presentations/complete', result, true)).status).toBe(200);
    const detail: any = await (await call(`/api/links/${saved.id}?include=enrichment&include_cache_identity=1`)).json();
    expect(detail.enrichment.formatted_content).toBe(capture.capture.text);
    const internal: any = await (await call(`/api/enrichment/jobs/${saved.id}`, undefined, true)).json();
    expect(internal.formatted_content).toBe(capture.capture.text);
    const reading: any = await (await call(`/api/enrichment/jobs/${saved.id}/reading`, undefined, true)).json();
    expect(reading.detail.formatted_content).toBe(capture.capture.text);
    await call(`/api/links/${saved.id}/presentation`, {});
    expect((await call('/api/enrichment/presentations/claim', {}, true)).status).toBe(204);
    await env.DB.prepare("UPDATE links SET translated_text='新的译文 123。' WHERE id=?").bind(saved.id).run();
    const stale: any = await (await call(`/api/links/${saved.id}?include=enrichment`)).json();
    expect(stale.enrichment.formatted_content).toBeNull();
    expect(stale.enrichment.original_text).toBe(capture.capture.text);
    expect((await call('/api/enrichment/presentations/complete', result, true)).status).toBe(409);
});
it('rejects content loss, invented links and changed code; caps daily model claims', async () => {
    expect(validPresentation('正文 cairn-media:0 cairn-image:1', '正文 cairn-image:1 cairn-media:0')).toBe(false);
    expect(validPresentation('正文 cairn-media:0', '正文')).toBe(false);
    expect(validPresentation('正文 123 https://example.com/a', '正文 123 https://evil.test')).toBe(false);
    expect(validPresentation('```js\nconst x=1;\n```', '```js\nconst x=2;\n```')).toBe(false);
    expect(validPresentation('一段完整的正文应该保留所有信息。', '摘要')).toBe(false);
    const saved: any = await (await call('/api/captures', capture)).json();
    await call(`/api/links/${saved.id}/presentation`, {});
    const job: any = await (await call('/api/enrichment/presentations/claim', { daily_limit: 1 }, true)).json();
    await call('/api/enrichment/presentations/fail', job, true);
    await call(`/api/links/${saved.id}/presentation`, {});
    expect((await call('/api/enrichment/presentations/claim', { daily_limit: 1 }, true)).status).toBe(204);
});

it('formats complete Chinese originals and repairs old queued translation inputs before claiming', async () => {
    const saved: any = await (await call('/api/captures', capture)).json();
    await env.DB.prepare("UPDATE links SET translated_text='旧译文缺少正文结构' WHERE id=?").bind(saved.id).run();
    await call(`/api/links/${saved.id}/presentation`, {});
    const original: any = await env.DB.prepare('SELECT * FROM content_presentations WHERE link_id=?').bind(saved.id).first();
    expect(original.input_text).toBe(capture.capture.text);
    expect(original.input_kind).toBe('original');
    // Simulate a task queued by the previous release, plus a later task that
    // must not jump ahead when refreshing the first task changes its timestamp.
    await env.DB.prepare("UPDATE content_presentations SET input_text='旧译文缺少正文结构',input_kind='translation',input_hash='old',updated_at='2026-01-01' WHERE link_id=?").bind(saved.id).run();
    const second: any = await (await call('/api/captures', { ...capture, url: 'https://x.com/p/status/456', client_id: crypto.randomUUID() })).json();
    await call(`/api/links/${second.id}/presentation`, {});
    const claim: any = await (await call('/api/enrichment/presentations/claim', {}, true)).json();
    expect(claim.link_id).toBe(saved.id);
    expect(claim.input_text).toBe(capture.capture.text);
    expect(claim.input_kind).toBe('original');
    expect(claim.input_hash).toBe(original.input_hash);
    expect(await env.DB.prepare('SELECT original_text FROM links WHERE id=?').bind(saved.id).first('original_text')).toBe(capture.capture.text);
    expect((await call('/api/enrichment/presentations/complete', { link_id: saved.id, lease_token: claim.lease_token, formatted_content: capture.capture.text, model: 'fixture', prompt_version: 'format-v1' }, true)).status).toBe(200);
});

it('keeps translated reading input for non-Chinese originals', async () => {
    const saved: any = await (await call('/api/captures', { ...capture, capture: { ...capture.capture, language: 'en', text: 'Original English article.' } })).json();
    await env.DB.prepare("UPDATE links SET translated_text='完整中文译文。' WHERE id=?").bind(saved.id).run();
    await call(`/api/links/${saved.id}/presentation`, {});
    const claim: any = await (await call('/api/enrichment/presentations/claim', {}, true)).json();
    expect(claim.input_text).toBe('完整中文译文。');
    expect(claim.input_kind).toBe('translation');
    await env.DB.prepare("UPDATE links SET original_language='zh-CN' WHERE id=?").bind(saved.id).run();
    expect((await call('/api/enrichment/presentations/complete', { link_id: saved.id, lease_token: claim.lease_token, formatted_content: '完整中文译文。', model: 'fixture', prompt_version: 'format-v1' }, true)).status).toBe(409);
});

it('updates the original app bookmark across WeChat tracking URLs without losing personal facts', async () => {
 const url='https://mp.weixin.qq.com/s/article-123';
 const first:any=await (await call('/api/links',{url,note:'我的原备注',client_id:crypto.randomUUID()})).json();
 await env.DB.prepare("UPDATE links SET learned=1,learned_at='2026-10-04',why='保留的策展理由' WHERE id=?").bind(first.id).run();
 const result=await call('/api/captures',{...capture,url:url+'?poc_token=temporary&scene=1',note:'',client_id:crypto.randomUUID()});
 expect(result.status).toBe(201);const saved:any=await result.json();expect(saved.id).toBe(first.id);expect(saved.capture_result.action).toBe('updated');
 const row:any=await env.DB.prepare('SELECT * FROM links WHERE id=?').bind(first.id).first();
 expect(row).toMatchObject({url,note:'我的原备注',learned:1,why:'保留的策展理由',original_text:capture.capture.text});
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM links').first('n')).toBe(1);
 const refreshed:any=await (await call('/api/captures',{...capture,url,client_id:crypto.randomUUID(),capture:{...capture.capture,text:'更新后的完整正文 456'}})).json();
 expect(refreshed.id).toBe(first.id);expect(await env.DB.prepare('SELECT original_text FROM links WHERE id=?').bind(first.id).first('original_text')).toBe('更新后的完整正文 456');
 expect((await env.DB.prepare('SELECT payload FROM enrichment_sources WHERE link_id=?').bind(first.id).first<any>())?.payload).toContain('更新后的完整正文 456');
});

it('normalizes known article identities while preserving meaningful queries and hash routes',()=>{
 expect(urlIdentity('https://twitter.com/name/status/123?s=20')).toBe(urlIdentity('https://x.com/i/web/status/123'));
 expect(urlIdentity('https://mp.weixin.qq.com/s?__biz=A&mid=1&idx=2&sn=signature&scene=3')).toBe('https://mp.weixin.qq.com/s?__biz=A&mid=1&idx=2');
 expect(urlIdentity('https://example.com/article?id=1&utm_source=share#title')).toBe('https://example.com/article?id=1');
 expect(urlIdentity('https://example.com/article?id=1')).not.toBe(urlIdentity('https://example.com/article?id=2'));
 expect(urlIdentity('https://example.com/#/article/1')).not.toBe(urlIdentity('https://example.com/#/article/2'));
});

it('simultaneous new captures resolve to one bookmark and stale uploads cannot overwrite later content',async()=>{
 const a={...capture,client_id:crypto.randomUUID()},b={...capture,client_id:crypto.randomUUID()};
 const results=await Promise.all([call('/api/captures',a),call('/api/captures',b)]);
 expect(results.some(r=>r.status===201)).toBe(true);
 expect(results.every(r=>[201,409].includes(r.status))).toBe(true);
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM links').first('n')).toBe(1);
 const stale=await env.DB.prepare('SELECT * FROM browser_captures WHERE completed=0').first<any>();
 if(stale){expect((await call('/api/captures',stale.client_id===a.client_id?a:b)).status).toBe(409);}
});
