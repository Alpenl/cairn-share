import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { historicalCatalog, managedCatalog } from '../src/tag-catalog';
import { readSelectionSnapshot, readSelectionExport } from '../src/selection-state';
import { projectionInputGuard } from '../src/domain-routes';

const binding = () => ({ DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
  CAIRN_API_TOKEN: 'app', CAIRN_ENRICHER_TOKEN: 'internal' });
const headers = { Authorization: 'Bearer app', 'X-Cairn-Tag-System': '1',
  'X-Cairn-Collections': '2', 'X-Cairn-Topic-Granularity': '1', 'Content-Type': 'application/json' };
async function call(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const response = await worker.fetch(new Request(`https://delete.example/api/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  }), binding());
  return { status: response.status, data: await response.json() as any };
}
const operation = (dimension = 'topics', id = 'llm', revision = 0) => ({
  operation_key: crypto.randomUUID(), expected_revision: revision, type: 'delete', dimension, id,
});
beforeEach(async () => {
  await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(`INSERT INTO links(id,url,note,created_at,original_text,classification)
    VALUES(1,'https://example.com/1','original note','2026-10-13','original article',?)`)
    .bind(JSON.stringify({ topics: ['llm', 'image_creation'], form: 'list', use: 'contra' })).run();
});

it('atomically removes an archived definition and membership, preserves sources/history, and replays once', async () => {
  const seed = await managedCatalog(binding());
  const source = await env.DB.prepare('SELECT original_text,note,classification,content_revision FROM links WHERE id=1').first();
  const archive = { ...operation(), type: 'archive' };
  expect((await call('tag-catalog/operations', archive)).status).toBe(200);
  const snapshot = await readSelectionSnapshot(binding(), 1);
  const op = operation('topics', 'llm', 1);
  const result = await call('tag-catalog/operations', op);
  expect(result.status).toBe(200);
  expect(result.data.catalog.topics.some((t: any) => t.id === 'llm')).toBe(false);
  expect(result.data.catalog.topics.some((t: any) => t.relations?.some((r: any) => r.id === 'llm'))).toBe(false);
  expect((await historicalCatalog(binding(), seed.catalog.version))?.topics.some(t => t.id === 'llm')).toBe(true);
  expect(await env.DB.prepare('SELECT original_text,note,classification,content_revision FROM links WHERE id=1').first()).toEqual(source);
  expect((await readSelectionSnapshot(binding(), 1))?.view.topics).toEqual(['image_creation']);
  expect(await env.DB.prepare("SELECT term FROM effective_tag_memberships WHERE field='topics' AND link_id=1").all()).toMatchObject({ results: [{ term: 'image_creation' }] });
  expect((await readSelectionExport(binding(), { clauses: [], bindings: [] }, 10)).rows[0].snapshot.view.topics).toEqual(['image_creation']);
  const personal = await env.DB.prepare('SELECT personal_revision FROM links WHERE id=1').first('personal_revision');
  expect(personal).toBe(1);
  expect((await call('tag-catalog/operations', op)).data).toMatchObject({ replayed: true, revision: 2, operation_revision: 2 });
  expect(await env.DB.prepare('SELECT personal_revision FROM links WHERE id=1').first('personal_revision')).toBe(personal);
  expect((await call('tag-catalog/history?dimension=topics&id=llm')).data.items.map((x: any) => x.action)).toEqual(['delete', 'archive']);
  expect((await call('tag-catalog/operations', { ...op, id: 'eng' })).status).toBe(409);
  expect((await call('tag-catalog/operations', { ...operation('topics', 'llm', 2), type: 'restore' })).status).toBe(404);
  // A computation begun before catalog deletion cannot publish stale projections.
  const guard = projectionInputGuard(1, snapshot!);
  expect(await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.bindings).first()).toBeNull();
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM classification_runs').first('n')).toBe(0);
});

it('rejects stale deletion without any effects and removes singular use references', async () => {
  const stale = await call('tag-catalog/operations', operation('uses', 'contra', 4));
  expect(stale.status).toBe(409);
  expect((await readSelectionSnapshot(binding(), 1))?.view.use).toBe('contra');
  expect((await call('tag-catalog/operations', operation('uses', 'contra'))).status).toBe(200);
  expect((await readSelectionSnapshot(binding(), 1))?.view.use).toBe('');
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM effective_tag_memberships WHERE field='use' AND term='contra'").first('n')).toBe(0);
});

it('protects the last AI candidate and rolls the complete deletion back if any side effect fails', async () => {
  const current = await managedCatalog(binding());
  current.catalog.uses = current.catalog.uses.filter(t => t.id === 'contra' || t.id === 'quote');
  expect(current.catalog.uses).toHaveLength(2);
  await env.DB.prepare("INSERT INTO tag_catalog_snapshots(revision,version,catalog,created_at) VALUES(1,?,?,'2026-10-13')")
    .bind(current.catalog.version, JSON.stringify(current.catalog)).run();
  await env.DB.prepare('UPDATE tag_catalog_state SET revision=1 WHERE id=1').run();
  expect((await call('tag-catalog/operations', operation('uses', 'quote', 1))).data.error).toBe('last_ai_tag');
  await env.DB.exec("CREATE TRIGGER fail_tag_deletion BEFORE INSERT ON tag_change_facts WHEN NEW.term='llm' BEGIN SELECT RAISE(ABORT,'test transaction failure'); END;");
  const failure = await call('tag-catalog/operations', operation('topics', 'llm', 1));
  expect(failure.status).toBeGreaterThanOrEqual(500);
  expect((await managedCatalog(binding())).revision).toBe(1);
  expect((await readSelectionSnapshot(binding(), 1))?.view.topics).toContain('llm');
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM tag_catalog_operations WHERE action='delete'").first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT personal_revision FROM links WHERE id=1').first('personal_revision')).toBe(0);
});

it('cannot resurrect deleted terms through legacy classification, overrides, reset or old decisions', async () => {
  expect((await call('tag-catalog/operations', operation())).status).toBe(200);
  // Simulates a legacy writer or a queued classification from the old catalog.
  await env.DB.prepare('UPDATE links SET classification=? WHERE id=1')
    .bind(JSON.stringify({ topics: ['llm', 'image_creation'], form: '', use: '' })).run();
  for (const action of ['accept', 'reset']) {
    await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,source,confirmed,revision,operation_key,created_at)
      VALUES(1,'topics','llm',?,'human',1,2,?,'2026-10-13')`).bind(action, crypto.randomUUID()).run();
    expect((await readSelectionSnapshot(binding(), 1))?.view.topics).toEqual(['image_creation']);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM canonical_effective_tag_terms WHERE term='llm'").first('n')).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM effective_tag_memberships WHERE term='llm'").first('n')).toBe(0);
  }
  const accept = await call('bookmarks/1/tags', { operation_key: crypto.randomUUID(), expected_revision: 1,
    actions: [{ action: 'accept', tag_ref: 'system/topics/llm' }] });
  expect(accept.status).toBe(400);
  const list = await call('links?include=enrichment');
  expect(list.status).toBe(200);
  expect(list.data.items[0].enrichment.classification.topics).not.toContain('llm');
});

