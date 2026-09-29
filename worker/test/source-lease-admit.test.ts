import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";

const bindings = () => ({ ...env, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function post(path: string, body: unknown = {}, token = "internal", guarded = true) {
  return worker.fetch(new Request(`https://test/api/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      ...(guarded ? { "X-Cairn-Provider-Attempt-Ledger": "1" } : {}),
      ...(guarded && path.endsWith("/claim") ? { "X-Cairn-Source-Lease-Admission": "1" } : {}) },
    body: JSON.stringify(body)
  }), bindings());
}

async function claimed(guarded = true) {
  const created = await post("links", { url: "https://x.com/u/status/1" }, "app");
  const id = (await created.json() as { id: number }).id;
  const response = await post("enrichment/jobs/claim", {}, "internal", guarded);
  expect(response.status).toBe(200);
  return { id, job: await response.json() as { lease_token: string; attempt: number; content_revision: number } };
}

const admit = (id: number, lease_token: string, min_remaining_ms = 210_000, stage = "fetch") =>
  post(`enrichment/jobs/${id}/lease-admit`, { lease_token, min_remaining_ms, stage });
const reserve = (id: number, lease_token: string, content_revision: number, stage = "fetch") =>
  post("enrichment/provider-attempts/reserve", { operation_key: (stage === "fetch" ? "a" : "b").repeat(64),
    request_hash: "c".repeat(64), model: "grok-test", stage,
    variant: stage === "fetch" ? "fetch_thread" : "reading", attempt_number: 1,
    link_id: id, lease_token, content_revision, min_remaining_ms: 210_000 });
const settle = (stage = "fetch") => post("enrichment/provider-attempts/settle", {
  operation_key: (stage === "fetch" ? "a" : "b").repeat(64), http_status: 200,
  response_id: null, input_tokens: null, output_tokens: null, total_tokens: null,
  x_search_calls: null, cost_usd_ticks: null });

it("requires the internal token for source lease capability negotiation", async () => {
  const path = "https://test/api/enrichment/source-lease-capability";
  const forbidden = await worker.fetch(new Request(path, { method: "GET",
    headers: { Authorization: "Bearer app" } }), bindings());
  expect(forbidden.status).toBe(401);
  const valid = await worker.fetch(new Request(path, { method: "GET",
    headers: { Authorization: "Bearer internal" } }), bindings());
  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ protocol: 1, lease_ms: 900_000,
    paid_stage_admission: true, provider_result_guard: true, completion_replay: true,
    provider_attempt_ledger: true, refresh_source_checkpoint: true });
});

it("checks exact source claimability without taking a lease", async () => {
  const path = "https://test/api/enrichment/source-claimable";
  const check = (token = "internal") => worker.fetch(new Request(path, { method: "GET",
    headers: { Authorization: `Bearer ${token}` } }), bindings());
  expect((await check("app")).status).toBe(401);
  expect(await (await check()).json()).toEqual({ claimable: false });
  const created = await post("links", { url: "https://x.com/u/status/claimable" }, "app");
  const id = (await created.json() as { id: number }).id;
  expect(await (await check()).json()).toEqual({ claimable: true });
  expect(await env.DB.prepare("SELECT enrichment_status,enrichment_attempts,enrichment_lease_token FROM links WHERE id=?")
    .bind(id).first()).toEqual({ enrichment_status: "pending", enrichment_attempts: 0,
      enrichment_lease_token: null });
  expect((await post("enrichment/jobs/claim")).status).toBe(200);
  expect(await (await check()).json()).toEqual({ claimable: false });
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind(new Date(Date.now() - 1000).toISOString(), id).run();
  expect(await (await check()).json()).toEqual({ claimable: true });
  await env.DB.prepare("UPDATE links SET enrichment_paid_uncertain=1 WHERE id=?").bind(id).run();
  expect(await (await check()).json()).toEqual({ claimable: false });
});

it("holds a possibly paid call after a short lease instead of automatically paying twice", async () => {
  const { id, job } = await claimed();
  const ready = await admit(id, job.lease_token);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toMatchObject({ id, status: "admitted" });
  expect((await reserve(id, job.lease_token, job.content_revision)).status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind(new Date(Date.now() + 1000).toISOString(), id).run();
  const short = await admit(id, job.lease_token);
  expect(short.status).toBe(409);
  expect(await short.json()).toEqual({ error: "lease_released" });
  expect(await env.DB.prepare(`SELECT enrichment_status,enrichment_attempts,
    enrichment_lease_token,enrichment_paid_stage_started,enrichment_paid_uncertain,enrichment_paid_stage
    FROM links WHERE id=?`).bind(id).first())
    .toEqual({ enrichment_status: "pending", enrichment_attempts: 1,
      enrichment_lease_token: null, enrichment_paid_stage_started: 0,
      enrichment_paid_uncertain: 1, enrichment_paid_stage: "fetch" });
  expect((await post("enrichment/jobs/claim")).status).toBe(204);
  expect((await post(`enrichment/jobs/${id}/claim`)).status).toBe(409);
});

it("does not retry a failed job whose provider result is unresolved", async () => {
  const { id, job } = await claimed();
  expect((await admit(id, job.lease_token)).status).toBe(200);
  expect((await reserve(id, job.lease_token, job.content_revision)).status).toBe(200);
  const duplicate = await admit(id, job.lease_token);
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toEqual({ error: "provider_result_unknown" });
  const failed = await post(`enrichment/jobs/${id}/fail`, {
    lease_token: job.lease_token, error: "[search] HTTP 502 upstream_error"
  });
  expect(failed.status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_next_retry_at=? WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", id).run();
  expect((await post("enrichment/jobs/claim")).status).toBe(204);
  expect((await post(`enrichment/jobs/${id}/claim`)).status).toBe(409);
  for (const [path, operation_key] of [
    [`enrichment/jobs/${id}/refresh-source`, "unknown-refresh"],
    [`enrichment/jobs/${id}/enqueue`, "unknown-retry"]
  ]) {
    const retry = await post(path, { operation_key });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ error: "provider_result_unknown" });
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM manual_request_operations").first("n")).toBe(0);
  expect(await env.DB.prepare(`SELECT enrichment_status,enrichment_paid_uncertain,
    enrichment_paid_stage FROM links WHERE id=?`).bind(id).first())
    .toEqual({ enrichment_status: "failed", enrichment_paid_uncertain: 1,
      enrichment_paid_stage: "fetch" });
});

it("allows a new URL objective after an unresolved call for the old URL", async () => {
  const { id, job } = await claimed();
  expect((await admit(id, job.lease_token)).status).toBe(200);
  expect((await reserve(id, job.lease_token, job.content_revision)).status).toBe(200);
  const changed = await worker.fetch(new Request(`https://test/api/links/${id}`, {
    method: "PATCH", headers: { Authorization: "Bearer app", "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://x.com/u/status/2" })
  }), bindings());
  expect(changed.status).toBe(200);
  expect(await env.DB.prepare("SELECT enrichment_paid_uncertain,enrichment_paid_stage FROM links WHERE id=?")
    .bind(id).first()).toEqual({ enrichment_paid_uncertain: 0, enrichment_paid_stage: null });
  const next = await post("enrichment/jobs/claim");
  expect(next.status).toBe(200);
  expect(await next.json()).toMatchObject({ id, url: "https://x.com/u/status/2" });
});

