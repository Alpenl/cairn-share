import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker, { bookmarkFilters } from "../src/index";
import { readSelectionSnapshot } from "../src/selection-state";
import { searchGrams } from "../src/search-index";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const modern = { "X-Cairn-Tag-System": "1", "X-Cairn-Content-Functions": "1" };
const bindings = (DB = env.DB, bucket = env.ENRICHMENT_IMAGES) => ({ DB, ENRICHMENT_IMAGES: bucket, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
async function call(path: string, DB = env.DB, headers: Record<string,string> = modern, bucket = env.ENRICHMENT_IMAGES) {
  return worker.fetch(new Request(`https://performance.test/api/${path}`, { headers: { Authorization: `Bearer ${path.startsWith("enrichment") || path.startsWith("v2/") ? "internal" : "app"}`, ...headers } }), bindings(DB, bucket));
}
async function seed(id: number, text = "") {
  await env.DB.prepare("INSERT INTO links(id,url,note,created_at,original_text) VALUES(?,?,'','2026-01-01',?)")
    .bind(id, `https://example.com/${id}`, text).run();
}
function metrics(response: Response) {
  const raw = response.headers.get("Server-Timing") ?? "";
  return Object.fromEntries([...raw.matchAll(/([\w-]+);(?:dur=([\d.]+)|desc="([\d.]+)")/g)].map(m => [m[1], Number(m[2] ?? m[3])]));
}

it("reads tags, source availability and custom definitions at one SQL snapshot and avoids full manual context", async () => {
  await seed(1, "available source");
  await env.DB.prepare("INSERT INTO custom_tags(id,owner_id,label,normalized_label,revision,status,created_at,updated_at) VALUES('a','default','A','a',1,'active','t','t')").run();
  await env.DB.prepare("INSERT INTO custom_tag_links(link_id,tag_id,created_at) VALUES(1,'a','t')").run();
  const snapshot = await readSelectionSnapshot(bindings(), 1, false, -1, true, true);
  expect(snapshot!.link).toMatchObject({ source_available: 1 });
  let changed = false;
  const DB = new Proxy(env.DB, { get(target, key) {
    if (key !== "prepare") { const value = Reflect.get(target,key); return typeof value === "function" ? value.bind(target) : value; }
    return (sql: string) => {
      const wrap = (s: D1PreparedStatement): D1PreparedStatement => new Proxy(s, { get(t,k) {
        if (k === "bind") return (...args: unknown[]) => wrap(t.bind(...args));
        if (k === "first") return async (...args: unknown[]) => {
          const result = await (t.first as (...v: unknown[]) => Promise<unknown>)(...args);
          if (!changed && sql.includes("AS tag_origins")) {
            changed = true;
            await env.DB.prepare("UPDATE links SET original_text='' WHERE id=1").run();
            await env.DB.prepare("DELETE FROM custom_tag_links WHERE link_id=1").run();
          }
          return result;
        };
        const value = Reflect.get(t,k); return typeof value === "function" ? value.bind(t) : value;
      } });
      return wrap(target.prepare(sql));
    };
  } });
  const response = await call("bookmarks/1/tags", DB);
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  expect(body.source_state.status).toBe("available"); expect(body.custom_tags.map((t:any)=>t.id)).toEqual(["a"]);
  expect(metrics(response)["sql-count"]).toBeLessThanOrEqual(2); // one tag query plus an optional cold policy read
  const next = await call("bookmarks/1/tags");
  expect(await next.json()).toMatchObject({ source_state: { status: "empty" }, custom_tags: [] });
  expect(metrics(next)["sql-count"]).toBe(1); // cached policy retains object-independent identity
});

it("keeps exact Chinese, punctuation, escaped wildcard, Unicode and multi-term substring semantics", async () => {
  await seed(1, "AI写真 Portrait 100% foo_bar Éclair 😀写真");
  await seed(2, "AI模型 PORTRAIT 1000 fooxbar éclair");
  await seed(3, "后半段\0写真");
  await env.DB.prepare("UPDATE links SET summary='LateFieldNeedle' WHERE id=3").run();
  for (const q of ["写真", "portrait", "100%", "foo_bar", "Éc", "éc", "😀写", "AI 写真", "真", "写真missing", "LateFieldNeedle", "AI\0missing"]) {
    const filter = bookmarkFilters(new URL("https://test"), q);
    if (filter instanceof Response) throw new Error("bad query");
    const optimized = await env.DB.prepare(`SELECT id FROM links WHERE ${filter.clauses.join(" AND ")} ORDER BY id`).bind(...filter.bindings).all<{id:number}>();
    const legacyClauses = filter.clauses.filter(c => !c.includes("bookmark_search_grams"));
    const legacy = await env.DB.prepare(`SELECT id FROM links WHERE ${legacyClauses.join(" AND ")} ORDER BY id`).bind(...filter.bindings.slice(filter.clauses[0].includes("bookmark_search_grams") ? 1 : 0)).all<{id:number}>();
    expect(optimized.results,q).toEqual(legacy.results);
  }
  expect(searchGrams(["ÉC"])).toEqual(["C389", "8963"]);
  await env.DB.prepare("DELETE FROM links WHERE id=1").run();
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM bookmark_search_grams WHERE link_id=1").first("n")).toBe(0);
});

it("aggregates backstage attention and overview in one D1 round trip with bounded summary bodies", async () => {
  for (let id=1;id<=4;id++) await seed(id,"body omitted");
  await env.DB.prepare("UPDATE links SET url='https://x.com/u/status/'||id,enrichment_status=CASE id WHEN 1 THEN 'failed' WHEN 2 THEN 'exhausted' WHEN 3 THEN 'pending' ELSE 'completed' END").run();
  expect((await call("enrichment/backstage")).status).toBe(409);
  const r = await call("enrichment/backstage",env.DB,{...modern,"X-Cairn-Backstage":"1"});
  expect(r.status).toBe(200);expect(r.headers.get("X-Cairn-Backstage")).toBe("1");
  const body=await r.json() as any;
  expect(body.attention.map((b:any)=>b.id)).toEqual([2,1]);expect(body.attention_total).toBe(2);
  expect(body.overview.counts).toEqual(body.counts);expect(body.overview.attention).toBe(2);
  expect(body.attention.every((b:any)=>b.original_text===null&&b.translated_text===null&&b.content_loaded===false)).toBe(true);
  expect(metrics(r)["db-round-trips"]).toBe(1);expect(metrics(r)["sql-count"]).toBe(2);
});

it("uses selective indexed candidates in 2k/10k collections and builds maximum-length Unicode bodies without truncation", async () => {
  const measurements: Record<string,unknown>[]=[];
  for(const size of [2000,10000]) {
    const started=performance.now();
    await env.DB.prepare(`WITH RECURSIVE n(id) AS(VALUES(?) UNION ALL SELECT id+1 FROM n WHERE id<?)
      INSERT INTO links(id,url,note,created_at,original_text) SELECT id,'https://example.com/'||id,'','t','ordinary repeated source 中文内容 repeated source' FROM n`)
      .bind(size===2000?1:2001,size).run();
    await env.DB.prepare("UPDATE links SET summary='超稀有needleZxy' WHERE id=1").run();
    const filter=bookmarkFilters(new URL("https://test"),"稀有needleZxy");if(filter instanceof Response)throw new Error("bad query");
    const sql=`SELECT id FROM links WHERE ${filter.clauses.join(" AND ")}`;
    const plan=await env.DB.prepare("EXPLAIN QUERY PLAN "+sql).bind(...filter.bindings).all<{detail:string}>();
    expect(plan.results.some(r=>r.detail.includes("bookmark_search_grams")&&/SEARCH/.test(r.detail))).toBe(true);
    expect(plan.results.some(r=>/SCAN curation_overrides|effective_entity_terms/.test(r.detail))).toBe(false);
    const result=await env.DB.prepare(sql).bind(...filter.bindings).all<{id:number}>();expect(result.results).toEqual([{id:1}]);
    expect(result.meta.rows_read).toBeLessThan(size);
    measurements.push({links:size,fixture_ms:performance.now()-started,query_rows_read:result.meta.rows_read,
      postings:await env.DB.prepare("SELECT COUNT(*) n FROM bookmark_search_grams").first("n")});
  }
  const body="中文長正文".repeat(20000); // exactly 100k characters, per stored body limit
  let started=performance.now();
  await env.DB.prepare("UPDATE links SET original_text=?,translated_text=?,summary='TailUniqueNeedle' WHERE id=1").bind(body,body).run();
  const write=performance.now()-started;
  started=performance.now();await env.DB.prepare("UPDATE links SET original_text=? WHERE id=1").bind(body.slice(0,-1)+"尾").run();
  const update=performance.now()-started;
  const doc=await env.DB.prepare("SELECT length(document) n FROM bookmark_search_documents WHERE link_id=1").first<number>("n");expect(doc).toBeGreaterThan(200000);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM bookmark_search_grams WHERE link_id=1 AND gram='756E'").first("n")).toBe(1);
  measurements.push({max_body_characters:body.length,insert_bodies_ms:write,update_body_ms:update,document_characters:doc});
  console.log("performance search workload",JSON.stringify(measurements));
},120_000);

it("transactionally materializes current entity terms and handles human reset, source staleness and deletion", async () => {
  await seed(1, "source");
  await env.DB.prepare("INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,completeness,truncated,created_at) VALUES(1,1,'h','{}','complete',0,'t')").run();
  const sid = await env.DB.prepare("SELECT id FROM evidence_snapshots WHERE link_id=1").first<number>("id");
  await env.DB.prepare("INSERT INTO entity_states(link_id,state,content_revision,entities,content_hash,evidence_snapshot_id,updated_at) VALUES(1,'completed_nonempty',1,'[\"RareEntity\"]','h',?,'t')").bind(sid).run();
  const assertCurrent = async () => {
    const a = await env.DB.prepare("SELECT link_id,term FROM effective_entity_memberships ORDER BY link_id,term").all();
    const b = await env.DB.prepare("SELECT link_id,term FROM effective_entity_terms ORDER BY link_id,term").all();
    expect(a.results).toEqual(b.results);
  };
  await assertCurrent();
  for (const [revision,action] of [[1,"reject"],[2,"reset"],[3,"set_empty"],[4,"reset"]] as const) {
    await env.DB.prepare("INSERT INTO curation_overrides(link_id,field,term,action,source,confirmed,revision,operation_key,created_at) VALUES(1,'entities',?,?,'human',1,?,?,'t')")
      .bind(action === "set_empty" ? "" : "RareEntity", action, revision, `op-${revision}`).run();
    await assertCurrent();
  }
  await env.DB.prepare("UPDATE links SET content_revision=2 WHERE id=1").run(); await assertCurrent();
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM effective_entity_memberships").first("n")).toBe(0);
  await env.DB.prepare("DELETE FROM links WHERE id=1").run(); await assertCurrent();
});

it("backfills old sources and human entity assertions and updates documents under outer UPSERT policies", async () => {
  await reset();
  await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(0,-1));
  await seed(1,"old 中文 source");
  await env.DB.prepare("INSERT INTO curation_overrides(link_id,field,term,action,source,revision,operation_key,created_at) VALUES(1,'entities','HumanEntity','accept','human',1,'legacy','t')").run();
  const before = await env.DB.prepare("SELECT original_text,personal_revision FROM links WHERE id=1").first();
  await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(-1));
  expect(await env.DB.prepare("SELECT original_text,personal_revision FROM links WHERE id=1").first()).toEqual(before);
  expect((await env.DB.prepare("SELECT term FROM effective_entity_memberships WHERE link_id=1").all()).results).toEqual([{term:"HumanEntity"}]);
  await env.DB.prepare(`INSERT INTO links(id,url,note,created_at,original_text) VALUES(1,'https://example.com/1','','t','new 写真 source')
    ON CONFLICT(id) DO UPDATE SET original_text=excluded.original_text`).run();
  await env.DB.prepare(`INSERT INTO entity_states(link_id,state,entities,updated_at) VALUES(1,'failed','[]','t')
    ON CONFLICT(link_id) DO UPDATE SET state=excluded.state`).run();
  const document = await env.DB.prepare("SELECT document FROM bookmark_search_documents WHERE link_id=1").first<string>("document");
  expect(document).toContain("new 写真 source");expect(document).toContain("HumanEntity");expect(document).not.toContain("old 中文 source");
  const counts = await env.DB.prepare("SELECT gram,link_count FROM bookmark_search_gram_counts ORDER BY gram").all();
  const actual = await env.DB.prepare("SELECT gram,COUNT(*) AS link_count FROM bookmark_search_grams GROUP BY gram ORDER BY gram").all();
  expect(counts.results).toEqual(actual.results);
});

