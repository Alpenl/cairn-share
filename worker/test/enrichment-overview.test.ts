import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";

const bindings = () => ({ DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
  CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });

async function call(path: string, token = "internal", method = "GET") {
  return worker.fetch(new Request(`https://test.example/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token}` }
  }), bindings());
}

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

it("omits the unused search projection and retains the overview index", async () => {
  const columns = await env.DB.prepare("PRAGMA table_xinfo(links)").all<{ name: string }>();
  expect(columns.results.some(row => row.name === "search_text")).toBe(false);
  expect(columns.results.some(row => row.name === "is_x")).toBe(true);
  const schema = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type IN ('index','trigger')").all<{ name: string }>();
  expect(schema.results.some(row => row.name.includes("search_text"))).toBe(false);
  expect(schema.results.some(row => row.name === "links_is_x_status_idx")).toBe(true);
});

it("keeps the single-row overview private, versioned and generation cached", async () => {
  expect((await call("enrichment/overview", "app")).status).toBe(401);
  expect((await call("enrichment/overview", "internal", "POST")).status).toBe(405);
  expect((await call("enrichment/overview?curation_status=kept")).status).toBe(400);
  const first = await call("enrichment/overview");
  expect(first.status).toBe(200);
  expect(first.headers.get("X-Cairn-Cache")).toBe("MISS");
  expect(await first.json()).toEqual({ version: 1,
    views: { all: 0, inbox: 0, kept: 0, compiled: 0, drop: 0, uncertain: 0 },
    counts: { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, exhausted: 0, unsupported: 0 },
    attention: 0, queued: 0 });
  expect(first.headers.get("Cache-Control")).toBe("private, no-store");
  const generation = await env.DB.prepare("SELECT value FROM cache_metadata WHERE key='links_generation'").first<number>("value");
  const cacheUrl = `https://cairn-share-cache.internal/api/enrichment/overview?v=5&g=${generation}&host=test.example`;
  const stored = await caches.default.match(new Request(cacheUrl));
  expect(stored?.headers.get("Cache-Control")).toBe("public, max-age=900, s-maxage=900");
  expect((await call("enrichment/overview")).headers.get("X-Cairn-Cache")).toBe("HIT");
});

it("accepts the common tag negotiation header without injecting an overview query", async () => {
  const current = (query = "", aware = true) => worker.fetch(new Request(`https://test.example/api/enrichment/overview${query}`, {
    headers: { Authorization: "Bearer internal", ...(aware ? { "X-Cairn-Tag-System": "1" } : {}) }
  }), bindings());
  const response = await current();
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("X-Cairn-Tag-System")).toBe("1");
  const payload = await response.json();
  const legacy = await current("", false);
  expect(legacy.status).toBe(200);
  expect(await legacy.json()).toEqual(payload);
  expect((await current()).headers.get("X-Cairn-Cache")).toBe("HIT");
  expect((await current("?tag_system=1")).status).toBe(400);
  expect((await current("?curation_status=kept")).status).toBe(400);
});