it("refunds an unused short claim, preserving manual priority and the retry budget", async () => {
  const { id, job } = await claimed();
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=?,manual_priority=1 WHERE id=?")
    .bind(new Date(Date.now() + 1000).toISOString(), id).run();
  expect((await admit(id, job.lease_token)).status).toBe(409);
  expect(await env.DB.prepare(`SELECT enrichment_status,enrichment_attempts,manual_priority,
    enrichment_lease_token FROM links WHERE id=?`).bind(id).first())
    .toEqual({ enrichment_status: "pending", enrichment_attempts: 0, manual_priority: 1,
      enrichment_lease_token: null });
  const next = await (await post("enrichment/jobs/claim")).json() as { attempt: number };
  expect(next.attempt).toBe(1);
});

it("reclaims an expired unused lease without consuming the last allowed attempt", async () => {
  const { id } = await claimed();
  await env.DB.prepare(`UPDATE links SET enrichment_attempts=5,enrichment_paid_stage_started=0,
    enrichment_lease_until=? WHERE id=?`).bind(new Date(Date.now() - 1000).toISOString(), id).run();
  const reclaimed = await post("enrichment/jobs/claim");
  expect(reclaimed.status).toBe(200);
  expect(await reclaimed.json()).toMatchObject({ id, attempt: 5 });
});