it("records all tag/count/taxonomy policy and conditional-image DB/R2 calls without changing privacy fences", async () => {
  await seed(1); const key = `enrichment/1/${"a".repeat(64)}.png`;
  await env.ENRICHMENT_IMAGES.put(key,new Uint8Array([1,2,3]),{httpMetadata:{contentType:"image/png"}});
  await env.DB.prepare("UPDATE links SET images=? WHERE id=1").bind(JSON.stringify([{key,content_type:"image/png"}])).run();
  const imageHeaders={...modern,"X-Cairn-Image-Privacy":"1"};
  for (const path of ["tag-counts", "v2/taxonomy"]) {
    const r = await call(path); expect(r.status).toBe(200); expect(metrics(r)["sql-count"]).toBeGreaterThanOrEqual(1);
    expect(metrics(r).db).toBeGreaterThanOrEqual(0); expect(metrics(r)["rows-read-unknown"]).toBeGreaterThanOrEqual(0);
  }
  const image = await call(`images/${key}`,env.DB,imageHeaders); expect(image.status).toBe(200); expect(image.headers.get("X-Cairn-Image-Privacy")).toBe("1");
  expect(metrics(image)["sql-count"]).toBe(2); expect(metrics(image)["r2-calls"]).toBe(1);
  const conditional = await call(`images/${key}`,env.DB,{...imageHeaders,"If-None-Match":image.headers.get("ETag")!});
  expect(conditional.status).toBe(304); expect(conditional.headers.get("ETag")).toBe(image.headers.get("ETag"));
  expect(metrics(conditional)["sql-count"]).toBe(2); expect(metrics(conditional)["r2-calls"]).toBe(1);
  await env.ENRICHMENT_IMAGES.put(key,new Uint8Array([4,5,6]),{httpMetadata:{contentType:"image/png"}});
  const changed = await call(`images/${key}`,env.DB,{...imageHeaders,"If-None-Match":image.headers.get("ETag")!});
  expect(changed.status).toBe(200);expect(changed.headers.get("ETag")).not.toBe(image.headers.get("ETag"));
  await env.DB.prepare("UPDATE links SET images='[]' WHERE id=1").run();
  expect((await call(`images/${key}`,env.DB,{...imageHeaders,"If-None-Match":changed.headers.get("ETag")!})).status).toBe(404);
  await env.DB.prepare("DELETE FROM links WHERE id=1").run();
  expect((await call(`images/${key}`,env.DB,{...imageHeaders,"If-None-Match":image.headers.get("ETag")!})).status).toBe(404);
});

