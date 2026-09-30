import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { EMPTY_AUTOMATIC } from "../src/domain";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const settings = () => ({ DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
type Flags = "legacy" | "tags" | "functions";
function call(path: string, flags: Flags = "functions", internal = false, body?: unknown) {
  return worker.fetch(new Request(`https://content-functions.test/api/${path}`, {
    method: body ? "PATCH" : "GET", headers: { Authorization: `Bearer ${internal ? "internal" : "app"}`,
      ...(flags !== "legacy" ? { "X-Cairn-Tag-System": "1" } : {}),
      ...(flags === "functions" ? { "X-Cairn-Content-Functions": "1" } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined
  }), settings());
}
async function seed(functions = ["tool", "method", "opinion", "case"], human = true) {
  const created = await env.DB.prepare(`INSERT INTO links(url,note,why,created_at,classification,personal_revision)
    VALUES(?,'personal note','personal reason','2026-09-30T00:00:00Z',?,4)`)
    .bind(`https://x.com/user/status/${crypto.randomUUID()}`, JSON.stringify({ topics: ["ai_coding"], form: "tool", use: "try",
      taxonomy_version: "2026-09-30.1", why_suggestion: "", entities: [], uncertainty: false, discarded_tags: [] })).run();
  const id = created.meta.last_row_id;
  const run = await env.DB.prepare(`INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,target_generation,
    requested_model,policy_version,answers,operation_key,created_at) VALUES(?,1,'s','h',1,'m','p','{}',?,'2026-09-30')`)
    .bind(id, `function-run-${id}`).run();
  await env.DB.prepare(`INSERT INTO classification_decisions(link_id,run_id,content_revision,policy_version,policy,automatic,operation_key,created_at)
    VALUES(?,?,1,'p','{}',?,?,'2026-09-30')`)
    .bind(id, run.meta.last_row_id, JSON.stringify({ ...EMPTY_AUTOMATIC, topics: ["ai_coding"], resource_kinds: ["software"], content_functions: functions }), `function-decision-${id}`).run();
  if (human) for (const [field, term, action, revision] of [
    ["content_function", "method", "reject", 1], ["content_functions", "", "set_empty", 2],
    ["content_function", "opinion", "reset", 3], ["content_functions", "data", "accept", 4]
  ]) await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,revision,source,confirmed,operation_key,created_at)
    VALUES(?,?,?,?,?,'human',1,?,'2026-09-30')`).bind(id, field, term, action, revision, `function-${id}-${revision}`).run();
  await env.DB.prepare(`INSERT INTO current_projections(link_id,content_revision,effective,updated_at)
    VALUES(?,999,'{"content_functions":["poison"]}','2026-09-30')`).bind(id).run();
  return id;
}

it("exposes effective content functions only with both negotiated capabilities on all bookmark reads", async () => {
  const id = await seed();
  const paths = [
    ["enrichment/jobs?view=summary&counts=0", true], [`enrichment/jobs/${id}?include_cache_identity=1`, true],
    ["links?include=enrichment", false], [`links/${id}?include=enrichment&include_cache_identity=1`, false]
  ] as const;
  for (const [path, internal] of paths) for (const flags of ["legacy", "tags", "functions"] as const) {
    const response = await call(path, flags, internal);
    expect(response.status, path).toBe(200);
    const body = await response.json() as any, item = body.items ? body.items[0] : body;
    const classification = internal ? item.classification : item.enrichment.classification;
    expect(classification.topics).toEqual(["ai_coding"]);
    if (flags === "functions") {
      expect(classification.content_functions).toEqual(["opinion", "data"]);
      expect(response.headers.get("X-Cairn-Content-Functions")).toBe("1");
    } else {
      expect(classification).not.toHaveProperty("content_functions");
      expect(response.headers.get("X-Cairn-Content-Functions")).toBeNull();
    }
    if (flags === "legacy") expect(classification).not.toHaveProperty("resource_kinds");
    else expect(classification.resource_kinds).toEqual(["software"]);
  }
  expect(await env.DB.prepare("SELECT note,why,personal_revision FROM links WHERE id=?").bind(id).first())
    .toEqual({ note: "personal note", why: "personal reason", personal_revision: 4 });
});

it("keeps function-aware and prior tag-aware app caches separate and rejects query spoofing", async () => {
  const id = await seed();
  for (const path of ["links?include=enrichment", `links/${id}?include=enrichment`]) {
    const current = await call(path);
    expect(current.headers.get("X-Cairn-Cache")).toBe("MISS");
    const prior = await call(path, "tags");
    expect(prior.headers.get("X-Cairn-Cache")).toBe("MISS");
    const priorBody = await prior.json() as any;
    expect((priorBody.items?.[0] ?? priorBody).enrichment.classification).not.toHaveProperty("content_functions");
    const hit = await call(path);
    expect(hit.headers.get("X-Cairn-Cache")).toBe("HIT");
    const hitBody = await hit.json() as any;
    expect((hitBody.items?.[0] ?? hitBody).enrichment.classification.content_functions).toEqual(["opinion", "data"]);
    const spoof = await call(`${path}&tag_system=1&content_functions_view=1`, "tags");
    expect(spoof.headers.get("X-Cairn-Cache")).toBe("HIT");
    const spoofBody = await spoof.json() as any;
    expect((spoofBody.items?.[0] ?? spoofBody).enrichment.classification).not.toHaveProperty("content_functions");
  }
});

it("shares effective functions between filtering, exact counts and exports without changing prior count shape", async () => {
  const id = await seed();
  await seed(["tool"], false);
  const paths = ["tag-counts?content_functions=opinion", "tag-export?content_functions=opinion"];
  for (const flags of ["tags", "functions"] as const) {
    const count = await (await call(paths[0], flags)).json() as any;
    expect(count.total).toBe(1);
    if (flags === "functions") expect(count.content_functions).toEqual([{ id: "opinion", count: 1 }, { id: "data", count: 1 }]);
    else expect(count).not.toHaveProperty("content_functions");
    const exported = await (await call(paths[1], flags)).json() as any;
    expect(exported.links.map((link: any) => link.id)).toEqual([id]);
    const link = exported.links[0];
    if (flags === "functions") {
      expect(link.content_functions).toEqual(["opinion", "data"]);
      expect(link.tags.filter((tag: any) => tag.dimension === "content_functions")).toMatchObject([
        { id: "opinion", tag_ref: "system/content_functions/opinion", origin: "automatic" },
        { id: "data", tag_ref: "system/content_functions/data", origin: "human", confirmed: true }
      ]);
    } else {
      expect(link).not.toHaveProperty("content_functions");
      expect(link.tags.every((tag: any) => tag.dimension !== "content_functions")).toBe(true);
    }
    const page = await (await call("enrichment/jobs?view=summary&content_functions=opinion", flags, true)).json() as any;
    expect(page.items.map((item: any) => item.id)).toEqual([id]);
  }
});

it("requires tag capability with the function capability and leaves aggregate overview query-free", async () => {
  const invalidHeaders: Array<Record<string, string>> = [{ "X-Cairn-Content-Functions": "1" },
    { "X-Cairn-Tag-System": "1", "X-Cairn-Content-Functions": "2" }];
  for (const headers of invalidHeaders) {
    const response = await worker.fetch(new Request("https://test/api/links", { headers: { Authorization: "Bearer app", ...headers } }), settings());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "capability_mismatch" });
  }
  expect((await call("enrichment/overview", "functions", true)).status).toBe(200);
  const options = await worker.fetch(new Request("https://test/api/links", { method: "OPTIONS" }), settings());
  expect(options.headers.get("Access-Control-Allow-Headers")).toContain("X-Cairn-Content-Functions");
  expect(options.headers.get("Access-Control-Expose-Headers")).toContain("X-Cairn-Content-Functions");
});

it("retains negotiated functions after note and learned updates", async () => {
  const id = await seed();
  for (const body of [{ note: "edited note" }, { learned: true }]) {
    const response = await call(`links/${id}?include=enrichment`, "functions", false, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enrichment: { classification: { content_functions: ["opinion", "data"] } } });
  }
});
