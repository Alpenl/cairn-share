import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
const bindings = () => ({
  DB: env.DB,
  ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
  CAIRN_API_TOKEN: "app",
  CAIRN_ENRICHER_TOKEN: "internal",
});
async function get(suffix = "", token = "internal") {
  const r = await worker.fetch(
    new Request("https://test/api/enrichment/workspace" + suffix, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    bindings(),
  );
  return { status: r.status, data: (await r.json()) as any };
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(
    Array.from({ length: 43 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO links(id,url,note,created_at,ai_title,original_text,summary,original_language,enrichment_status) VALUES(?,?,'','2026-10-12T01:00:00Z',?,'private long body contains findme','Summary','en',?)",
      ).bind(
        i + 1,
        `https://example.com/${i + 1}`,
        `Article ${i + 1}`,
        i === 0 ? "failed" : "completed",
      ),
    ),
  );
});
it("returns one bounded page and global aggregates without source bodies or leases", async () => {
  const r = await get("?today=2026-10-12");
  expect(r.status).toBe(200);
  expect(r.data.items).toHaveLength(40);
  expect(r.data.total).toBe(43);
  expect(r.data.next_cursor).toBe(4);
  expect(r.data.facets).toMatchObject({ total: 43, failed: 1 });
  expect(r.data.overview).toMatchObject({
    saved: 43,
    tags: 0,
    placed: 0,
    days: [{ day: "2026-10-12", n: 43 }],
  });
  expect(JSON.stringify(r.data)).not.toContain("private long body");
  expect(JSON.stringify(r.data)).not.toContain("lease");
  const page = await get("?cursor=4");
  expect(page.data.items.map((a: any) => a.id)).toEqual([3, 2, 1]);
  expect(page.data.next_cursor).toBeNull();
  expect(page.data.total).toBe(43);
});
it("searches server-side body index and combines date and attention filters", async () => {
  expect(
    (await get("?q=findme&quick=todo")).data.items.map((a: any) => a.id),
  ).toEqual([1]);
  expect((await get("?q=absent")).data.total).toBe(0);
  expect((await get("?range=d1&today=2026-10-12")).data.total).toBe(0);
  expect((await get("?range=1&today=2026-10-12")).data.total).toBe(43);
  expect((await get("?kind=site")).data.total).toBe(0);
});
it("loads body and editable state only when an article is opened", async () => {
  const r = await get("/2");
  expect(r.status).toBe(200);
  expect(r.data.article.raw).toContain("private long body");
  expect(r.data.article.body).toEqual(["private long body contains findme"]);
  expect(r.data.tag_state).toHaveProperty("content_revision");
  await env.DB.prepare("DELETE FROM links WHERE id=2").run();
  expect((await get("/2")).status).toBe(404);
  expect(
    (await get("?q=Article%202")).data.items.every((a: any) => a.id !== 2),
  ).toBe(true);
});
it("rejects invalid filters and requires the internal credential", async () => {
  for (const suffix of [
    "?limit=10000",
    "?cursor=-1",
    "?q=a&q=b",
    "?tags=notjson",
    "?mode=wrong",
    "?collection=bad",
    "?range=d10000",
    "?today=bad",
  ])
    expect((await get(suffix)).status).toBe(400);
  expect((await get("", "app")).status).toBe(401);
});
it("revalidates cached body identity and never serves a deleted or outdated body", async () => {
  const first = await get("/2");
  const rev = first.data.article.bodyRevision;
  expect((await get(`/2?body_revision=${rev}`)).data).toMatchObject({
    body_unchanged: true,
    article: { raw: "", body: [] },
  });
  await env.DB.prepare(
    "UPDATE links SET original_text='New body' WHERE id=2",
  ).run();
  const changed = await get(`/2?body_revision=${rev}`);
  expect(changed.data.body_unchanged).toBe(false);
  expect(changed.data.article.raw).toBe("New body");
  await env.DB.prepare("DELETE FROM links WHERE id=2").run();
  expect((await get(`/2?body_revision=${rev}`)).status).toBe(404);
});
it("keeps complete tag/collection counts while paging members and filtering stable identities", async () => {
  const cid = crypto.randomUUID(),
    tid = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO custom_tags(id,owner_id,label,normalized_label,revision,status,created_at,updated_at) VALUES(?,'default','My tag','my tag',1,'active','2026-10-12','2026-10-12')",
  )
    .bind(tid)
    .run();
  await env.DB.prepare(
    "INSERT INTO collections(id,name,created_at,updated_at,last_operation) VALUES(?,'Set','2026-10-12','2026-10-12','fixture')",
  )
    .bind(cid)
    .run();
  await env.DB.batch(
    Array.from({ length: 43 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO collection_items(collection_id,link_id,position,note,added_at) VALUES(?,?,?,'note','2026-10-12')",
      ).bind(cid, i + 1, i + 1),
    ),
  );
  await env.DB.prepare(
    "INSERT INTO custom_tag_links(link_id,tag_id,created_at) VALUES(1,?,?)",
  )
    .bind(tid, "2026-10-12")
    .run();
  const filtered = await get(
    "?tags=" + encodeURIComponent(JSON.stringify([`custom/default/${tid}`])),
  );
  expect(filtered.data.items.map((a: any) => a.id)).toEqual([1]);
  expect(filtered.data.collections[0].item_count).toBe(43);
  expect(filtered.data.facets.tags[`custom/default/${tid}`]).toBe(1);
  const first = await get("/collections/" + cid);
  expect(first.data.items).toHaveLength(40);
  expect(first.data.next_cursor).toBe(40);
  expect(first.data.next_id).toBe(41);
  const second = await get(`/collections/${cid}?cursor=40`);
  expect(second.data.items.map((a: any) => a.id)).toEqual([41, 42, 43]);
});
