import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";

const bindings = () => ({ ...env, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function post(path: string, body: unknown = {}, token = "internal", guarded = true) {
  return worker.fetch(new Request(`https://test/api/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      ...(guarded && path.endsWith("/claim") ? { "X-Cairn-Source-Lease-Admission": "1" } : {}) },
    body: JSON.stringify(body)
  }), bindings());
}

async function claimed(guarded = true) {
  const created = await post("links", { url: "https://x.com/u/status/1" }, "app");
  const id = (await created.json() as { id: number }).id;
  const response = await post("enrichment/jobs/claim", {}, "internal", guarded);
  expect(response.status).toBe(200);
  return { id, job: await response.json() as { lease_token: string; attempt: number } };
}

const admit = (id: number, lease_token: string, min_remaining_ms = 210_000) =>
  post(`enrichment/jobs/${id}/lease-admit`, { lease_token, min_remaining_ms });

it("requires the internal token for source lease capability negotiation", async () => {
  const path = "https://test/api/enrichment/source-lease-capability";
  const forbidden = await worker.fetch(new Request(path, { method: "GET",
    headers: { Authorization: "Bearer app" } }), bindings());
  expect(forbidden.status).toBe(401);
  const valid = await worker.fetch(new Request(path, { method: "GET",
    headers: { Authorization: "Bearer internal" } }), bindings());
  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ protocol: 1, lease_ms: 900_000, paid_stage_admission: true });
});

it("admits a current owner, then releases a short lease without refunding a started paid stage", async () => {
  const { id, job } = await claimed();
  const ready = await admit(id, job.lease_token);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toMatchObject({ id, status: "admitted" });
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind(new Date(Date.now() + 1000).toISOString(), id).run();
  const short = await admit(id, job.lease_token);
  expect(short.status).toBe(409);
  expect(await short.json()).toEqual({ error: "lease_released" });
  expect(await env.DB.prepare(`SELECT enrichment_status,enrichment_attempts,
    enrichment_lease_token,enrichment_paid_stage_started FROM links WHERE id=?`).bind(id).first())
    .toEqual({ enrichment_status: "pending", enrichment_attempts: 1,
      enrichment_lease_token: null, enrichment_paid_stage_started: 0 });
  expect((await (await post("enrichment/jobs/claim")).json() as { attempt: number }).attempt).toBe(2);
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

it("treats an old client without admission capability as possibly paid", async () => {
  const { id, job } = await claimed(false);
  expect(await env.DB.prepare("SELECT enrichment_paid_stage_started FROM links WHERE id=?")
    .bind(id).first()).toEqual({ enrichment_paid_stage_started: 1 });
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind(new Date(Date.now() + 1000).toISOString(), id).run();
  expect((await admit(id, job.lease_token)).status).toBe(409);
  expect(await env.DB.prepare("SELECT enrichment_attempts FROM links WHERE id=?")
    .bind(id).first()).toEqual({ enrichment_attempts: 1 });
});

it("marks an already leased historical job as possibly paid during migration", async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter(m => m.name < "0033"));
  await env.DB.prepare(`INSERT INTO links(url,created_at,enrichment_status,enrichment_attempts,
    enrichment_lease_token,enrichment_lease_until)
    VALUES ('https://x.com/u/status/legacy','t','processing',2,'old-token','2999-01-01T00:00:00Z')`).run();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter(m => m.name >= "0033"));
  expect(await env.DB.prepare("SELECT enrichment_paid_stage_started FROM links WHERE enrichment_lease_token='old-token'")
    .first()).toEqual({ enrichment_paid_stage_started: 1 });
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
