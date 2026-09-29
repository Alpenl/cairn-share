import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { storedClassification, validateClassification, taxonomy, type Classification } from "../src/curation";
import { settleFixtureAttempt } from "./provider-attempt-fixture";

const token = "curation-test-token";
const appToken = "curation-app-token";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function request(path: string, method = "GET", body?: unknown, bearer = token): Promise<Response> {
  return worker.fetch(new Request(`https://test.example${path}`, {
    method, headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json",
      "X-Cairn-Provider-Attempt-Ledger": "1",
      ...(path.endsWith("/claim") ? { "X-Cairn-Source-Lease-Admission": "1" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: appToken, CAIRN_ENRICHER_TOKEN: token });
}

async function create(url = "https://x.com/example/status/123"): Promise<number> {
  const response = await request("/api/links", "POST", { url, note: "收藏备注" }, appToken);
  expect(response.status).toBe(201);
  return (await response.json() as { id: number }).id;
}

function classification(extra: Partial<Classification> = {}): Classification {
  return { topics: ["llm"], form: "tool", use: "try", why_suggestion: "参考部署方法", entities: ["项目甲"], uncertainty: false, taxonomy_version: taxonomy.version, discarded_tags: [], ...extra };
}

async function complete(id: number, value: unknown = classification()): Promise<Response> {
  const claim = await worker.fetch(new Request(`https://test.example/api/enrichment/jobs/${id}/claim`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Cairn-Source-Lease-Admission": "1",
      "X-Cairn-Provider-Attempt-Ledger": "1" }
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
    CAIRN_API_TOKEN: appToken, CAIRN_ENRICHER_TOKEN: token });
  expect(claim.status).toBe(200);
  const job = await claim.json() as { lease_token: string };
  if (validateClassification(value) !== null) {
    await settleFixtureAttempt((path, body) => request(`/api/${path}`, "POST", body),
      id, job.lease_token, "reading");
  }
  return request(`/api/enrichment/jobs/${id}/complete`, "POST", {
    lease_token: job.lease_token, original_text: "KV cache original-only 100%_literal", summary: "中文部署摘要",
    related_links: [], images: [], model: "fixture", classification: value
  });
}

async function detail(id: number): Promise<any> {
  return (await request(`/api/enrichment/jobs/${id}`)).json();
}

async function page(query: string): Promise<any> {
  const response = await request(`/api/enrichment/jobs?${query}`);
  expect(response.status).toBe(200);
  return response.json();
}

describe("bookmark curation", () => {
  it("provides the authoritative vocabulary only to the enrichment token", async () => {
    expect((await request("/api/enrichment/taxonomy", "GET", undefined, appToken)).status).toBe(401);
    const response = await request("/api/enrichment/taxonomy");
    expect(await response.json()).toEqual(taxonomy);
    expect(taxonomy.topics.length).toBeLessThanOrEqual(40);
  });

  it("stores AI suggestions in inbox without inventing a confirmed collection reason", async () => {
    const id = await create();
    expect((await complete(id)).status).toBe(200);
    expect(await detail(id)).toMatchObject({ why: "", curation_status: "inbox", classification_reviewed: false, classification: classification() });
    const publicItem = await (await request(`/api/links/${id}`, "GET", undefined, appToken)).json();
    expect(Object.keys(publicItem as object).sort()).toEqual(["created_at", "id", "learned", "learned_at", "note", "url"]);
  });

  it("pins an explicit confirmation and replays it without duplicating overrides", async () => {
    const id = await create();
    expect((await complete(id)).status).toBe(200);
    const row = await env.DB.prepare("SELECT personal_revision FROM links WHERE id=?").bind(id)
      .first<{ personal_revision: number }>();
    const confirm = { classification: { topics: ["llm"], form: "tool", use: "try" },
      expected_revision: row!.personal_revision, operation_key: `confirm-${id}` };
    expect((await request(`/api/links/${id}/curation`, "PATCH", confirm, appToken)).status).toBe(200);
    expect(await detail(id)).toMatchObject({ classification_reviewed: true,
      classification: { topics: ["llm"], form: "tool", use: "try" } });
    const overrides = async () => (await env.DB.prepare("SELECT action,field,term,source,confirmed FROM curation_overrides WHERE link_id=? ORDER BY id")
      .bind(id).all<{ action: string; field: string; term: string; source: string; confirmed: number }>()).results;
    expect(await overrides()).toEqual([
      { action: "set_empty", field: "topics", term: "", source: "human", confirmed: 1 },
      { action: "accept", field: "topics", term: "llm", source: "human", confirmed: 1 },
      { action: "accept", field: "form", term: "tool", source: "human", confirmed: 1 },
      { action: "accept", field: "use", term: "try", source: "human", confirmed: 1 }
    ]);
    expect((await request(`/api/links/${id}/curation`, "PATCH", confirm, appToken)).status).toBe(200);
    expect((await overrides()).length).toBe(4);
    expect((await request(`/api/links/${id}/curation`, "PATCH", {
      ...confirm, classification: { ...confirm.classification, topics: ["eng"] }
    }, appToken)).status).toBe(409);
  });

  it("rejects a stale confirmation after another client edits a tag", async () => {
    const id = await create();
    expect((await complete(id)).status).toBe(200);
    const row = await env.DB.prepare("SELECT personal_revision FROM links WHERE id=?").bind(id)
      .first<{ personal_revision: number }>();
    const edit = await request(`/api/bookmarks/${id}/v2-override`, "POST", {
      field: "topics", term: "llm", action: "reject", operation_key: `reject-${id}`,
      expected_revision: row!.personal_revision
    }, appToken);
    expect(edit.status).toBe(200);
    const stale = await request(`/api/links/${id}/curation`, "PATCH", {
      classification: { topics: ["llm"], form: "tool", use: "try" },
      expected_revision: row!.personal_revision, operation_key: `stale-confirm-${id}`
    }, appToken);
    expect(stale.status).toBe(409);
    expect(await detail(id)).toMatchObject({ classification_reviewed: true,
      classification: { topics: [] } });
  });

  it("rejects unknown, duplicate, oversized, and stale model classifications", async () => {
    const id = await create();
    for (const value of [classification({ topics: ["invented"] }), classification({ topics: ["llm", "llm"] }),
      classification({ topics: ["llm", "eng", "eval", "design"] }), classification({ taxonomy_version: "old" })]) {
      expect((await complete(id, value)).status).toBe(400);
      // End this failed fixture lease before the next validation case.
      await env.DB.prepare("UPDATE links SET enrichment_status = 'pending', enrichment_lease_until = NULL WHERE id = ?").bind(id).run();
    }
    expect((await detail(id)).classification).toBeNull();
  });

  it("preserves human labels and intent while an in-flight enrichment completes", async () => {
    const id = await create();
    const claim = await (await request(`/api/enrichment/jobs/${id}/claim`, "POST")).json() as { lease_token: string };
    await settleFixtureAttempt((path, body) => request(`/api/${path}`, "POST", body),
      id, claim.lease_token, "reading");
    const edit = { why: "  用于项目评审  ", curation_status: "kept", classification: { topics: ["eng"], form: "method", use: "quote" } };
    expect((await request(`/api/enrichment/jobs/${id}/curation`, "PATCH", edit)).status).toBe(200);
    expect((await request(`/api/enrichment/jobs/${id}/complete`, "POST", {
      lease_token: claim.lease_token, original_text: "source", summary: "summary", related_links: [], images: [], model: "test", classification: classification()
    })).status).toBe(200);
    expect(await detail(id)).toMatchObject({ why: "用于项目评审", curation_status: "kept", classification_reviewed: true,
      classification: { topics: ["eng"], form: "method", use: "quote", uncertainty: false, entities: ["项目甲"] } });
    expect((await page("topic=llm")).items).toHaveLength(0);
    expect((await page("topic=eng&curation_status=kept&form=method&use=quote&source=x")).items).toHaveLength(1);
    expect((await request(`/api/enrichment/jobs/${id}/curation`, "PATCH", { classification: null })).status).toBe(200);
    expect(await detail(id)).toMatchObject({ why: "用于项目评审", curation_status: "kept", classification_reviewed: false, classification: { topics: ["llm"] } });
  });

  it("supports curation of WeChat bookmarks without a model claim", async () => {
    const id = await create("https://mp.weixin.qq.com/s/example");
    expect((await request(`/api/enrichment/jobs/${id}/curation`, "PATCH", {
      why: "文章素材", curation_status: "kept", classification: { topics: ["writing"], form: "longform", use: "material" }
    })).status).toBe(200);
    expect(await detail(id)).toMatchObject({ status: "unsupported", attempts: 0, source: "wechat", classification_reviewed: true });
    expect((await page("source=wechat&topic=writing&curation_status=kept")).items).toHaveLength(1);
    expect((await page("source=x")).items).toHaveLength(0);
  });

  it("keeps incomplete and legacy records available for review", async () => {
    const legacy = await create();
    const incomplete = await create();
    expect((await complete(incomplete, classification({ topics: [], uncertainty: false }))).status).toBe(200);
    expect((await page("uncertain=true")).items.map((item: any) => item.id)).toEqual([incomplete, legacy]);
    expect((await detail(incomplete)).classification.uncertainty).toBe(true);
  });

  it("searches reasons, entities and original text with AND terms and literal wildcards", async () => {
    const id = await create();
    await complete(id);
    await request(`/api/enrichment/jobs/${id}/curation`, "PATCH", { why: "项目评审" });
    for (const q of ["项目评审 部署", "项目甲 original-only", "100%_literal"]) {
      expect((await page(`q=${encodeURIComponent(q)}`)).items.map((item: any) => item.id)).toEqual([id]);
    }
    expect((await page("q=100X_literal")).items).toHaveLength(0);
    expect((await page(`q=${encodeURIComponent("项目评审 不存在")}`)).items).toHaveLength(0);
  });

  it("applies facets before pagination and preserves cursor ordering", async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const id = await create();
      ids.push(id);
      await request(`/api/enrichment/jobs/${id}/curation`, "PATCH", { curation_status: i === 1 ? "drop" : "kept" });
    }
    const first = await page("limit=2&curation_status=kept");
    expect(first.items.map((item: any) => item.id)).toEqual([ids[3], ids[2]]);
    const second = await page(`limit=2&curation_status=kept&before_id=${first.next_before_id}`);
    expect(second.items.map((item: any) => item.id)).toEqual([ids[0]]);
    expect(second.next_before_id).toBeNull();
    expect((await page("since=2999-01-01T00:00:00Z")).items).toHaveLength(0);
  });

  it("rejects invalid edits and filters without changing saved data", async () => {
    const id = await create();
    for (const body of [{}, { curation_status: "completed" }, { why: "长".repeat(201) }, { status: "completed" },
      { classification: { topics: ["AI"], form: "tool", use: "try" } }, { classification: { topics: ["llm"], form: "tool", use: "try", surprise: true } }]) {
      expect((await request(`/api/enrichment/jobs/${id}/curation`, "PATCH", body)).status).toBe(400);
    }
    for (const query of ["topic=invented", "form=invented", "source=unknown", "uncertain=false", "since=tomorrow", "curation_status=completed"]) {
      expect((await request(`/api/enrichment/jobs?${query}`)).status).toBe(400);
    }
    expect(await detail(id)).toMatchObject({ why: "", curation_status: "inbox", classification: null });
    expect((await request(`/api/enrichment/jobs/${id}/curation`, "PATCH", { why: "test" }, appToken)).status).toBe(401);
  });

  it("invalidates generated classification while retaining human work after an App edit", async () => {
    const id = await create();
    await complete(id);
    await request(`/api/enrichment/jobs/${id}/curation`, "PATCH", { why: "自己的理由", curation_status: "kept", classification: { topics: ["eng"], form: "method", use: "try" } });
    await request(`/api/links/${id}`, "PATCH", { note: "更新备注" }, appToken);
    // A note is personal: it invalidates the AI classification job but must not
    // discard the stored reading content or force a refetch (B01-T07).
    expect(await detail(id)).toMatchObject({ status: "completed", why: "自己的理由", curation_status: "kept", classification_reviewed: true,
      classification: { topics: ["eng"], why_suggestion: "", entities: [] } });
    const job = await env.DB.prepare("SELECT status FROM classification_jobs WHERE link_id=?").bind(id).first<any>();
    expect(job.status).toBe("pending");
  });

  it("does not requeue v2 inference or clear curation for a note-only edit", async () => {
    const id = await create();
    expect((await complete(id)).status).toBe(200);
    expect((await request(`/api/enrichment/jobs/${id}/curation`, "PATCH", {
      why: "人工理由", classification: { topics: ["eng"], form: "method", use: "try" }
    })).status).toBe(200);
    await env.DB.prepare(`INSERT INTO classification_targets
      (generation,spec_id,spec_hash,taxonomy_version,policy_version,requested_model,protocol,created_at)
      VALUES (1,'v2-spec','hash','test-taxonomy','test-policy','test-model','v2','t')`).run();
    await env.DB.prepare("UPDATE classification_target_state SET generation=1 WHERE id=1").run();
    await env.DB.prepare("UPDATE classification_jobs SET status='completed',attempts=2 WHERE link_id=?")
      .bind(id).run();
    const before = await env.DB.prepare("SELECT revision,input_revision,status,attempts FROM classification_jobs WHERE link_id=?")
      .bind(id).first();

    expect((await request(`/api/links/${id}`, "PATCH", { note: "新的私人备注" }, appToken)).status).toBe(200);
    expect(await env.DB.prepare("SELECT revision,input_revision,status,attempts FROM classification_jobs WHERE link_id=?")
      .bind(id).first()).toEqual(before);
    expect(await detail(id)).toMatchObject({ original_text: "KV cache original-only 100%_literal",
      why: "人工理由", classification_reviewed: true,
      classification: { topics: ["eng"], form: "method", use: "try" } });

    // Source changes still invalidate the same v2 job.
    expect((await request(`/api/links/${id}`, "PATCH", { url: "https://x.com/example/status/456" }, appToken)).status).toBe(200);
    expect(await env.DB.prepare("SELECT status FROM classification_jobs WHERE link_id=?")
      .bind(id).first()).toMatchObject({ status: "waiting_source" });
  });

  it("leaves shelved bookmarks out of automatic model processing", async () => {
    const id = await create();
    await request(`/api/enrichment/jobs/${id}/curation`, "PATCH", { curation_status: "drop" });
    expect((await request("/api/enrichment/jobs/claim", "POST")).status).toBe(204);
    await request(`/api/enrichment/jobs/${id}/curation`, "PATCH", { curation_status: "inbox" });
    expect((await request("/api/enrichment/jobs/claim", "POST")).status).toBe(200);
  });
});

it("personal use stays readable as historical data while new model writes reject it",()=>{
 const old=classification({use:"contra"});
 expect(validateClassification(old)).toBeNull();
 expect(validateClassification(old,true)?.use).toBe("contra");
 expect(storedClassification(JSON.stringify(old),null)?.use).toBe("contra");
 expect(storedClassification(JSON.stringify(classification()),JSON.stringify({topics:[],form:"",use:"contra"}))?.use).toBe("contra");
});