it("matches every list view and invalidates on a curation/status/url edit", async () => {
  const urls = [
    "https://x.com/a/status/1", "https://twitter.com/b/status/2",
    "http://www.X.com/c/status/3", "https://example.com/article/4"
  ];
  const ids: number[] = [];
  for (const url of urls) {
    const result = await env.DB.prepare("INSERT INTO links(url,note,created_at) VALUES (?,'','2026-09-29T00:00:00Z') RETURNING id")
      .bind(url).first<{ id: number }>();
    ids.push(result!.id);
  }
  await env.DB.prepare("UPDATE links SET curation_status='kept',curation='{}',enrichment_status='completed' WHERE id=?").bind(ids[0]).run();
  await env.DB.prepare("UPDATE links SET curation_status='compiled',curation='{}',enrichment_status='processing' WHERE id=?").bind(ids[1]).run();
  await env.DB.prepare("UPDATE links SET enrichment_status='failed',classification=? WHERE id=?")
    .bind('{"uncertainty":true}', ids[2]).run();
  const generated = await env.DB.prepare("SELECT id,is_x FROM links ORDER BY id").all<{ id: number; is_x: number }>();
  expect(generated.results.map(row => row.is_x)).toEqual([1, 1, 1, 0]);

  const first = await call("enrichment/overview");
  expect(first.headers.get("X-Cairn-Cache")).toBe("MISS");
  const overview = await first.json() as {
    version: number; views: Record<string, number>; counts: Record<string, number>; attention: number; queued: number
  };
  expect(overview.version).toBe(1);
  expect(overview.views).toEqual({ all: 4, inbox: 2, kept: 1, compiled: 1, drop: 0, uncertain: 2 });
  expect(overview.counts).toEqual({ total: 4, pending: 0, processing: 1, completed: 1,
    failed: 1, exhausted: 0, unsupported: 1 });
  expect([overview.attention, overview.queued]).toEqual([1, 1]);
  for (const [name, query] of [
    ["all", ""], ["inbox", "curation_status=inbox"], ["kept", "curation_status=kept"],
    ["compiled", "curation_status=compiled"], ["drop", "curation_status=drop"],
    ["uncertain", "uncertain=true"]
  ]) {
    const list = await call(`enrichment/jobs?view=summary&limit=1&${query}`);
    expect(list.status).toBe(200);
    expect((await list.json() as { counts: { total: number } }).counts.total, name).toBe(overview.views[name]);
  }
  expect((await call("enrichment/overview")).headers.get("X-Cairn-Cache")).toBe("HIT");
  await env.DB.prepare("UPDATE links SET curation_status='drop' WHERE id=?").bind(ids[2]).run();
  const afterCuration = await call("enrichment/overview");
  expect(afterCuration.headers.get("X-Cairn-Cache")).toBe("MISS");
  expect((await afterCuration.json() as { views: Record<string, number> }).views.drop).toBe(1);
  await env.DB.prepare("UPDATE links SET url='https://example.com/changed' WHERE id=?").bind(ids[2]).run();
  expect((await env.DB.prepare("SELECT is_x FROM links WHERE id=?").bind(ids[2]).first<{ is_x: number }>())?.is_x).toBe(0);
  const afterUrl = await call("enrichment/overview");
  expect(afterUrl.headers.get("X-Cairn-Cache")).toBe("MISS");
  expect((await afterUrl.json() as { counts: { unsupported: number } }).counts.unsupported).toBe(2);
  const plan = await env.DB.prepare(
    "EXPLAIN QUERY PLAN SELECT is_x,enrichment_status,COUNT(*) FROM links INDEXED BY links_is_x_status_idx GROUP BY is_x,enrichment_status"
  ).all<{ detail: string }>();
  expect(plan.results.some(row => row.detail.includes("links_is_x_status_idx"))).toBe(true);
});

it("bounds the repeated 2,000-item overview to generation reads", async () => {
  await env.DB.prepare(`WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<2000)
    INSERT INTO links(url,note,created_at,curation_status)
    SELECT CASE WHEN id%2=0 THEN 'https://x.com/scale/status/'||id ELSE 'https://example.com/scale/'||id END,
      '', '2026-09-29T00:00:00Z', CASE WHEN id%3=0 THEN 'kept' ELSE 'inbox' END FROM n`).run();
  const statements: Array<{ sql: string; bindings: Array<string | number> }> = [];
  const database = {
    prepare(sql: string) {
      const prepared = env.DB.prepare(sql);
      return new Proxy(prepared, {
        get(target, key) {
          if (key === "bind") return (...bindings: Array<string | number>) => {
            statements.push({ sql, bindings });
            return target.bind(...bindings);
          };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    },
    batch(batch: D1PreparedStatement[]) { return env.DB.batch(batch); }
  } as unknown as D1Database;
  const request = (path: string) => worker.fetch(new Request(`https://test.example/api/${path}`, {
    headers: { Authorization: "Bearer internal" }
  }), { ...bindings(), DB: database });

  expect((await request("enrichment/overview")).headers.get("X-Cairn-Cache")).toBe("MISS");
  for (let index = 0; index < 20; index++) {
    expect((await request("enrichment/overview")).headers.get("X-Cairn-Cache")).toBe("HIT");
  }
  const aggregate = statements.filter(item => item.sql.includes("WITH view_counts AS"));
  expect(aggregate).toHaveLength(1);
  const aggregateResult = await env.DB.prepare(aggregate[0].sql).bind(...aggregate[0].bindings).all();
  for (const query of ["", "curation_status=inbox", "curation_status=kept", "curation_status=compiled",
    "curation_status=drop", "uncertain=true"]) {
    expect((await request(`enrichment/jobs?view=summary&limit=1&${query}`)).status).toBe(200);
  }
  const oldCounts = statements.filter(item => item.sql.includes("SELECT COUNT(*) AS total") &&
    !item.sql.includes("WITH view_counts AS"));
  expect(oldCounts).toHaveLength(6);
  let oldRowsRead = 0;
  for (const query of oldCounts) {
    const result = await env.DB.prepare(query.sql).bind(...query.bindings).all();
    oldRowsRead += result.meta.rows_read;
  }
  expect(aggregateResult.meta.rows_read).toBeGreaterThan(0);
  expect(oldRowsRead).toBeGreaterThan(aggregateResult.meta.rows_read);
  console.log("D2 local rows-read sample", JSON.stringify({ items: 2000,
    aggregate_miss: aggregateResult.meta.rows_read, six_count_queries: oldRowsRead,
    aggregate_queries_for_21_polls: aggregate.length }));
}, 30_000);
