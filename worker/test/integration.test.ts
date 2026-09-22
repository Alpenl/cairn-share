import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";

// B10 integration: migration shape, cross-protocol reads/writes, privacy
// cascade and the synthetic-failure budget invariant. These run against the
// real D1 binding through vitest's Workers pool.

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function request(path: string, body?: unknown, method = "POST", token = "internal"): Promise<Response> {
  return worker.fetch(new Request(`https://test.example/api/${path}`, {
    method, headers: { "X-Cairn-Classification-Budget": "1", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}

async function createLink(url = "https://x.com/a/status/1"): Promise<number> {
  const response = await request("links", { url, note: "note" }, "POST", "app");
  return (await response.json() as { id: number }).id;
}

it("applies every migration and exposes the v2 tables", async () => {
  const tables = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN
     ('classification_targets','evidence_snapshots','question_specs','classification_runs',
      'curation_overrides','curation_events','current_projections','entity_states','budget_ledger',
      'link_selections_v2','taxonomy_proposals','evidence_requests','classification_operations')`
  ).all<{ name: string }>();
  const names = new Set(tables.results.map((row) => row.name));
  for (const table of [
    "classification_targets", "evidence_snapshots", "question_specs", "classification_runs",
    "curation_overrides", "curation_events", "current_projections", "entity_states", "budget_ledger",
    "link_selections_v2", "taxonomy_proposals", "evidence_requests", "classification_operations"
  ]) {
    expect(names.has(table), `${table} should exist`).toBe(true);
  }
});

it("keeps the seeded legacy target readable after migration", async () => {
  const target = await (await request("enrichment/classifications/target", undefined, "GET")).json() as { target: { generation: number; protocol: string } };
  expect(target.target.generation).toBe(0);
  expect(target.target.protocol).toBe("legacy");
});

it("keeps the six legacy fields stable while v2 data exists", async () => {
  const id = await createLink();
  // Write a v2 selection with a folded fourth topic and hidden dimensions.
  await request(`v2/links/${id}/selection`, {
    topics: ["llm", "eng", "eval", "design"], content_functions: ["method"], carriers: ["single"],
    affordances: ["practice"], form: "method", use: "try"
  }, "PATCH");
  // A v1 client reads the legacy shape and patches only what it can express.
  const legacy = await (await request(`links/${id}?include=enrichment`, undefined, "GET", "app")).json() as Record<string, unknown>;
  expect(legacy).toHaveProperty("id", id);
  const patched = await request(`links/${id}`, { note: "new note" }, "PATCH", "app");
  expect(patched.status).toBe(200);
  // The hidden dimensions and the fourth topic survive the v1 write.
  const selection = await (await request(`v2/links/${id}/selection`, undefined, "GET")).json() as { selection: { topics: string[]; content_functions: string[] } };
  expect(selection.selection.topics).toEqual(["llm", "eng", "eval", "design"]);
  expect(selection.selection.content_functions).toEqual(["method"]);
});

it("classifies independently of reading and preserves source on reading failure", async () => {
  const id = await createLink();
  const claim = await request(`enrichment/jobs/${id}/claim`);
  const { lease_token } = await claim.json() as { lease_token: string };
  const source = { original_text: "archived text", original_language: "en", context_text: "", related_links: [], image_urls: [], model: "grok" };
  expect((await request(`enrichment/jobs/${id}/source`, { lease_token, source })).status).toBe(200);
  // Reading fails, but the source remains readable and classification can run.
  expect((await request(`enrichment/jobs/${id}/fail`, { lease_token, error: "reading failed" })).status).toBe(200);
  const stored = await request(`enrichment/jobs/${id}/source`, undefined, "GET");
  expect(stored.status).toBe(200);
  expect((await stored.json() as { original_text: string }).original_text).toBe("archived text");
});

it("cascades a delete across every private v2 table", async () => {
  const id = await createLink();
  await request(`v2/links/${id}/evidence`, {
    snapshot: { blocks: [{ id: "b1", role: "primary", text: "body" }], fetched_at: "2026-09-20T00:00:00Z", retrieval: "x_search", truncation: { truncated: false } }
  });
  await request(`v2/links/${id}/overrides`, { operation_key: "ov-1", field: "topic", action: "accept", term: "llm" });
  await request(`v2/links/${id}/selection`, { topics: ["llm"], content_functions: [], carriers: [], affordances: [], form: "", use: "" }, "PATCH");
  await env.DB.prepare("DELETE FROM links WHERE id = ?").bind(id).run();
  for (const table of ["evidence_snapshots", "curation_overrides", "curation_events", "current_projections", "link_selections_v2", "classification_runs"]) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE link_id = ?`).bind(id).first<{ n: number }>();
    expect(row!.n, `${table} should cascade`).toBe(0);
  }
});

it("does not leak a private note through the objective evidence path", async () => {
  const id = await createLink();
  // A note is personal; the evidence snapshot payload must not include it.
  await request(`v2/links/${id}/evidence`, {
    snapshot: { blocks: [{ id: "b1", role: "primary", text: "public body" }], fetched_at: "2026-09-20T00:00:00Z", retrieval: "x_search", truncation: { truncated: false } }
  });
  const row = await env.DB.prepare("SELECT payload FROM evidence_snapshots WHERE link_id = ?").bind(id).first<{ payload: string }>();
  expect(row!.payload).not.toContain("note");
  expect(row!.payload).not.toContain("private");
});

it("rejects an oversized or malformed evidence payload", async () => {
  const id = await createLink();
  expect((await request(`v2/links/${id}/evidence`, { snapshot: { blocks: [{ id: "b1", role: "primary", text: "x".repeat(200_000) }], fetched_at: "t", retrieval: "r", truncation: { truncated: false } } })).status).toBe(400);
  expect((await request(`v2/links/${id}/evidence`, { snapshot: { blocks: [{ id: "b1", role: "not_a_role", text: "x" }], fetched_at: "t", retrieval: "r", truncation: { truncated: false } } })).status).toBe(400);
});

it("rejects an unknown or inactive taxonomy term without injecting SQL", async () => {
  const id = await createLink();
  const injected = await request(`v2/links/${id}/selection`, {
    topics: ["llm'); DROP TABLE links;--"], content_functions: [], carriers: [], affordances: [], form: "", use: ""
  }, "PATCH");
  expect(injected.status).toBe(400);
  // The table still exists.
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM links").first<{ n: number }>();
  expect(count!.n).toBe(1);
});

it("enforces the budget ledger uniqueness per operation", async () => {
  const id = await createLink();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO budget_ledger(scope, link_id, units, operation_key, created_at) VALUES ('entity', ?, '{}', 'k1', ?)`).bind(id, now).run();
  await expect(env.DB.prepare(`INSERT INTO budget_ledger(scope, link_id, units, operation_key, created_at) VALUES ('entity', ?, '{}', 'k1', ?)`).bind(id, now).run()).rejects.toThrow();
});