it("rechecks current image membership after conditional R2 reads, including metadata-only 304 candidates", async () => {
  for (const mutation of ["remove", "delete"] as const) {
    const id = mutation === "remove" ? 1 : 2;
    await seed(id);
    const key = `enrichment/${id}/${"a".repeat(64)}.png`;
    const object = await env.ENRICHMENT_IMAGES.put(key, "private body");
    await env.DB.prepare("UPDATE links SET images=? WHERE id=?").bind(JSON.stringify([{key,content_type:"image/png"}]),id).run();
    const bucket = new Proxy(env.ENRICHMENT_IMAGES, { get(target,property) {
      if (property === "get") return async (...args: Parameters<R2Bucket["get"]>) => {
        const result = await target.get(...args);
        expect(result).not.toBeNull();
        expect(result && "body" in result).toBe(false);
        if (mutation === "remove") await env.DB.prepare("UPDATE links SET images='[]' WHERE id=?").bind(id).run();
        else await env.DB.prepare("DELETE FROM links WHERE id=?").bind(id).run();
        return result;
      };
      const value = Reflect.get(target,property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const response = await call(`images/${key}`,env.DB,{...modern,"X-Cairn-Image-Privacy":"1","If-None-Match":object!.httpEtag},bucket);
    expect(response.status).toBe(404);
    expect(response.headers.get("ETag")).toBeNull();
    expect(response.headers.get("X-Cairn-Image-Privacy")).toBeNull();
  }
});
