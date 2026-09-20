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
  return response.json() as Promise<{ id: number; lease_token: string; revision: number; target_generation: number; spec_id: string; original_text: string; context_text: string }>;
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
  // NOTE: a note is a personal annotation. It must not discard the stored
  // source snapshot or trigger a refetch (B01-T07), but it does still invalidate
  // a completion computed against the previous job revision.
  expect((await request(`links/${id}`, { note: "changed" }, "PATCH", "app")).status).toBe(200);
  expect((await request(`enrichment/classifications/${id}/complete`, completion(current))).status).toBe(409);
  expect((await request(`enrichment/jobs/${id}/source`, undefined, "GET")).status).toBe(200);
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
  // A consumer compiled against a different taxonomy is a capability mismatch,
  // not a per-job failure: it must not drain the queue.
  const mismatch = await request("enrichment/classifications/claim", { ...settings, taxonomy_version: "old" });
  expect(mismatch.status).toBe(409);
  expect((await mismatch.json() as { error: string }).error).toBe("capability_mismatch");
  const job = await claim();
  await env.DB.prepare("UPDATE classification_jobs SET lease_until='2000-01-01' WHERE link_id=?").bind(id).run();
  expect((await request(`enrichment/classifications/${id}/complete`, completion(job))).status).toBe(409);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until='2000-01-01' WHERE id=?").bind(id).run();
  expect((await request(`enrichment/jobs/${id}/source`, { lease_token, source })).status).toBe(409);
});

it("reclassifies enrolled sources after policy changes without grabbing active leases", async () => {
  const { id } = await setup();const job = await claim();
  // A consumer announcing a different policy no longer redefines the server
  // target. Under the legacy target it simply finds nothing new to claim, and
  // the existing lease completes normally.
  const next = { ...settings, policy_version: "jev-tags-v2" };
  expect((await request("enrichment/classifications/claim", next)).status).toBe(204);
  expect((await request(`enrichment/classifications/${id}/complete`, completion(job))).status).toBe(200);
  expect((await request("enrichment/classifications/claim", next)).status).toBe(204);
});

// --- B01 acceptance: authoritative target, version competition, idempotency ---

const v2Target = {
  spec_id: "classify-v2",
  spec_hash: "sha256:classify-v2",
  taxonomy_version: "2026-09-20.1",
  policy_version: "jev-tags-v2",
  requested_model: "jev-pinned-1",
  protocol: "v2"
};
const v2Caps = {
  protocol: "v2",
  spec_ids: ["classify-v2"],
  taxonomy_versions: ["2026-09-20.1"],
  policy_versions: ["jev-tags-v2"],
  models: ["jev-pinned-1"]
};

async function switchTarget(body: Record<string, unknown>) {
  return request("enrichment/classifications/target", body);
}

it("does not re-claim a completed target across A/B policy alternation (20 rounds)", async () => {
  const { id, lease_token, source } = await setup();
  const a = { ...settings, policy_version: "policy-a" };
  const b = { ...settings, policy_version: "policy-b" };
  const job = await claim();
  expect((await request(`enrichment/classifications/${id}/complete`, completion(job))).status).toBe(200);
  for (let round = 0; round < 20; round++) {
    expect((await request("enrichment/classifications/claim", round % 2 ? a : b)).status).toBe(204);
  }
  const row = await env.DB.prepare("SELECT status, attempts FROM classification_jobs WHERE link_id=?").bind(id).first<any>();
  expect(row.status).toBe("completed");
  expect(row.attempts).toBe(1);
  // The stored source survives the alternation untouched.
  expect(await (await request(`enrichment/jobs/${id}/source`, undefined, "GET")).json()).toEqual(source);
  void lease_token;
});