it("refuses a new lease to a client without the per-attempt ledger", async () => {
  const created = await post("links", { url: "https://x.com/u/status/1" }, "app");
  const { id } = await created.json() as { id: number };
  const oldClient = await post("enrichment/jobs/claim", {}, "internal", false);
  expect(oldClient.status).toBe(409);
  expect(await oldClient.json()).toEqual({ error: "capability_mismatch" });
  expect(await env.DB.prepare("SELECT enrichment_status,enrichment_attempts FROM links WHERE id=?")
    .bind(id).first()).toEqual({ enrichment_status: "pending", enrichment_attempts: 0 });
});

it("marks an already leased historical job as possibly paid during migration", async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter(m => m.name < "0033"));
  await env.DB.prepare(`INSERT INTO links(url,created_at,enrichment_status,enrichment_attempts,
    enrichment_lease_token,enrichment_lease_until)
    VALUES ('https://x.com/u/status/legacy','t','processing',2,'old-token','2999-01-01T00:00:00Z')`).run();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter(m => m.name >= "0033"));
  expect(await env.DB.prepare("SELECT enrichment_paid_stage_started,enrichment_paid_uncertain,enrichment_paid_stage FROM links WHERE enrichment_lease_token='old-token'")
    .first()).toEqual({ enrichment_paid_stage_started: 1,
      enrichment_paid_uncertain: 1, enrichment_paid_stage: "legacy_unknown" });
});

it("clears a fetch marker only after the source checkpoint, then guards reading separately", async () => {
  const { id, job } = await claimed();
  expect((await admit(id, job.lease_token)).status).toBe(200);
  expect((await reserve(id, job.lease_token, job.content_revision)).status).toBe(200);
  expect((await settle()).status).toBe(200);
  const source = { original_text: "saved source", original_language: "en", context_text: "",
    related_links: [], image_urls: [], model: "fixture" };
  expect((await post(`enrichment/jobs/${id}/source`, { lease_token: job.lease_token, source })).status).toBe(200);
  expect(await env.DB.prepare("SELECT enrichment_paid_uncertain,enrichment_paid_stage FROM links WHERE id=?")
    .bind(id).first()).toEqual({ enrichment_paid_uncertain: 0, enrichment_paid_stage: null });
  expect((await admit(id, job.lease_token, 210_000, "reading")).status).toBe(200);
  const current = await env.DB.prepare("SELECT content_revision FROM links WHERE id=?")
    .bind(id).first<{ content_revision: number }>();
  expect((await reserve(id, job.lease_token, current!.content_revision, "reading")).status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind(new Date(Date.now() - 1000).toISOString(), id).run();
  expect((await post("enrichment/jobs/claim")).status).toBe(204);
  expect(await env.DB.prepare("SELECT enrichment_paid_uncertain,enrichment_paid_stage FROM links WHERE id=?")
    .bind(id).first()).toEqual({ enrichment_paid_uncertain: 1, enrichment_paid_stage: "reading" });
});

it("does not release a lease acquired by another owner", async () => {
  const { id, job } = await claimed();
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind(new Date(Date.now() - 1000).toISOString(), id).run();
  const next = await (await post("enrichment/jobs/claim")).json() as { lease_token: string };
  expect(next.lease_token).not.toBe(job.lease_token);
  const stale = await admit(id, job.lease_token);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: "lease_conflict" });
  expect(await env.DB.prepare("SELECT enrichment_lease_token,enrichment_status FROM links WHERE id=?")
    .bind(id).first()).toEqual({ enrichment_lease_token: next.lease_token, enrichment_status: "processing" });
});
