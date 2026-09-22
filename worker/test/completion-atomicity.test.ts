import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { taxonomy } from "../src/curation";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function request(path: string, body: unknown, db = env.DB, token = "internal") {
  return worker.fetch(new Request(`https://test.example/api/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }), { DB: db, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}

async function setup(protocol: "legacy" | "v2") {
  const created = await request("links", { url: "https://x.com/synthetic/status/123" }, env.DB, "app");
  const { id } = await created.json() as { id: number };
  await env.DB.prepare("UPDATE links SET original_text='synthetic source' WHERE id=?").bind(id).run();
  expect((await request(`v2/links/${id}/evidence`, { snapshot: {
    blocks: [{ id: "primary", role: "primary", text: "synthetic source" }],
    retrieval: "manual", fetched_at: "2026-09-22T00:00:00Z", truncation: { truncated: false }
  } })).status).toBe(200);
  expect((await request("v2/question-specs", { spec_id: "classify-v1", spec_version: 1, questions: {} })).status).toBe(200);
  const spec = await env.DB.prepare("SELECT spec_hash FROM question_specs WHERE spec_id='classify-v1'")
    .first<{ spec_hash: string }>();
  const target = { spec_id: "classify-v1", spec_hash: spec!.spec_hash, taxonomy_version: taxonomy.version,
    policy_version: "r3-policy", requested_model: "jev-latest", protocol };
  if (protocol === "v2") expect((await request("enrichment/classifications/target", target)).status).toBe(200);
  const caps = protocol === "v2" ? { protocol, spec_ids: [target.spec_id], taxonomy_versions: [taxonomy.version],
    policy_versions: [target.policy_version], models: [target.requested_model] }
    : { taxonomy_version: taxonomy.version, policy_version: target.policy_version, model: target.requested_model };
  const claimed = await request("enrichment/classifications/claim", caps);
  expect(claimed.status).toBe(200);
  const job = await claimed.json() as Record<string, unknown>;
  const body = { ...job, operation_key: `r3-complete-${id}`, result: {
    model: "jev-pinned", requested_model: target.requested_model, policy_version: target.policy_version,
    answers: {}, classification: { topics: ["llm"], form: "method", use: "try", uncertainty: false,
      taxonomy_version: taxonomy.version, why_suggestion: "", entities: [], discarded_tags: [] },
    ...(protocol === "v2" ? { spec_id: target.spec_id, spec_hash: target.spec_hash,
      automatic: { topics: ["llm"], content_functions: [], carriers: [], affordances: [], entities: [], form: "method", use: "try" } } : {})
  } };
  return { id, job, body, caps, target };
}

// Only scheduling is injected: every SQL statement and the transaction execute
// in workerd's actual local D1. The mutation runs after all endpoint preflight
// reads, immediately before the completion batch, not before the HTTP request.
function beforeBatch(action: () => Promise<void>): { db: D1Database; calls: () => number } {
  let calls = 0;
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        calls++;
        if (calls === 1) await action();
        return target.batch(statements);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { db, calls: () => calls };
}

for (const protocol of ["legacy", "v2"] as const) {
  it(`R3-01 ${protocol}: a concurrent different operation cannot acquire a success receipt`, async () => {
    const { id, body } = await setup(protocol);
    const barrier = beforeBatch(async () => {
      expect((await request(`enrichment/classifications/${id}/complete`, body)).status).toBe(200);
    });
    const other = { ...body, operation_key: "other-operation" };
    expect((await request(`enrichment/classifications/${id}/complete`, other, barrier.db)).status).toBe(409);
    expect((await request(`enrichment/classifications/${id}/complete`, other)).status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM classification_operations WHERE link_id=?").bind(id).first("n")).toBe(1);
  });

  it(`R3-01 ${protocol}: an SQL failure rolls back every success side effect and permits retry`, async () => {
    const { id, body } = await setup(protocol);
    await env.DB.prepare(`CREATE TRIGGER reject_receipt BEFORE INSERT ON classification_operations
      BEGIN SELECT RAISE(ABORT, 'synthetic transaction failure'); END`).run();
    await expect(request(`enrichment/classifications/${id}/complete`, body)).rejects.toThrow("synthetic transaction failure");
    expect(await env.DB.prepare("SELECT status FROM classification_jobs WHERE link_id=?").bind(id).first("status")).toBe("processing");
    expect(await env.DB.prepare("SELECT classification FROM links WHERE id=?").bind(id).first("classification")).toBeNull();
    for (const table of ["classification_runs", "classification_decisions", "classification_operations"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE link_id=?`).bind(id).first("n"), table).toBe(0);
    }
    await env.DB.prepare("DROP TRIGGER reject_receipt").run();
    expect((await request(`enrichment/classifications/${id}/complete`, body)).status).toBe(200);
  });

  it.each(["target", "content", "lease"] as const)(`R3-01 ${protocol}: %s change after preflight cannot complete the job`, async (change) => {
    const { id, job, body, caps, target } = await setup(protocol);
    const barrier = beforeBatch(async () => {
      if (change === "target") {
        expect((await request("enrichment/classifications/target", { ...target, policy_version: "r3-next" })).status).toBe(200);
      } else if (change === "content") {
        await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=?").bind(id).run();
      } else {
        await env.DB.prepare("UPDATE classification_jobs SET lease_until='2000-01-01' WHERE link_id=?").bind(id).run();
      }
    });
    const first = await request(`enrichment/classifications/${id}/complete`, body, barrier.db);
    expect(barrier.calls()).toBe(1);
    expect(first.status).toBe(409);
    const row = await env.DB.prepare("SELECT status,lease_token FROM classification_jobs WHERE link_id=?")
      .bind(id).first<{ status: string; lease_token: string | null }>();
    expect(row!.status).not.toBe("completed");
    const replay = await request(`enrichment/classifications/${id}/complete`, body);
    expect(replay.status).toBe(409);
    expect((await replay.json() as { error: string }).error).not.toBe("already_completed");
    for (const table of ["classification_runs", "classification_decisions", "classification_operations", "link_selections_v2"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE link_id=?`).bind(id).first("n"), table).toBe(0);
    }
    expect(await env.DB.prepare("SELECT classification FROM links WHERE id=?").bind(id).first("classification")).toBeNull();
    // Let the stale lease expire; the work remains recoverable for a fresh consumer.
    await env.DB.prepare("UPDATE classification_jobs SET lease_until='2000-01-01' WHERE link_id=?").bind(id).run();
    const nextCaps = change === "target" && protocol === "v2" ? { ...caps, policy_versions: ["r3-next"] } : caps;
    if (change === "content" && protocol === "v2") {
      // A new content revision must wait for its own checkpoint. Identical
      // objective bytes may be registered at the newer source revision.
      expect((await request("enrichment/classifications/claim", nextCaps)).status).toBe(204);
      expect((await request(`v2/links/${id}/evidence`, { snapshot: {
        blocks: [{ id: "primary", role: "primary", text: "synthetic source" }],
        retrieval: "manual", fetched_at: "2026-09-22T00:00:00Z", truncation: { truncated: false }
      } })).status).toBe(200);
    }
    const next = await request("enrichment/classifications/claim", nextCaps);
    expect(next.status).toBe(200);
    expect((await next.json() as { lease_token: string }).lease_token).not.toBe(job.lease_token);
  });

  it(`R3-01 ${protocol}: lost response and concurrent identical retries confirm one operation`, async () => {
    const { id, body } = await setup(protocol);
    const [first, concurrent] = await Promise.all([
      request(`enrichment/classifications/${id}/complete`, body),
      request(`enrichment/classifications/${id}/complete`, body)
    ]);
    expect(first.status).toBe(200);
    expect(concurrent.status).toBe(200);
    const replay = await request(`enrichment/classifications/${id}/complete`, body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM classification_operations WHERE link_id=?").bind(id).first("n")).toBe(1);
    for (const table of ["classification_runs", "classification_decisions"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE link_id=?`).bind(id).first("n"), table).toBe(protocol === "v2" ? 1 : 0);
    }
    expect((await request(`enrichment/classifications/${id}/complete`, { ...body, operation_key: "unrelated-operation" })).status).toBe(409);
  });
}