it("rejects a v2 claim whose declared capabilities do not match the target", async () => {
  expect((await switchTarget(v2Target)).status).toBe(200);
  const mismatch = await request("enrichment/classifications/claim", { ...v2Caps, models: ["other-model"] });
  expect(mismatch.status).toBe(409);
  expect((await mismatch.json() as { error: string }).error).toBe("capability_mismatch");
  // A legacy consumer cannot grab a v2 job either.
  const legacy = await request("enrichment/classifications/claim", settings);
  expect(legacy.status).toBe(409);
  expect((await legacy.json() as { error: string }).error).toBe("capability_mismatch");
});

it("only hands v2 jobs to a matching consumer and migrates stale generations", async () => {
  const { id } = await setup();
  // Job was enrolled under the legacy generation.
  expect((await switchTarget(v2Target)).status).toBe(200);
  const before = await env.DB.prepare("SELECT target_generation FROM classification_jobs WHERE link_id=?").bind(id).first<any>();
  expect(before.target_generation).toBe(0);
  const claimed = await request("enrichment/classifications/claim", v2Caps);
  expect(claimed.status).toBe(200);
  const job = await claimed.json() as { target_generation: number; spec_id: string; lease_token: string; revision: number };
  expect(job.target_generation).toBe(1);
  expect(job.spec_id).toBe("classify-v2");
});

it("guards completion against a target switch (no stale overwrite)", async () => {
  const { id } = await setup();
  const job = await claim();
  // Switch to v2 while the legacy completion is in flight.
  expect((await switchTarget(v2Target)).status).toBe(200);
  const stale = await request(`enrichment/classifications/${id}/complete`, completion(job));
  expect(stale.status).toBe(409);
  expect((await stale.json() as { error: string }).error).toBe("target_changed");
  const row = await env.DB.prepare("SELECT classification FROM links WHERE id=?").bind(id).first<any>();
  expect(row.classification).toBeNull();
});

it("rolls a target back with a new generation without rewinding", async () => {
  expect((await switchTarget(v2Target)).status).toBe(200);
  const rollback = await switchTarget({ ...v2Target, spec_id: "classify-v1-rollback", spec_hash: "sha256:classify-v1", policy_version: "jev-tags-v1", protocol: "legacy" });
  expect(rollback.status).toBe(200);
  const body = await rollback.json() as { generation: number };
  expect(body.generation).toBe(2);
  const target = await (await request("enrichment/classifications/target", undefined, "GET")).json() as { target: { generation: number; spec_id: string }; supported: boolean };
  expect(target.target.generation).toBe(2);
  expect(target.target.spec_id).toBe("classify-v1-rollback");
});

it("commits a lost completion idempotently by operation key without a second run", async () => {
  const { id } = await setup();
  const job = await claim();
  const body = { ...completion(job), operation_key: "op-1", target_generation: job.target_generation };
  const first = await request(`enrichment/classifications/${id}/complete`, body);
  expect(first.status).toBe(200);
  const row = await env.DB.prepare("SELECT status FROM classification_jobs WHERE link_id=?").bind(id).first<any>();
  expect(row.status).toBe("completed");
  // Replaying the same operation returns the stored response and does not
  // double-write.
  const replay = await request(`enrichment/classifications/${id}/complete`, body);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ id, status: "completed" });
  // Same key, different payload is a hard conflict.
  const conflicting = await request(`enrichment/classifications/${id}/complete`, { ...body, result: { ...body.result, model: "different" } });
  expect(conflicting.status).toBe(409);
  expect((await conflicting.json() as { error: string }).error).toBe("operation_conflict");
});

it("keeps the target read and claim guard atomic under concurrent claims", async () => {
  const { id } = await setup();
  const [a, b] = await Promise.all([
    request("enrichment/classifications/claim", settings),
    request("enrichment/classifications/claim", settings)
  ]);
  const granted = [a, b].filter((r) => r.status === 200);
  expect(granted.length).toBe(1);
  const leases = await Promise.all(granted.map((r) => r.json() as Promise<{ lease_token: string }>));
  const rows = await env.DB.prepare("SELECT lease_token FROM classification_jobs WHERE link_id=?").bind(id).all<any>();
  expect(rows.results.filter((r) => r.lease_token === leases[0].lease_token).length).toBe(1);
});
