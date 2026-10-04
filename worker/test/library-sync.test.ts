import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { librarySyncRoute, maintainLibrarySync } from "../src/library-sync";
const bindings = () => ({ DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
const headers = { Authorization: "Bearer app", "X-Cairn-Sync": "1", "X-Cairn-Tag-System": "1", "X-Cairn-Content-Functions": "1", "X-Cairn-Topic-Granularity": "1" };
type Page = {cursor:string;mode:string;has_more:boolean;items:Array<{id:number;note:string;enrichment:{original_text:string}}>;deleted:number[];media:Array<{key:string;version:string;bytes:number}>};
async function sync(cursor?: string, token = "app", origin = "https://sync.example") {
  return worker.fetch(new Request(`${origin}/api/sync?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: {...headers, Authorization:`Bearer ${token}`} }), bindings());
}
async function create(id: number) {
  await env.DB.prepare("INSERT INTO links(id,url,created_at,note) VALUES(?,?,'2026-10-04T00:00:00Z','initial')").bind(id, `https://example.com/${id}`).run();
}
async function finish(cursor?: string) {
  const pages: Page[] = [];
  for(let n=0;n<100;n++) {
    const response = await sync(cursor); expect(response.status).toBe(200);
    const page = await response.json() as Page; pages.push(page); cursor = page.cursor;
    if (!page.has_more) return pages;
  }
  throw new Error("cursor failed to progress");
}
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

it("catches inserts, changes and deletes during bounded initial pagination and replays idempotently", async () => {
  await create(1); await create(2); await create(3);
  const first = await (await sync()).json() as Page;
  expect(first.items.map(i=>i.id)).toEqual([3]);
  await env.DB.batch([
    env.DB.prepare("UPDATE links SET note='changed after page one' WHERE id=3"),
    env.DB.prepare("DELETE FROM links WHERE id=2"),
    env.DB.prepare("INSERT INTO links(id,url,created_at,note) VALUES(4,'https://example.com/4','2026-10-04','new')"),
  ]);
  const pages = await finish(first.cursor);
  const map = new Map(first.items.map(i=>[i.id,i]));
  for (const p of pages) {p.items.forEach(i=>map.set(i.id,i));p.deleted.forEach(id=>map.delete(id));}
  expect([...map.keys()].sort()).toEqual([1,3,4]); expect(map.get(3)?.note).toBe("changed after page one");
  const replay = await finish(first.cursor);
  expect(replay.flatMap(p=>p.items).map(i=>[i.id,i.note])).toEqual(pages.flatMap(p=>p.items).map(i=>[i.id,i.note]));
});

it("keeps sequential same-second edits and rolls back log entries with failed business transactions", async () => {
  await create(1);
  const baseline = (await finish()).at(-1)!;
  const before = await env.DB.prepare("SELECT MAX(seq) n FROM library_sync_changes").first<number>("n");
  await expect(env.DB.batch([env.DB.prepare("UPDATE links SET note='must rollback' WHERE id=1"), env.DB.prepare("INSERT INTO links(id,url,created_at) VALUES(1,'duplicate','now')")])).rejects.toThrow();
  expect(await env.DB.prepare("SELECT MAX(seq) n FROM library_sync_changes").first("n")).toBe(before);
  await env.DB.batch([env.DB.prepare("UPDATE links SET note='one' WHERE id=1"),env.DB.prepare("UPDATE links SET note='two' WHERE id=1")]);
  const pages = await finish(baseline.cursor);
  expect(pages.flatMap(p=>p.items).at(-1)?.note).toBe("two");
});

it("rejects forged, foreign-origin and revoked credentials; expired cursors require a fresh baseline", async () => {
  await create(1); const last = (await finish()).at(-1)!;
  expect((await sync(last.cursor, "other")).status).toBe(401);
  expect((await sync(last.cursor, "app", "https://another.example")).status).toBe(400);
  expect((await sync(last.cursor + "x")).status).toBe(400);
  await env.DB.prepare("UPDATE links SET note='new' WHERE id=1").run();
  await env.DB.prepare("UPDATE library_sync_changes SET created_at=0").run();
  await maintainLibrarySync(bindings());
  const expired = await sync(last.cursor); expect(expired.status).toBe(409); expect(await expired.json()).toEqual({error:"reset_required"});
  expect((await finish()).at(-1)?.has_more).toBe(false);
});

it("delivers image metadata and vocabulary changes without retaining deleted bodies", async () => {
  await create(1);
  const key=`enrichment/1/${"a".repeat(64)}.png`;
  await env.ENRICHMENT_IMAGES.put(key,"first",{httpMetadata:{contentType:"image/png"}});
  await env.DB.prepare("UPDATE links SET images=?,original_text='body' WHERE id=1").bind(JSON.stringify([{key,content_type:"image/png"}])).run();
  const first = await finish();const media=first[0].media[0];expect(media.bytes).toBe(5);
  const cursor=first.at(-1)!.cursor;
  await env.ENRICHMENT_IMAGES.put(key,"replacement",{httpMetadata:{contentType:"image/png"}});
  await env.DB.prepare("UPDATE links SET images=images WHERE id=1").run();
  const changed = await finish(cursor); expect(changed.flatMap(p=>p.media)[0].version).not.toBe(media.version);
  expect(changed.flatMap(p=>p.items)[0].enrichment.original_text).toBe("body");
  await env.DB.prepare("INSERT INTO taxonomy_display_overrides(dimension,term_id,label,proposal_id,applied_at) VALUES('topics','llm','语言模型','test','now')").run();
  const taxonomy = await (await sync(changed.at(-1)!.cursor)).json() as {taxonomy:unknown};expect(taxonomy.taxonomy).not.toBeNull();
  await env.DB.prepare("DELETE FROM links WHERE id=1").run();
  const removed=await finish(changed.at(-1)!.cursor);expect(removed.flatMap(p=>p.deleted)).toContain(1);
  expect(JSON.stringify(removed)).not.toContain('"original_text":"body"');
});


it("includes custom label renames, manual classification and entity revisions without link timestamp changes", async () => {
  await create(1);
  await env.DB.prepare("INSERT INTO custom_tags(id,label,normalized_label,created_at,updated_at) VALUES('mark','Old','old','now','now')").run();
  await env.DB.prepare("INSERT INTO custom_tag_links(link_id,tag_id,created_at) VALUES(1,'mark','now')").run();
  const before = (await finish()).at(-1)!;
  await env.DB.prepare("UPDATE custom_tags SET label='Renamed',revision=revision+1 WHERE id='mark'").run();
  const changed = await finish(before.cursor);
  expect(JSON.stringify(changed)).toContain('"label":"Renamed"');
  const response = await worker.fetch(new Request("https://sync.example/api/bookmarks/1/v2-override", {
    method:"POST", headers:{...headers,"Content-Type":"application/json"}, body:JSON.stringify({operation_key:"sync-manual-tag",field:"topics",action:"accept",term:"design",expected_revision:0})
  }), bindings());
  expect(response.status).toBe(200);
  const manual = await finish(changed.at(-1)!.cursor);
  expect(JSON.stringify(manual)).toContain('"design"');
  const snapshot = await env.DB.prepare("INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,created_at) VALUES(1,1,'hash','{}','now')").run();
  await env.DB.prepare("INSERT INTO entity_states(link_id,state,content_revision,content_hash,evidence_snapshot_id,entities,updated_at) VALUES(1,'failed',1,'hash',?,'[]','now')").bind(snapshot.meta.last_row_id).run();
  const entity = await finish(manual.at(-1)!.cursor);
  expect(entity.flatMap(p=>p.items).map(i=>i.id)).toContain(1);
  expect(JSON.stringify(entity)).toContain('"entity_state":"failed"');
  await env.DB.prepare("UPDATE evidence_snapshots SET content_hash='changed' WHERE id=?").bind(snapshot.meta.last_row_id).run();
  const invalidated = await finish(entity.at(-1)!.cursor);
  expect(JSON.stringify(invalidated)).toContain('"entity_state":"stale"');
});

it("never acknowledges a retention gap introduced while reading a page", async () => {
  await create(1); const cursor=(await finish()).at(-1)!.cursor;
  await env.DB.prepare("UPDATE links SET note='new' WHERE id=1").run();
  const response=await librarySyncRoute(new Request(`https://sync.example/api/sync?cursor=${encodeURIComponent(cursor)}`, {headers}), bindings(), async () => {
    await env.DB.prepare("UPDATE library_sync_changes SET created_at=0").run(); await maintainLibrarySync(bindings()); return [];
  });
  expect(response.status).toBe(409); expect(await response.json()).toEqual({error:"reset_required"});
});

it("rejects stale media versions and keeps authorized old image clients compatible", async () => {
  await create(1); const key=`enrichment/1/${"b".repeat(64)}.png`;
  await env.ENRICHMENT_IMAGES.put(key,"first",{httpMetadata:{contentType:"image/png"}});
  await env.DB.prepare("UPDATE links SET images=? WHERE id=1").bind(JSON.stringify([{key}])).run();
  const old=await env.ENRICHMENT_IMAGES.head(key);
  await env.ENRICHMENT_IMAGES.put(key,"new",{httpMetadata:{contentType:"image/png"}});
  const request=(extra:Record<string,string>)=>worker.fetch(new Request(`https://sync.example/api/images/${key}`,{headers:{...headers,...extra}}),bindings());
  expect((await request({"If-Match":old!.httpEtag})).status).toBe(412);
  expect(new TextDecoder().decode(await (await request({})).arrayBuffer())).toBe("new");
  expect((await request({Authorization:"Bearer revoked"})).status).toBe(401);
  const cursor=(await finish()).at(-1)!.cursor;
  const rotated=await worker.fetch(new Request(`https://sync.example/api/sync?cursor=${encodeURIComponent(cursor)}`,{headers:{...headers,Authorization:"Bearer replacement"}}),{...bindings(),CAIRN_API_TOKEN:"replacement"});
  expect(rotated.status).toBe(400);
});