it('disables affected rules without broadening them, clears pending matches and keeps collection contents', async () => {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO collections(id,name,created_at,updated_at,last_operation,rule_enabled,rule_tags,rule_exclude_tags)
    VALUES(?,'Keep collection','2026-10-13','2026-10-13','seed',1,?,?)`)
    .bind(id, JSON.stringify(['system/topics/image_creation']), JSON.stringify(['system/topics/llm'])).run();
  await env.DB.prepare("INSERT INTO collection_items(collection_id,link_id,position,added_at) VALUES(?,1,0,'2026-10-13')").bind(id).run();
  await env.DB.prepare("INSERT INTO collection_rule_candidates(collection_id,link_id,rule_revision,created_at) VALUES(?,1,0,'2026-10-13')").bind(id).run();
  expect((await call('tag-catalog/operations', operation())).status).toBe(200);
  expect(await env.DB.prepare('SELECT rule_enabled,rule_tags,rule_exclude_tags,revision,rule_revision FROM collections WHERE id=?').bind(id).first())
    .toEqual({ rule_enabled: 0, rule_tags: '["system/topics/image_creation"]', rule_exclude_tags: '[]', revision: 2, rule_revision: 1 });
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM collection_items').first('n')).toBe(1);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM collection_rule_candidates').first('n')).toBe(0);
  const history = (await call('tag-catalog/history?dimension=topics&id=llm')).data.items;
  expect(JSON.parse(history[0].after_value).rules_before[0]).toMatchObject({ id, enabled: 1, exclude_tags: ['system/topics/llm'] });
});

it('keeps custom archival reversible but deletes custom tags, their links and rules with a replayable receipt', async () => {
  const created = await call('custom-tags', { operation_key: crypto.randomUUID(), label: 'Personal test' });
  expect(created.status).toBe(200);
  const tag = created.data.tag;
  const archived = await call(`custom-tags/${tag.id}`, { operation_key: crypto.randomUUID(),
    expected_revision: 1, label: tag.label, archived: true }, 'PATCH');
  expect(archived.status).toBe(200);
  expect((await call('custom-tags')).data.tags).toHaveLength(1);
  const restored = await call(`custom-tags/${tag.id}`, { operation_key: crypto.randomUUID(),
    expected_revision: 2, label: tag.label, archived: false }, 'PATCH');
  expect(restored.status).toBe(200);
  expect((await call('bookmarks/1/tags', { operation_key: crypto.randomUUID(), expected_revision: 0,
    actions: [{ action: 'attach', tag_ref: tag.tag_ref }] })).status).toBe(200);
  const collection = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO collections(id,name,created_at,updated_at,last_operation,rule_enabled,rule_tags)
    VALUES(?,'Custom rule','2026-10-13','2026-10-13','seed',1,?)`).bind(collection, JSON.stringify([tag.tag_ref])).run();
  const body = { operation_key: crypto.randomUUID(), expected_revision: 3, detach_all: true, permanent: true };
  expect((await call(`custom-tags/${tag.id}`, body, 'DELETE')).status).toBe(200);
  expect((await call(`custom-tags/${tag.id}`, body, 'DELETE')).data.replayed).toBe(true);
  expect((await call('custom-tags')).data.tags).toEqual([]);
  expect((await call('tag-catalog')).data.custom_tags).toEqual([]);
  const workspace = await worker.fetch(new Request('https://delete.example/api/enrichment/workspace', { headers: { ...headers, Authorization: 'Bearer internal' } }), binding());
  expect(workspace.status).toBe(200);
  expect((await workspace.json() as any).catalog.custom_tags).toEqual([]);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM custom_tag_links').first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT rule_enabled FROM collections WHERE id=?').bind(collection).first('rule_enabled')).toBe(0);
  expect((await call(`custom-tags/${tag.id}`, { operation_key: crypto.randomUUID(),
    expected_revision: 4, label: tag.label, archived: false }, 'PATCH')).status).toBe(404);
  const fresh = await call('custom-tags', { operation_key: crypto.randomUUID(), label: tag.label });
  expect(fresh.status).toBe(200);
  expect(fresh.data.tag.id).not.toBe(tag.id);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM custom_tag_operations WHERE tag_id=? AND action='delete'").bind(tag.id).first('n')).toBe(1);
});
