import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { EMPTY_AUTOMATIC, type AutomaticView } from "../src/domain";
import { readSelectionSnapshots, readTagSummaries } from "../src/selection-state";
import { attachTagSummaries } from "../src/tag-system";
import vectors from "./fixtures/override-vectors.json";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const date = "2026-09-30T00:00:00Z";
const settings = (DB = env.DB) => ({ DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
function call(path: string, DB = env.DB, internal = false, aware = true, functions = false) {
  return worker.fetch(new Request(`https://test/api/${path}`, { headers: {
    Authorization: `Bearer ${internal ? "internal" : "app"}`, ...(aware ? { "X-Cairn-Tag-System": "1" } : {}),
    ...(functions ? { "X-Cairn-Content-Functions": "1" } : {})
  } }), settings(DB));
}
function instrument(afterRead?: (sql: string) => Promise<void>) {
  const reads: Array<{ sql: string; rows: number; bytes: number }> = [];
  const originals = new WeakMap<object, D1PreparedStatement>();
  const sqls = new WeakMap<object, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (["all", "first", "raw", "run"].includes(String(key))) return async (...args: unknown[]) => {
        const result = await (Reflect.get(target, key) as (...args: unknown[]) => Promise<any>).apply(target, args);
        reads.push({ sql, rows: result?.meta?.rows_read ?? 0, bytes: JSON.stringify(result?.results ?? result).length });
        await afterRead?.(sql);
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(proxy, statement); sqls.set(proxy, sql); return proxy;
  };
  const DB = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      const results = await target.batch(statements.map(statement => originals.get(statement) ?? statement));
      results.forEach((result, index) => reads.push({ sql: sqls.get(statements[index]) ?? "batch", rows: result.meta.rows_read,
        bytes: JSON.stringify(result.results).length }));
      return results;
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { DB, reads, get businessReads() { return reads.filter(entry => !entry.sql.includes("FROM observability_policy")); } };
}
async function seed(automatic: AutomaticView, overrides: Array<{ field: string; term: string; action: string; revision: number }>, legacy?: unknown, noDecision = false) {
  const created = await env.DB.prepare("INSERT INTO links(url,created_at,classification) VALUES(?,?,?)")
    .bind(`https://example.com/${crypto.randomUUID()}`, date, JSON.stringify(automatic)).run();
  const id = created.meta.last_row_id;
  if (!noDecision) {
    await env.DB.prepare(`INSERT INTO classification_runs(id,link_id,content_revision,spec_id,spec_hash,target_generation,
      requested_model,policy_version,answers,operation_key,created_at) VALUES(?,?,1,'s','h',1,'m','p','{}',?,?)`)
      .bind(id, id, `run-${id}`, date).run();
    await env.DB.prepare(`INSERT INTO classification_decisions(link_id,run_id,content_revision,policy_version,policy,automatic,operation_key,created_at)
      VALUES(?,?,1,'p','{}',?,?,?)`).bind(id, id, JSON.stringify(automatic), `decision-${id}`, date).run();
  }
  if (legacy !== undefined) await env.DB.prepare(`INSERT INTO legacy_curation_history(link_id,payload,revision,provenance,created_at)
    VALUES(?,?,3,'legacy_unknown',?)`).bind(id, JSON.stringify(legacy), date).run();
  if (overrides.length) await env.DB.batch(overrides.map((entry, index) => env.DB.prepare(`INSERT INTO curation_overrides
    (link_id,field,term,action,revision,source,confirmed,operation_key,created_at) VALUES(?,?,?,?,?,'human',1,?,?)`)
    .bind(id, entry.field, entry.term, entry.action, entry.revision, `${id}-${index}`, date)));
  // Deliberately wrong caches must never supply visible membership.
  await env.DB.prepare(`INSERT INTO current_projections(link_id,content_revision,effective,updated_at)
    VALUES(?,999,'{"topics":["poison"],"resource_kinds":["poison"]}',?)`).bind(id, date).run();
  return id;
}

it("lightweight summaries preserve canonical ordering, legacy barriers, aliases, resets and stale decisions", async () => {
  const ids: number[] = [];
  for (const vector of vectors.vectors) ids.push(await seed({ ...vector.automatic, resource_kinds: ["skill", "prompt"] } as AutomaticView,
    [...vector.overrides, { field: "resource_kinds", term: "", action: "set_empty", revision: 2 },
      { field: "resource_kind", term: "skill", action: "reset", revision: 3 },
      { field: "resource_kind", term: "component", action: "accept", revision: 4 }]));
  for (const legacy of [null, {}, { topics: [] }, { topics: ["llm", "design"] }, { form: "method" }]) {
    for (const noDecision of [false, true]) ids.push(await seed({ ...EMPTY_AUTOMATIC,
      topics: ["ai_coding", "image_creation", "video_creation", "ui_design"], resource_kinds: ["skill"], content_functions: ["tool", "method"] },
    [{ field: "topic", term: "llm", action: "reset", revision: 4 },
      { field: "resource_kind", term: "prompt", action: "accept", revision: 5 },
      { field: "content_function", term: "method", action: "reject", revision: 6 },
      { field: "content_functions", term: "data", action: "accept", revision: 7 }], legacy, noDecision));
  }
  ids.push(await seed({ ...EMPTY_AUTOMATIC, content_functions: ["tool", "method"] }, [
    { field: "content_function", term: "", action: "set_empty", revision: 1 },
    { field: "content_functions", term: "tool", action: "reset", revision: 2 },
    { field: "content_functions", term: "case", action: "accept", revision: 3 }
  ]));
  await env.DB.prepare("UPDATE links SET content_revision=2").run();
  const canonical = await readSelectionSnapshots(settings(), ids);
  const counted = instrument();
  const light = await readTagSummaries(settings(counted.DB), ids);
  expect(counted.reads).toHaveLength(1);
  for (const id of ids) expect(light.summaries.get(id)).toEqual({ topics: canonical.snapshots.get(id)!.view.topics,
    resource_kinds: canonical.snapshots.get(id)!.view.resource_kinds ?? [],
    content_functions: canonical.snapshots.get(id)!.view.content_functions, custom_tags: [] });
  expect((await readTagSummaries(settings(counted.DB), [])).summaries.size).toBe(0);
  expect(counted.reads).toHaveLength(1);
});

async function scaleFixture() {
  const assessment = { version: 1, incomplete: [], decisions: Array.from({ length: 64 }, (_, index) => ({
    dimension: "topics", term_id: `old_${index}`, verdict: "abstained", reason: "evidence ".repeat(60), probability: 0.5
  })) };
  await env.DB.prepare(`WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<500)
    INSERT INTO links(id,url,note,created_at,classification,why,translated_text,curation_status,learned)
    SELECT id,CASE id%4 WHEN 0 THEN 'https://mp.weixin.qq.com/s/' WHEN 2 THEN 'https://example.com/' ELSE 'https://x.com/u/status/' END||id,
      'saved note',CASE WHEN id>250 THEN '2026-09-28T00:00:00Z' ELSE '2026-09-10T00:00:00Z' END,
      '{"topics":["llm"],"form":"method","use":"try"}', 'human reason', 'translated commonNeedle',
      CASE WHEN id%2=0 THEN 'kept' ELSE 'inbox' END,CASE WHEN id%3=0 THEN 1 ELSE 0 END FROM n`).run();
  await env.DB.prepare(`INSERT INTO classification_runs(id,link_id,content_revision,spec_id,spec_hash,target_generation,
    requested_model,policy_version,answers,operation_key,created_at)
    SELECT id,id,1,'s','h',1,'m','p','{}','run-'||id,? FROM links`).bind(date).run();
  await env.DB.prepare(`INSERT INTO classification_decisions(link_id,run_id,content_revision,policy_version,policy,automatic,operation_key,created_at)
    SELECT id,id,1,'p','{}',json_object('topics',json(CASE WHEN id%3=0 THEN '["ai_coding","image_creation"]' ELSE '["ai_coding"]' END),
      'resource_kinds',json(CASE WHEN id%4=0 THEN '["skill","prompt"]' ELSE '["software"]' END),
      'content_functions',json(CASE WHEN id%7=0 THEN '["method","tool"]' ELSE '["opinion"]' END),
      'carriers',json('[]'),'affordances',json('[]'),'form','','use','','entities',json('[]'),
      'assessment',json(?)),'decision-'||id,? FROM links`).bind(JSON.stringify(assessment), date).run();
  await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,revision,source,confirmed,operation_key,created_at)
    SELECT id,'topic','ai_coding','reject',1,'human',1,'reject-'||id,? FROM links WHERE id%5=0`).bind(date).run();
  await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,revision,source,confirmed,operation_key,created_at)
    SELECT id,'resource_kind','','set_empty',2,'human',1,'clear-'||id,? FROM links WHERE id%8=0`).bind(date).run();
  await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,revision,source,confirmed,operation_key,created_at)
    SELECT id,'resource_kind','skill','reset',3,'human',1,'readmit-'||id,? FROM links WHERE id%8=0`).bind(date).run();
  await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,revision,source,confirmed,operation_key,created_at)
    SELECT id,'content_function','opinion','reject',4,'human',1,'reject-function-'||id,? FROM links WHERE id%11=0`).bind(date).run();
  await env.DB.prepare(`INSERT INTO legacy_curation_history(link_id,payload,revision,provenance,created_at)
    SELECT id,'{"topics":["llm"]}',4,'legacy_unknown',? FROM links WHERE id%9=0`).bind(date).run();
  for (const [id, owner, status] of [["shared-a", "default", "active"], ["shared-b", "default", "deprecated"], ["private-c", "other", "active"]]) {
    await env.DB.prepare(`INSERT INTO custom_tags(id,owner_id,label,normalized_label,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .bind(id, owner, id, id, status, date, date).run();
  }
  await env.DB.prepare(`INSERT INTO custom_tag_links(link_id,tag_id,created_at)
    SELECT id,'shared-a',? FROM links WHERE id%2=0 UNION ALL SELECT id,'shared-b',? FROM links WHERE id%3=0
    UNION ALL SELECT id,'private-c',? FROM links`).bind(date, date, date).run();
  await env.DB.prepare(`INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,created_at)
    SELECT id,1,'hash-'||id,'{}',? FROM links`).bind(date).run();
  await env.DB.prepare(`INSERT INTO entity_states(link_id,state,content_revision,entities,updated_at,content_hash,evidence_snapshot_id,observations)
    SELECT l.id,'completed_nonempty',1,'["entity"]',?,'hash-'||l.id,s.id,? FROM links l JOIN evidence_snapshots s ON s.link_id=l.id`)
    .bind(date, JSON.stringify(Array.from({ length: 32 }, () => ({ candidate: { surface: "entity" }, decision: "relevant", reason: "large evidence ".repeat(40) })))).run();
  const ids = Array.from({ length: 500 }, (_, index) => index + 1);
  const snapshots: Awaited<ReturnType<typeof readSelectionSnapshots>>["snapshots"] = new Map();
  for (let start = 0; start < ids.length; start += 100) {
    const batch = await readSelectionSnapshots(settings(), ids.slice(start, start + 100));
    for (const [id, snapshot] of batch.snapshots) snapshots.set(id, snapshot);
  }
  return { ids, snapshots };
}

it("counts all 500 matches in one query and retains ANY/ALL/custom/source/search semantics", async () => {
  const { ids, snapshots } = await scaleFixture();
  const queries = ["", "topics=ai_coding,image_creation&topics_mode=any", "topics=ai_coding,image_creation&topics_mode=all",
    "resource_kind=skill,prompt&resource_mode=all", "custom_tag=shared-a,shared-b&custom_mode=all",
    "content_functions=method,tool", "content_functions=opinion&topics=ai_coding",
    "topics=llm&custom_tags=shared-a,shared-b&custom_mode=any", "source=wechat&curation_status=kept&q=commonNeedle",
    "source=x&since=2026-09-20T00:00:00Z&learned=1", "topics=finance_resources", "custom_tags=absent"];
  for (const query of queries) {
    const params = new URLSearchParams(query);
    const matching = ids.slice().reverse().filter(id => {
      const view = snapshots.get(id)!.view;
      for (const [param, mode, values] of [["topics", "topics_mode", view.topics], ["resource_kind", "resource_mode", view.resource_kinds ?? []],
        [params.has("custom_tag") ? "custom_tag" : "custom_tags", "custom_mode", [...(id%2===0 ? ["shared-a"] : []), ...(id%3===0 ? ["shared-b"] : [])]]] as const) {
        if (!params.has(param)) continue;
        const requested = params.get(param)!.split(",");
        if (params.get(mode) === "all" ? !requested.every(value => values.includes(value)) : !requested.some(value => values.includes(value))) return false;
      }
      if (params.has("content_functions") && !params.get("content_functions")!.split(",").some(term => view.content_functions.includes(term))) return false;
      if (params.get("source") === "wechat" && id%4!==0) return false;
      if (params.get("source") === "x" && id%4!==1 && id%4!==3) return false;
      if (params.get("curation_status") === "kept" && id%2!==0) return false;
      if (params.has("since") && id<=250) return false;
      if (params.get("learned") === "1" && id%3!==0) return false;
      return true;
    });
    const expected = { topics: new Map<string, number>(), resource_kinds: new Map<string, number>(),
      content_functions: new Map<string, number>(), custom_tags: new Map<string, number>() };
    for (const id of matching) {
      const view = snapshots.get(id)!.view;
      for (const field of ["topics", "resource_kinds", "content_functions"] as const) for (const term of view[field] ?? []) expected[field].set(term, (expected[field].get(term) ?? 0)+1);
      for (const tag of [...(id%2===0 ? ["shared-a"] : []), ...(id%3===0 ? ["shared-b"] : [])]) expected.custom_tags.set(tag, (expected.custom_tags.get(tag) ?? 0)+1);
    }
    const counted = instrument();
    const response = await call(`tag-counts?${query}`, counted.DB, false, true, true);
    expect(response.status, query).toBe(200);
    const body = await response.json() as any;
    expect(body.total, query).toBe(matching.length);
    for (const field of ["topics", "resource_kinds", "content_functions", "custom_tags"] as const) expect(new Map(body[field].map((entry: any) => [entry.id, entry.count])), query).toEqual(expected[field]);
    expect(counted.businessReads, query).toHaveLength(1);
    // The existing isolate policy may add one cold-start read; it must not
    // conceal extra business queries or per-bookmark reads.
    expect(counted.reads.length-counted.businessReads.length).toBeLessThanOrEqual(1);
    // Entity state may be required by a search predicate, but must not be read
    // as detailed metadata for every returned bookmark.
    expect(counted.businessReads[0].sql.split("FROM links WHERE")[0]).not.toMatch(/entity_states|classification_decision_runs|classification_jobs/);
  }
  const full = instrument(), light = instrument();
  await readSelectionSnapshots(settings(full.DB), ids.slice(0, 100));
  await full.DB.prepare(`SELECT a.link_id,t.id,t.owner_id,t.label,t.revision,t.status
    FROM custom_tag_links a JOIN custom_tags t ON t.id=a.tag_id WHERE t.owner_id=? AND a.link_id IN(SELECT value FROM json_each(?))`)
    .bind("default", JSON.stringify(ids.slice(0,100))).all();
  const summary = await readTagSummaries(settings(light.DB), ids.slice(0, 100));
  expect(light.reads).toHaveLength(1); expect(summary.summaries.size).toBe(100);
  const previousRows = full.reads.reduce((sum, read) => sum+read.rows,0), previousBytes = full.reads.reduce((sum, read) => sum+read.bytes,0);
  expect(light.reads[0].rows).toBeLessThan(previousRows);
  expect(light.reads[0].bytes).toBeLessThan(previousBytes / 10);
  console.log("tag read local workload", JSON.stringify({ links: 500, sampled: 100,
    previous_rows_read: previousRows, light_rows_read: light.reads[0].rows,
    previous_d1_bytes: previousBytes, light_d1_bytes: light.reads[0].bytes, counts_queries: 1 }));
}, 30_000);

it("negotiated lists use one tag read and old strict lists retain their shape and query budget", async () => {
  await scaleFixture();
  for (const [aware, functions] of [[false, false], [true, false], [true, true]]) {
    const counted = instrument();
    const response = await call("enrichment/jobs?limit=100&view=summary&counts=0", counted.DB, true, aware, functions);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.items).toHaveLength(100);
    expect(body.next_before_id).toBe(401);
    expect(body).not.toHaveProperty("counts");
    expect(counted.businessReads).toHaveLength(aware ? 2 : 1);
    if (aware) {
      expect(body.items[0].classification.resource_kinds).toEqual(["skill", "prompt"]);
      expect(body.items[0].classification.topics).toEqual([]); // human rejects automatic AI coding
      expect(body.items[0].custom_tags.map((tag: any) => tag.id)).toEqual(["shared-a"]);
    } else expect(body.items[0]).not.toHaveProperty("custom_tags");
    if (functions) expect(body.items[0].classification.content_functions).toEqual(["opinion"]);
    else expect(body.items[0].classification?.content_functions).toBeUndefined();
  }
  const counted = instrument();
  const page = await call("enrichment/jobs?limit=40&topics=llm&resource_kind=skill&custom_tag=shared-a", counted.DB, true);
  expect(page.status).toBe(200);
  const listed = await page.json() as any;
  expect(listed.counts.total).toBeGreaterThan(0);
  expect(counted.businessReads).toHaveLength(3); // transactional page/count + one tag snapshot
  for (const item of listed.items) {
    expect(item.classification.topics).toContain("llm");
    expect(item.classification.resource_kinds).toContain("skill");
    expect(item.custom_tags.map((tag: any) => tag.id)).toContain("shared-a");
  }
}, 30_000);

it("system and custom membership stay in one read snapshot across a concurrent update", async () => {
  const id = await seed({ ...EMPTY_AUTOMATIC, topics: ["ai_coding"], resource_kinds: ["skill"], content_functions: ["method"] }, []);
  await env.DB.prepare(`INSERT INTO custom_tags(id,label,normalized_label,created_at,updated_at) VALUES('later','later','later',?,?)`).bind(date, date).run();
  let mutated = false;
  const observed = instrument(async sql => {
    if (mutated || !sql.includes("AS custom_tags")) return;
    mutated = true;
    await env.DB.prepare(`INSERT INTO classification_decisions(link_id,run_id,content_revision,policy_version,policy,automatic,operation_key,created_at)
      VALUES(?,?,1,'p','{}',?,'later-decision',?)`)
      .bind(id, id, JSON.stringify({ ...EMPTY_AUTOMATIC, topics: ["image_creation"], resource_kinds: ["prompt"], content_functions: ["case"] }), date).run();
    await env.DB.prepare("INSERT INTO custom_tag_links(link_id,tag_id,created_at) VALUES(?,'later',?)").bind(id, date).run();
  });
  const first = (await attachTagSummaries(settings(observed.DB), [{ id, classification: {} }], true, true))[0] as any;
  expect(first.classification).toMatchObject({ topics: ["ai_coding"], resource_kinds: ["skill"], content_functions: ["method"] });
  expect(first.custom_tags).toEqual([]);
  expect(observed.reads).toHaveLength(1);
  const next = (await attachTagSummaries(settings(), [{ id, classification: {} }], true, true))[0] as any;
  expect(next.classification).toMatchObject({ topics: ["image_creation"], resource_kinds: ["prompt"], content_functions: ["case"] });
  expect(next.custom_tags.map((tag: any) => tag.id)).toEqual(["later"]);
});
