import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect,it } from "vitest";

it('0025 preserves existing records, invalidates authoritative changes atomically, and rolls back without deleting history',async()=>{
  await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.filter(m=>m.name<'0025'));
  await env.DB.prepare("INSERT INTO links(id,url,note,created_at) VALUES(1,'https://example.com/upgrade','saved note','2026-09-23T00:00:00Z')").run();
  await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,revision,source,confirmed,operation_key,created_at)
    VALUES(1,'topics','eng','accept',1,'human',1,'keep-human','2026-09-23T00:00:00Z')`).run();
  const records=async()=>({links:(await env.DB.prepare('SELECT * FROM links').all()).results,
    overrides:(await env.DB.prepare('SELECT * FROM curation_overrides').all()).results,
    snapshots:(await env.DB.prepare('SELECT * FROM evidence_snapshots').all()).results});
  const generation=()=>env.DB.prepare("SELECT value FROM cache_metadata WHERE key='links_generation'").first<number>('value');
  const before=await records(),initial=await generation();
  await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.filter(m=>m.name<'0026'));
  expect(await records()).toEqual(before);expect(await generation()).toBe(initial);
  await env.DB.prepare('UPDATE links SET content_revision=content_revision+1 WHERE id=1').run();
  expect(await generation()).toBe(initial!+1);
  await env.DB.prepare('UPDATE links SET content_revision=content_revision WHERE id=1').run();
  expect(await generation()).toBe(initial!+1);
  await env.DB.prepare(`INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,created_at)
    VALUES(1,2,'hash','{}','2026-09-23T00:00:00Z')`).run();
  expect(await generation()).toBe(initial!+2);
  const committed=await records();
  await expect(env.DB.batch([
    env.DB.prepare('UPDATE links SET content_revision=content_revision+1 WHERE id=1'),
    env.DB.prepare("INSERT INTO links(id,url,note,created_at) VALUES(1,'https://example.com/duplicate','','')")
  ])).rejects.toThrow();
  expect(await records()).toEqual(committed);expect(await generation()).toBe(initial!+2);
  await env.DB.batch([
    env.DB.prepare('DROP TRIGGER links_content_revision_cache_invalidation'),
    env.DB.prepare('DROP TRIGGER evidence_snapshot_cache_invalidation')
  ]);
  expect(await records()).toEqual(committed);
  await env.DB.prepare('UPDATE links SET content_revision=content_revision+1 WHERE id=1').run();
  expect(await generation()).toBe(initial!+2);
  const migration=env.TEST_MIGRATIONS.find(m=>m.name.startsWith('0025'))!;
  await env.DB.batch(migration.queries.map(query=>env.DB.prepare(query)));
  await env.DB.prepare('UPDATE links SET content_revision=content_revision+1 WHERE id=1').run();
  expect(await generation()).toBe(initial!+3);
  expect((await records()).overrides).toEqual(before.overrides);
});
