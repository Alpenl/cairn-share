import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { taxonomy } from "../src/curation";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function request(path: string, body?: unknown, method = "POST", token = "internal"): Promise<Response> {
  return worker.fetch(new Request(`https://test.example/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}

async function setup() {
  const create = await request("links", { url: "https://x.com/a/status/123", note: "test" }, "POST", "app");
  const { id } = await create.json() as { id: number };
  const leased = await request(`enrichment/jobs/${id}/claim`);
  const { lease_token } = await leased.json() as { lease_token: string };
  const source = { original_text: "A guide to evaluating LLMs", original_language: "en", context_text: "A related comment",
    related_links: [], image_urls: [], model: "grok-test" };
  expect((await request(`enrichment/jobs/${id}/source`, { lease_token, source })).status).toBe(200);
  return { id, lease_token, source };
}

const settings = { taxonomy_version: taxonomy.version, policy_version: "jev-tags-v1", model: "jev-latest" };
async function claim() {
  const response = await request("enrichment/classifications/claim", settings);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ id: number; lease_token: string; revision: number; original_text: string; context_text: string }>;
}
function completion(job: { lease_token: string; revision: number }) {
  return { ...job, result: { model: "jev-pinned", policy_version: settings.policy_version, answers: {}, usage: { input_tokens: 10, output_tokens: 5 },
    classification: { topics: ["llm", "eval"], form: "method", use: "try", uncertainty: false,
      taxonomy_version: taxonomy.version, why_suggestion: "潜在用途建议：待试。", entities: [], discarded_tags: [] } } };
}

it("persists source before reading succeeds and classifies independently", async () => {
  const { id, lease_token, source } = await setup();
  expect((await request(`enrichment/jobs/${id}/fail`, { lease_token, error: "reading failed" })).status).toBe(200);
  const stored = await request(`enrichment/jobs/${id}/source`, undefined, "GET");
  expect(await stored.json()).toEqual(source);
  const job = await claim();
  expect(job.original_text).toBe(source.original_text);
  expect(job.context_text).toBe(source.context_text);
  expect((await request(`enrichment/classifications/${id}/complete`, completion(job))).status).toBe(200);
  const row = await env.DB.prepare("SELECT original_text,enrichment_status,classification FROM links WHERE id=?").bind(id).first<any>();
  expect(row.original_text).toBe(source.original_text);
  expect(row.enrichment_status).toBe("failed");
  expect(JSON.parse(row.classification).topics).toEqual(["llm", "eval"]);
  expect((await request("enrichment/classifications/claim", settings)).status).toBe(204);
});

it("keeps human curation and stored reading aids when Jev is rerun", async () => {
  const { id, lease_token, source } = await setup();
  expect((await request(`enrichment/jobs/${id}/complete`, { lease_token, original_text: source.original_text,
    ai_title: "测试标题", original_language: "en", translated_text: "中文", summary: "摘要", related_links: [], images: [], model: "grok" })).status).toBe(200);
  const manual = { topics: ["eng"], form: "case", use: "quote" };
  expect((await request(`enrichment/jobs/${id}/curation`, { why: "自己的原因", classification: manual }, "PATCH")).status).toBe(200);
  const job = await claim();
  expect((await request(`enrichment/classifications/${id}/complete`, completion(job))).status).toBe(200);
  const row = await env.DB.prepare("SELECT curation,why,summary,enrichment_status FROM links WHERE id=?").bind(id).first<any>();
  expect(JSON.parse(row.curation)).toEqual(manual);
  expect(row.why).toBe("自己的原因");expect(row.summary).toBe("摘要");expect(row.enrichment_status).toBe("completed");
});

it("rejects old classifications after source or note changes", async () => {
  const { id, lease_token, source } = await setup();
  const old = await claim();
  expect((await request(`enrichment/jobs/${id}/source`, { lease_token, source: { ...source, original_text: "Changed source" } })).status).toBe(200);
  expect((await request(`enrichment/classifications/${id}/complete`, completion(old))).status).toBe(409);
  const current = await claim();
  expect(current.revision).toBeGreaterThan(old.revision);
  expect((await request(`links/${id}`, { note: "changed" }, "PATCH", "app")).status).toBe(200);
  expect((await request(`enrichment/classifications/${id}/complete`, completion(current))).status).toBe(409);
  expect((await request(`enrichment/jobs/${id}/source`, undefined, "GET")).status).toBe(204);
});

it("backs off classification failures without touching retrieval and allows explicit retry", async () => {
  const { id } = await setup();
  const job = await claim();
  expect((await request(`enrichment/classifications/${id}/fail`, { ...job, error: "TypeSafe returned HTTP 429" })).status).toBe(200);
  expect((await request("enrichment/classifications/claim", settings)).status).toBe(204);
  const row = await env.DB.prepare("SELECT enrichment_status,original_text FROM links WHERE id=?").bind(id).first<any>();
  expect(row.enrichment_status).toBe("processing");expect(row.original_text).not.toBeNull();
  expect((await request(`enrichment/classifications/${id}/retry`, {})).status).toBe(200);
  const retry = await claim();expect(retry.revision).toBeGreaterThan(job.revision);
  expect((await request(`enrichment/classifications/${id}/retry`, {})).status).toBe(409);
  expect((await request(`enrichment/classifications/${id}/complete`, completion(job))).status).toBe(409);
});

it("enforces lease expiry, taxonomy version and internal authentication", async () => {
  const { id, lease_token, source } = await setup();
  expect((await request("enrichment/classifications/claim", settings, "POST", "app")).status).toBe(401);
  expect((await request(`enrichment/jobs/${id}/source`, undefined, "GET", "app")).status).toBe(401);
  expect((await request("enrichment/classifications/claim", { ...settings, taxonomy_version: "old" })).status).toBe(400);
  const job = await claim();
  await env.DB.prepare("UPDATE classification_jobs SET lease_until='2000-01-01' WHERE link_id=?").bind(id).run();
  expect((await request(`enrichment/classifications/${id}/complete`, completion(job))).status).toBe(409);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until='2000-01-01' WHERE id=?").bind(id).run();
  expect((await request(`enrichment/jobs/${id}/source`, { lease_token, source })).status).toBe(409);
});

it("reclassifies enrolled sources after policy changes without grabbing active leases", async () => {
  const { id } = await setup();const job = await claim();
  const next = { ...settings, policy_version: "jev-tags-v2" };
  expect((await request("enrichment/classifications/claim", next)).status).toBe(204);
  expect((await request(`enrichment/classifications/${id}/complete`, completion(job))).status).toBe(200);
  expect((await request("enrichment/classifications/claim", next)).status).toBe(200);
});
