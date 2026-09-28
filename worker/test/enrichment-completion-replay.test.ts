import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetObservabilityCacheForTest } from "../src/observability";

const bindings = () => ({ ...env, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  resetObservabilityCacheForTest();
});

function call(path: string, body: unknown, token = "internal", method = "POST") {
  return worker.fetch(new Request(`https://test/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      "X-Cairn-Provider-Attempt-Ledger": "1",
      ...(path.endsWith("/claim") ? { "X-Cairn-Source-Lease-Admission": "1" } : {}) },
    body: JSON.stringify(body)
  }), bindings());
}

async function fixture() {
  const created = await call("links", { url: "https://x.com/u/status/1" }, "app");
  const { id } = await created.json() as { id: number };
  const claimed = await call(`enrichment/jobs/${id}/claim`, {});
  expect(claimed.status).toBe(200);
  const { lease_token } = await claimed.json() as { lease_token: string };
  const source = { original_text: "saved source", original_language: "en", context_text: "",
    related_links: [], image_urls: [], model: "fixture" };
  expect((await call(`enrichment/jobs/${id}/source`, { lease_token, source })).status).toBe(200);
  expect((await call(`enrichment/jobs/${id}/lease-admit`, {
    lease_token, stage: "reading", min_remaining_ms: 210_000
  })).status).toBe(200);
  const revision = await env.DB.prepare("SELECT content_revision FROM links WHERE id=?")
    .bind(id).first<{ content_revision: number }>();
  expect((await call("enrichment/provider-attempts/reserve", {
    operation_key: "a".repeat(64), request_hash: "b".repeat(64), model: "fixture",
    stage: "reading", variant: "reading", attempt_number: 1,
    link_id: id, lease_token, content_revision: revision!.content_revision, min_remaining_ms: 210_000
  })).status).toBe(200);
  expect((await call("enrichment/provider-attempts/settle", {
    operation_key: "a".repeat(64), http_status: 200, response_id: null,
    input_tokens: null, output_tokens: null, total_tokens: null,
    x_search_calls: null, cost_usd_ticks: null
  })).status).toBe(200);
  const completion = { lease_token, original_text: source.original_text, ai_title: "title",
    original_language: "en", translated_text: "translation", summary: "summary", model: "fixture",
    related_links: [], images: [] };
  return { id, lease_token, completion };
}

it("replays a lost completion response without rewriting the bookmark", async () => {
  const { id, completion } = await fixture();
  const first = await call(`enrichment/jobs/${id}/complete`, completion);
  expect(first.status).toBe(200);
  const receipt = await first.json();
  const firstRow = await env.DB.prepare("SELECT enriched_at,content_revision FROM links WHERE id=?")
    .bind(id).first<{ enriched_at: string; content_revision: number }>();
  const replay = await call(`enrichment/jobs/${id}/complete`, completion);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  const laterRow = await env.DB.prepare("SELECT enriched_at,content_revision FROM links WHERE id=?")
    .bind(id).first<{ enriched_at: string; content_revision: number }>();
  expect(laterRow).toEqual(firstRow);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_completion_receipts WHERE link_id=?")
    .bind(id).first<{ n: number }>())?.n).toBe(1);
  const changed = await call(`enrichment/jobs/${id}/complete`, { ...completion, summary: "changed" });
  expect(changed.status).toBe(409);
  expect(await changed.json()).toEqual({ error: "operation_conflict" });
});

it("reports completed, replayed and rejected commits without exposing result text", async () => {
  const { id, lease_token, completion } = await fixture();
  expect((await call("internal/observability", { version: 1, logs: "basic" })).status).toBe(200);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const path = `enrichment/jobs/${id}/complete`;
    expect((await call(path, completion)).status).toBe(200);
    expect((await call(path, completion)).status).toBe(200);
    expect((await call(path, { ...completion, summary: "private changed summary" })).status).toBe(409);
    const entries = log.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
    expect(entries.filter((entry) => entry.kind === "enrichment_commit")).toEqual([
      { schema: 1, config_version: 1, kind: "enrichment_commit", stage: "complete",
        outcome: "committed", status: 200 },
      { schema: 1, config_version: 1, kind: "enrichment_commit", stage: "complete",
        outcome: "replay", status: 200 },
      { schema: 1, config_version: 1, kind: "enrichment_commit", stage: "complete",
        outcome: "rejected", status: 409 }
    ]);
    expect(JSON.stringify(entries)).not.toContain(lease_token);
    expect(JSON.stringify(entries)).not.toContain("private changed summary");
    expect((await call("internal/observability", { version: 2, logs: "off" })).status).toBe(200);
    const count = log.mock.calls.length;
    expect((await call(path, completion)).status).toBe(200);
    expect(log.mock.calls.length).toBe(count);
  } finally {
    log.mockRestore();
  }
});

it("rolls back both completion and receipt when the business update fails", async () => {
  const { id, completion } = await fixture();
  expect((await call("internal/observability", { version: 1, logs: "basic" })).status).toBe(200);
  await env.DB.prepare(`CREATE TRIGGER reject_completion BEFORE UPDATE OF enrichment_status ON links
    WHEN NEW.enrichment_status='completed' BEGIN SELECT RAISE(ABORT,'injected_completion_failure'); END`).run();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(call(`enrichment/jobs/${id}/complete`, completion)).rejects.toThrow("injected_completion_failure");
    const entries = log.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
    expect(entries.filter((entry) => entry.kind === "enrichment_commit")).toEqual([
      { schema: 1, config_version: 1, kind: "enrichment_commit", stage: "complete",
        outcome: "failed", status: 500 }
    ]);
  } finally {
    log.mockRestore();
  }
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_completion_receipts")
    .first<{ n: number }>())?.n).toBe(0);
  expect((await env.DB.prepare("SELECT enrichment_status,enrichment_paid_uncertain FROM links WHERE id=?")
    .bind(id).first<{ enrichment_status: string; enrichment_paid_uncertain: number }>()))
    .toMatchObject({ enrichment_status: "processing", enrichment_paid_uncertain: 1 });
});

it("concurrent identical retries return one durable completion", async () => {
  const { id, completion } = await fixture();
  const responses = await Promise.all([
    call(`enrichment/jobs/${id}/complete`, completion),
    call(`enrichment/jobs/${id}/complete`, completion)
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(await responses[0].json()).toEqual(await responses[1].json());
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_completion_receipts WHERE link_id=?")
    .bind(id).first<{ n: number }>())?.n).toBe(1);
});

it("removes the private receipt with its bookmark", async () => {
  const { id, completion } = await fixture();
  expect((await call(`enrichment/jobs/${id}/complete`, completion)).status).toBe(200);
  await env.DB.prepare("DELETE FROM links WHERE id=?").bind(id).run();
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_completion_receipts WHERE link_id=?")
    .bind(id).first<{ n: number }>())?.n).toBe(0);
});
