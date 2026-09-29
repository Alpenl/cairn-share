import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";

const bindings = () => ({ ...env, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal",
  CAIRN_OPERATOR_TOKEN: "operator" });
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

function call(path: string, body?: unknown, token = "internal", method = "POST") {
  return worker.fetch(new Request(`https://test/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      "X-Cairn-Provider-Attempt-Ledger": "1",
      ...(path.endsWith("/claim") ? { "X-Cairn-Source-Lease-Admission": "1" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), bindings());
}

const fetchKey = "a".repeat(64);
const readingKey = "e".repeat(64);
const source = (image_urls: string[] = []) => ({ original_text: "Persisted primary source",
  original_language: "en", context_text: "", related_links: [], image_urls, model: "grok-test" });
const recovery = (reading = { ai_title: "中文阅读辅助标题测试", original_language: "en",
  translated_text: "完整译文", summary: "阅读摘要", model: "grok-test" }) => ({
  operation_key: readingKey, response_id: "resp_reading", actor: "ops@example.org", reading });

async function fixture(imageURLs: string[] = [], persistEvidence = true) {
  const created = await call("links", { url: "https://x.com/u/status/100" }, "app");
  const { id } = await created.json() as { id: number };
  const claimed = await call("enrichment/jobs/claim", {});
  expect(claimed.status).toBe(200);
  const job = await claimed.json() as { lease_token: string; content_revision: number };
  expect((await call(`enrichment/jobs/${id}/lease-admit`, {
    lease_token: job.lease_token, stage: "fetch", min_remaining_ms: 210_000
  })).status).toBe(200);
  const permit = { operation_key: fetchKey, request_hash: "b".repeat(64), model: "grok-test",
    stage: "fetch", variant: "fetch_thread", attempt_number: 1, link_id: id,
    lease_token: job.lease_token, content_revision: job.content_revision, min_remaining_ms: 210_000 };
  expect((await call("enrichment/provider-attempts/reserve", permit)).status).toBe(200);
  expect((await call("enrichment/provider-attempts/settle", { operation_key: fetchKey, http_status: 200,
    response_id: "resp_fetch", input_tokens: 100, output_tokens: 20, total_tokens: 120,
    x_search_calls: 1, cost_usd_ticks: 1000 })).status).toBe(200);
  expect((await call(`enrichment/jobs/${id}/source`, {
    lease_token: job.lease_token, source: source(imageURLs)
  })).status).toBe(200);
  if (persistEvidence) expect((await call(`v2/links/${id}/evidence`, { snapshot: {
    blocks: [{ id: "primary-1", role: "primary", text: source(imageURLs).original_text,
      acquired: "fetch" }], fetched_at: new Date().toISOString(), retrieval: "x_search",
    truncation: { truncated: false }
  } })).status).toBe(200);
  expect((await call(`enrichment/jobs/${id}/lease-admit`, {
    lease_token: job.lease_token, stage: "reading", min_remaining_ms: 210_000
  })).status).toBe(200);
  const revision = await env.DB.prepare("SELECT content_revision FROM links WHERE id=?")
    .bind(id).first<{ content_revision: number }>();
  expect((await call("enrichment/provider-attempts/reserve", {
    ...permit, operation_key: readingKey, request_hash: "f".repeat(64),
    stage: "reading", variant: "reading", content_revision: revision!.content_revision
  })).status).toBe(200);
  expect((await call("enrichment/provider-attempts/settle", { operation_key: readingKey, http_status: 200,
    response_id: "resp_reading", input_tokens: 100, output_tokens: 20, total_tokens: 120,
    x_search_calls: 0, cost_usd_ticks: 1200 })).status).toBe(200);
  expect((await call(`enrichment/jobs/${id}/fail`, {
    lease_token: job.lease_token, error: "provider_result_unknown"
  })).status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", id).run();
  return { id, revision: revision!.content_revision };
}

it("recovers a settled reading once without changing source, classification or human why", async () => {
  const { id, revision } = await fixture();
  await env.DB.prepare("UPDATE links SET why=? WHERE id=?").bind("human explanation", id).run();
  const path = "enrichment/provider-attempts/recover-reading";
  const body = recovery();
  expect((await call(path, body, "app")).status).toBe(401);
  expect((await call(path, body, "internal")).status).toBe(401);
  const before = await env.DB.prepare("SELECT original_text,classification FROM links WHERE id=?")
    .bind(id).first();
  const concurrent = await Promise.all([call(path, body, "operator"), call(path, body, "operator")]);
  expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
  const receipt = await concurrent[0].json();
  expect(await concurrent[1].json()).toEqual(receipt);
  expect(receipt).toMatchObject({ recovered: true, id, status: "completed", content_revision: revision });
  expect(await env.DB.prepare(`SELECT enrichment_status,enrichment_paid_uncertain,original_text,
    classification,why,ai_title,translated_text,summary,enrichment_lease_token FROM links WHERE id=?`)
    .bind(id).first()).toMatchObject({ enrichment_status: "completed", enrichment_paid_uncertain: 0,
      original_text: before!.original_text, classification: before!.classification,
      why: "human explanation", ai_title: body.reading.ai_title,
      translated_text: body.reading.translated_text, summary: body.reading.summary,
      enrichment_lease_token: null });
  expect(await (await call(path, body, "operator")).json()).toEqual(receipt);
  expect((await call(path, recovery({ ...body.reading, summary: "conflicting summary" }), "operator")).status)
    .toBe(409);
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM enrichment_provider_reading_recoveries")
    .first<{ n: number }>())?.n).toBe(1);
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM enrichment_provider_attempts WHERE link_id=?")
    .bind(id).first<{ n: number }>())?.n).toBe(2);
  expect(await env.DB.prepare(`SELECT reading_payload,source_payload,images_payload,lease_token
    FROM enrichment_provider_reading_recoveries WHERE operation_key=?`).bind(readingKey).first())
    .toMatchObject({ reading_payload: null, source_payload: null, images_payload: null, lease_token: null });
  expect((await call(`links/${id}`, undefined, "app", "DELETE")).status).toBe(204);
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM enrichment_provider_reading_recoveries")
    .first<{ n: number }>())?.n).toBe(0);
});

it("keeps the saved source language when reading recovery disagrees", async () => {
  const { id } = await fixture();
  const reading = { ...recovery().reading, original_language: "fr" };
  expect((await call("enrichment/provider-attempts/recover-reading", recovery(reading), "operator")).status)
    .toBe(200);
  expect(await env.DB.prepare("SELECT original_language,original_text FROM links WHERE id=?")
    .bind(id).first()).toMatchObject({
      original_language: "en", original_text: "Persisted primary source"
    });
});

it("rebuilds image refs only from one matching R2 object per current source URL", async () => {
  const imageURL = "https://pbs.twimg.com/media/recovery-test";
  const { id } = await fixture([imageURL]);
  const path = "enrichment/provider-attempts/recover-reading";
  const body = recovery();
  expect((await call(path, body, "operator")).status).toBe(409);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(imageURL)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = `enrichment/${id}/${hash}.png`;
  await env.ENRICHMENT_IMAGES.put(key, "image", { httpMetadata: { contentType: "image/png" },
    customMetadata: { source_url: "https://pbs.twimg.com/media/another" } });
  expect((await call(path, body, "operator")).status).toBe(409);
  await env.ENRICHMENT_IMAGES.put(key, "image", { httpMetadata: { contentType: "image/png" },
    customMetadata: { source_url: imageURL } });
  const ambiguous = `enrichment/${id}/${hash}.jpg`;
  await env.ENRICHMENT_IMAGES.put(ambiguous, "image", { httpMetadata: { contentType: "image/jpeg" },
    customMetadata: { source_url: imageURL } });
  expect((await call(path, body, "operator")).status).toBe(409);
  await env.ENRICHMENT_IMAGES.delete(ambiguous);
  expect((await call(path, body, "operator")).status).toBe(200);
  expect(await env.DB.prepare("SELECT images FROM links WHERE id=?").bind(id).first("images"))
    .toBe(JSON.stringify([{ key, content_type: "image/png" }]));
});

it("rejects changed content, wrong response and an interrupted commit without partial writes", async () => {
  const { id } = await fixture();
  const path = "enrichment/provider-attempts/recover-reading";
  const body = recovery();
  expect((await call(path, recovery({ ...body.reading, ai_title: "short" }), "operator")).status).toBe(400);
  expect((await call(path, { ...body, response_id: "unbound" }, "operator")).status).toBe(409);
  expect((await call(path, recovery({ ...body.reading, model: "other" }), "operator")).status).toBe(409);
  await env.DB.prepare(`CREATE TRIGGER reject_recovered_reading BEFORE UPDATE OF enrichment_status ON links
    WHEN NEW.enrichment_status='completed' BEGIN SELECT RAISE(ABORT,'injected reading failure'); END`).run();
  await expect(call(path, body, "operator")).rejects.toThrow();
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM enrichment_provider_reading_recoveries")
    .first<{ n: number }>())?.n).toBe(0);
  expect(await env.DB.prepare("SELECT enrichment_paid_uncertain,enrichment_status FROM links WHERE id=?")
    .bind(id).first()).toMatchObject({ enrichment_paid_uncertain: 1, enrichment_status: "failed" });
  await env.DB.prepare("DROP TRIGGER reject_recovered_reading").run();
  await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=?").bind(id).run();
  expect((await call(path, body, "operator")).status).toBe(409);
});

it("rejects recovery when the current source has no evidence snapshot", async () => {
  await fixture([], false);
  expect((await call("enrichment/provider-attempts/recover-reading", recovery(), "operator")).status)
    .toBe(409);
});

it("reports safe committed, replay and rejected outcomes under the live log switch", async () => {
  await fixture();
  const policy = (version: number, logs: "off" | "basic") =>
    call("internal/observability", { version, logs }, "internal");
  expect((await policy(1, "basic")).status).toBe(200);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const path = "enrichment/provider-attempts/recover-reading";
    const body = recovery();
    expect((await call(path, { ...body, response_id: "wrong" }, "operator")).status).toBe(409);
    expect((await call(path, body, "operator")).status).toBe(200);
    expect((await call(path, body, "operator")).status).toBe(200);
    const events = log.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
    expect(events.filter((entry) => entry.kind === "provider_recovery")).toMatchObject([
      { schema: 1, kind: "provider_recovery", config_version: 1,
        stage: "reading", outcome: "rejected", status: 409 },
      { schema: 1, kind: "provider_recovery", config_version: 1,
        stage: "reading", outcome: "committed", status: 200 },
      { schema: 1, kind: "provider_recovery", config_version: 1,
        stage: "reading", outcome: "replay", status: 200 }
    ]);
    expect(events.filter((entry) => entry.kind === "worker_request").map((entry) => entry.route))
      .toEqual(Array(3).fill("/api/enrichment/provider-attempts/recover-reading"));
    expect(JSON.stringify(events)).not.toContain(readingKey);
    expect(JSON.stringify(events)).not.toContain(body.reading.translated_text);
    expect((await policy(2, "off")).status).toBe(200);
    const logged = log.mock.calls.length;
    expect((await call(path, body, "operator")).status).toBe(200);
    expect(log.mock.calls.length).toBe(logged);
  } finally {
    log.mockRestore();
  }
});
