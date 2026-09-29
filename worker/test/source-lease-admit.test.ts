import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";

const bindings = () => ({ ...env, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function post(path: string, body: unknown = {}, token = "internal", guarded = true) {
  return worker.fetch(new Request(`https://test/api/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      ...(guarded ? { "X-Cairn-Provider-Attempt-Ledger": "1" } : {}),
      ...(guarded && path.endsWith("/claim") ? { "X-Cairn-Source-Lease-Admission": "1",
        "X-Cairn-Source-Component-Gate": "1" } : {}) },
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
    provider_attempt_ledger: true, refresh_source_checkpoint: true,
    source_component_gate: true, source_stage_pause: true });
});

it("checks exact source claimability without taking a lease", async () => {
  const path = "https://test/api/enrichment/source-claimable";
  const check = (token = "internal") => worker.fetch(new Request(path, { method: "GET",
    headers: { Authorization: `Bearer ${token}`, "X-Cairn-Source-Component-Gate": "1" } }), bindings());
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

it("keeps a source fault from consuming a stored-source reading claim", async () => {
  const source = await post("links", { url: "https://x.com/u/status/91" }, "app");
  const sourceID = (await source.json() as { id: number }).id;
  const reading = await post("links", { url: "https://x.com/u/status/92" }, "app");
  const readingID = (await reading.json() as { id: number }).id;
  await env.DB.prepare("UPDATE links SET original_text='stored text' WHERE id=?").bind(readingID).run();
  await env.DB.prepare(`UPDATE enrichment_component_gates SET state='open',retry_at=?
    WHERE component='source'`).bind(new Date(Date.now() + 60_000).toISOString()).run();
  const claimed = await post("enrichment/jobs/claim");
  expect(claimed.status).toBe(200);
  expect(await claimed.json()).toMatchObject({ id: readingID });
  expect(await env.DB.prepare("SELECT enrichment_attempts FROM links WHERE id=?")
    .bind(sourceID).first("enrichment_attempts")).toBe(0);
  expect((await post("enrichment/jobs/claim")).status).toBe(503);
});

it("filters a locally paused stage before taking a lease", async () => {
  const source = await post("links", { url: "https://x.com/u/status/101" }, "app");
  const sourceID = (await source.json() as { id: number }).id;
  const reading = await post("links", { url: "https://x.com/u/status/102" }, "app");
  const readingID = (await reading.json() as { id: number }).id;
  await env.DB.prepare("UPDATE links SET original_text='stored text' WHERE id=?")
    .bind(readingID).run();
  const claimMask = (mask: string) => worker.fetch(new Request("https://test/api/enrichment/jobs/claim", {
    method: "POST", headers: { Authorization: "Bearer internal",
      "X-Cairn-Provider-Attempt-Ledger": "1", "X-Cairn-Source-Lease-Admission": "1",
      "X-Cairn-Source-Component-Gate": "1", "X-Cairn-Source-Stage-Pause": "1",
      "X-Cairn-Source-Stage-Mask": mask }
  }), bindings());
  expect((await claimMask("invalid")).status).toBe(400);
  const first = await claimMask("reading");
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ id: readingID, source_component: "reading" });
  expect(await env.DB.prepare("SELECT enrichment_attempts FROM links WHERE id=?")
    .bind(sourceID).first("enrichment_attempts")).toBe(0);
  const second = await claimMask("source");
  expect(second.status).toBe(200);
  expect(await second.json()).toMatchObject({ id: sourceID, source_component: "source" });
});

it("preserves the strict legacy claim response until stage pause is requested", async () => {
  const created = await post("links", { url: "https://x.com/u/status/legacy-shape" }, "app");
  const id = (await created.json() as { id: number }).id;
  const oldClient = await post("enrichment/jobs/claim");
  expect(oldClient.status).toBe(200);
  const body = await oldClient.json() as Record<string, unknown>;
  expect(body.id).toBe(id);
  expect(body).not.toHaveProperty("source_component");
  const second = await post("links", { url: "https://x.com/u/status/legacy-by-id" }, "app");
  const secondID = (await second.json() as { id: number }).id;
  const byID = await post(`enrichment/jobs/${secondID}/claim`);
  expect(byID.status).toBe(200);
  expect(await byID.json()).not.toHaveProperty("source_component");
});

it("claims one due source probe and closes it only after a settled source checkpoint", async () => {
  const first = await post("links", { url: "https://x.com/u/status/93" }, "app");
  const firstID = (await first.json() as { id: number }).id;
  const second = await post("links", { url: "https://x.com/u/status/94" }, "app");
  const secondID = (await second.json() as { id: number }).id;
  await env.DB.prepare(`UPDATE enrichment_component_gates SET state='open',retry_at='2000-01-01'
    WHERE component='source'`).run();
  const outcomes = await Promise.all([post("enrichment/jobs/claim"), post("enrichment/jobs/claim")]);
  expect(outcomes.map((response) => response.status).sort()).toEqual([200, 503]);
  const job = await outcomes.find((response) => response.status === 200)!.json() as {
    id: number; lease_token: string; content_revision: number
  };
  expect(job.id).toBe(firstID);
  const gate = await env.DB.prepare(`SELECT state,probe_token,probe_until FROM enrichment_component_gates
    WHERE component='source'`).first<{ state: string; probe_token: string; probe_until: string }>();
  expect(gate).toMatchObject({ state: "probing", probe_token: job.lease_token });
  expect(Date.parse(gate!.probe_until) - Date.now()).toBeGreaterThan(15 * 60_000);
  expect(await env.DB.prepare("SELECT enrichment_attempts FROM links WHERE id=?")
    .bind(secondID).first("enrichment_attempts")).toBe(0);
  expect((await admit(job.id, job.lease_token)).status).toBe(200);
  expect((await reserve(job.id, job.lease_token, job.content_revision)).status).toBe(200);
  expect((await settle()).status).toBe(200);
  const source = { original_text: "fetched text", original_language: "en", context_text: "",
    related_links: [], image_urls: [], model: "fixture" };
  expect((await post(`enrichment/jobs/${job.id}/source`, { lease_token: job.lease_token, source })).status).toBe(200);
  expect(await env.DB.prepare("SELECT state FROM enrichment_component_gates WHERE component='source'")
    .first("state")).toBe("closed");
  expect((await post("enrichment/jobs/claim")).status).toBe(200);
});

it("does not hand a due probe to an older source client", async () => {
  const created = await post("links", { url: "https://x.com/u/status/99" }, "app");
  const id = (await created.json() as { id: number }).id;
  await env.DB.prepare(`UPDATE enrichment_component_gates SET state='open',retry_at='2000-01-01'
    WHERE component='source'`).run();
  const older = await worker.fetch(new Request("https://test/api/enrichment/jobs/claim", {
    method: "POST", headers: { Authorization: "Bearer internal",
      "X-Cairn-Provider-Attempt-Ledger": "1", "X-Cairn-Source-Lease-Admission": "1" }
  }), bindings());
  expect(older.status).toBe(204);
  expect(await env.DB.prepare("SELECT enrichment_attempts FROM links WHERE id=?")
    .bind(id).first("enrichment_attempts")).toBe(0);
  expect(await env.DB.prepare("SELECT state FROM enrichment_component_gates WHERE component='source'")
    .first("state")).toBe("open");
  expect((await post("enrichment/jobs/claim")).status).toBe(200);
});

it("releases a source probe after a free checkpoint without clearing the provider fault", async () => {
  const first = await post("links", { url: "https://x.com/u/status/97" }, "app");
  const firstID = (await first.json() as { id: number }).id;
  const second = await post("links", { url: "https://x.com/u/status/98" }, "app");
  const secondID = (await second.json() as { id: number }).id;
  await env.DB.prepare(`UPDATE enrichment_component_gates SET state='open',failures=1,
    reason='provider_transient',retry_at='2000-01-01' WHERE component='source'`).run();
  const response = await post("enrichment/jobs/claim");
  expect(response.status).toBe(200);
  const job = await response.json() as { id: number; lease_token: string };
  expect(job.id).toBe(firstID);
  const source = { original_text: "pasted text", original_language: "en", context_text: "",
    related_links: [], image_urls: [], model: "manual" };
  expect((await post(`enrichment/jobs/${firstID}/source`, {
    lease_token: job.lease_token, source
  })).status).toBe(200);
  expect(await env.DB.prepare(`SELECT state,failures,reason,probe_token FROM enrichment_component_gates
    WHERE component='source'`).first()).toEqual({ state: "open", failures: 1,
    reason: "provider_transient", probe_token: null });
  expect(await env.DB.prepare("SELECT original_text FROM links WHERE id=?")
    .bind(firstID).first("original_text")).toBe("pasted text");
  const next = await post("enrichment/jobs/claim");
  expect(next.status).toBe(200);
  expect(await next.json()).toMatchObject({ id: secondID });
});

it("fences an old source lease when its component gate opens before payment", async () => {
  const { id, job } = await claimed();
  expect((await admit(id, job.lease_token)).status).toBe(200);
  await env.DB.prepare(`UPDATE enrichment_component_gates SET state='open',retry_at=?
    WHERE component='source'`).bind(new Date(Date.now() + 60_000).toISOString()).run();
  const denied = await reserve(id, job.lease_token, job.content_revision);
  expect(denied.status).toBe(503);
  expect(await denied.json()).toEqual({ error: "component_paused" });
  expect(await env.DB.prepare("SELECT COUNT(*) FROM enrichment_provider_attempts WHERE link_id=?")
    .bind(id).first("COUNT(*)")).toBe(0);
  const released = await admit(id, job.lease_token);
  expect(released.status).toBe(503);
  expect(await released.json()).toEqual({ error: "component_paused" });
  expect(await env.DB.prepare(`SELECT enrichment_status,enrichment_attempts,enrichment_lease_token FROM links WHERE id=?`)
    .bind(id).first()).toEqual({ enrichment_status: "pending", enrichment_attempts: 0,
      enrichment_lease_token: null });
});

it("opens only the failing source gate with the leased failure and retries one probe", async () => {
  const { id, job } = await claimed();
  const waiting = await post("links", { url: "https://x.com/u/status/95" }, "app");
  const waitingID = (await waiting.json() as { id: number }).id;
  expect((await admit(id, job.lease_token)).status).toBe(200);
  expect((await reserve(id, job.lease_token, job.content_revision)).status).toBe(200);
  expect((await settle()).status).toBe(200);
  const failed = await post(`enrichment/jobs/${id}/fail`, {
    lease_token: job.lease_token, error: "[search] HTTP 529",
    component_fault: "source_transient", retry_after_ms: 120_000
  });
  expect(failed.status).toBe(200);
  expect(await env.DB.prepare(`SELECT state,failures,reason FROM enrichment_component_gates
    WHERE component='source'`).first()).toEqual({ state: "open", failures: 1,
      reason: "provider_transient" });
  expect(await env.DB.prepare("SELECT state FROM enrichment_component_gates WHERE component='reading'")
    .first("state")).toBe("closed");
  expect((await post("enrichment/jobs/claim")).status).toBe(503);
  expect(await env.DB.prepare("SELECT enrichment_attempts FROM links WHERE id=?")
    .bind(waitingID).first("enrichment_attempts")).toBe(0);
  await env.DB.prepare(`UPDATE enrichment_component_gates SET retry_at='2000-01-01'
    WHERE component='source'`).run();
  const probe = await post("enrichment/jobs/claim");
  expect(probe.status).toBe(200);
  const next = await probe.json() as { id: number; lease_token: string };
  expect(next.id).toBe(waitingID);
  expect((await post(`enrichment/jobs/${next.id}/fail`, {
    lease_token: next.lease_token, error: "probe failed before payment"
  })).status).toBe(200);
  expect(await env.DB.prepare(`SELECT state,failures,reason FROM enrichment_component_gates
    WHERE component='source'`).first()).toEqual({ state: "open", failures: 2,
      reason: "probe_failed" });
});

it("does not open a provider gate when admission failed before reservation", async () => {
  const { id, job } = await claimed();
  expect((await admit(id, job.lease_token)).status).toBe(200);
  const failed = await post(`enrichment/jobs/${id}/fail`, {
    lease_token: job.lease_token, error: "worker reservation unavailable",
    component_fault: "source_transient", retry_after_ms: 120_000
  });
  expect(failed.status).toBe(409);
  expect(await failed.json()).toEqual({ error: "provider_attempt_missing" });
  expect(await env.DB.prepare(`SELECT enrichment_status,enrichment_attempts,enrichment_lease_token
    FROM links WHERE id=?`).bind(id).first()).toEqual({ enrichment_status: "pending",
    enrichment_attempts: 0, enrichment_lease_token: null });
  expect(await env.DB.prepare(`SELECT state,failures FROM enrichment_component_gates
    WHERE component='source'`).first()).toEqual({ state: "closed", failures: 0 });
});

it("returns an unused local-stage lease without charging an attempt", async () => {
  const { id, job } = await claimed();
  expect((await admit(id, job.lease_token)).status).toBe(200);
  const deferred = await post(`enrichment/jobs/${id}/local-defer`, {
    lease_token: job.lease_token, stage: "fetch"
  });
  expect(deferred.status).toBe(200);
  expect(await deferred.json()).toEqual({ id, status: "deferred" });
  expect(await env.DB.prepare(`SELECT enrichment_status,enrichment_attempts,
    enrichment_lease_token FROM links WHERE id=?`).bind(id).first()).toEqual({
    enrichment_status: "pending", enrichment_attempts: 0, enrichment_lease_token: null
  });
  expect((await post("enrichment/jobs/claim")).status).toBe(200);
});

it("keeps a paid source attempt while deferring reading and fences reserved reading", async () => {
  const { id, job } = await claimed();
  expect((await admit(id, job.lease_token)).status).toBe(200);
  expect((await reserve(id, job.lease_token, job.content_revision)).status).toBe(200);
  expect((await settle()).status).toBe(200);
  const source = { original_text: "fetched text", original_language: "en", context_text: "",
    related_links: [], image_urls: [], model: "fixture" };
  expect((await post(`enrichment/jobs/${id}/source`, {
    lease_token: job.lease_token, source
  })).status).toBe(200);
  const deferred = await post(`enrichment/jobs/${id}/local-defer`, {
    lease_token: job.lease_token, stage: "reading"
  });
  expect(deferred.status).toBe(200);
  expect(await env.DB.prepare(`SELECT enrichment_status,enrichment_attempts,original_text
    FROM links WHERE id=?`).bind(id).first()).toEqual({ enrichment_status: "pending",
    enrichment_attempts: 1, original_text: "fetched text" });
  const next = await post("enrichment/jobs/claim");
  expect(next.status).toBe(200);
  const reading = await next.json() as { lease_token: string; content_revision: number };
  expect((await admit(id, reading.lease_token, 210_000, "reading")).status).toBe(200);
  expect((await reserve(id, reading.lease_token, reading.content_revision, "reading")).status).toBe(200);
  const blocked = await post(`enrichment/jobs/${id}/local-defer`, {
    lease_token: reading.lease_token, stage: "reading"
  });
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toEqual({ error: "provider_result_unknown" });
});

it("releases a half-open probe when reservation fails before the provider call", async () => {
  const { id } = await claimed();
  await env.DB.prepare(`UPDATE links SET enrichment_status='pending',enrichment_lease_token=NULL,
    enrichment_lease_until=NULL,enrichment_attempts=0 WHERE id=?`).bind(id).run();
  await env.DB.prepare(`UPDATE enrichment_component_gates SET state='open',failures=1,
    reason='provider_transient',retry_at='2000-01-01' WHERE component='source'`).run();
  const probe = await post("enrichment/jobs/claim");
  expect(probe.status).toBe(200);
  const job = await probe.json() as { id: number; lease_token: string };
  expect(job.id).toBe(id);
  expect((await admit(id, job.lease_token)).status).toBe(200);
  const failed = await post(`enrichment/jobs/${id}/fail`, {
    lease_token: job.lease_token, error: "reservation response missing",
    component_fault: "source_transient"
  });
  expect(failed.status).toBe(409);
  expect(await failed.json()).toEqual({ error: "provider_attempt_missing" });
  expect(await env.DB.prepare(`SELECT state,failures,reason,probe_token FROM enrichment_component_gates
    WHERE component='source'`).first()).toEqual({ state: "open", failures: 1,
    reason: "provider_transient", probe_token: null });
  expect(await env.DB.prepare("SELECT enrichment_attempts FROM links WHERE id=?")
    .bind(id).first("enrichment_attempts")).toBe(0);
});

it("closes a reading probe only after its paid completion commits", async () => {
  const created = await post("links", { url: "https://x.com/u/status/96" }, "app");
  const id = (await created.json() as { id: number }).id;
  await env.DB.prepare("UPDATE links SET original_text='stored text' WHERE id=?").bind(id).run();
  await env.DB.prepare(`UPDATE enrichment_component_gates SET state='open',retry_at='2000-01-01'
    WHERE component='reading'`).run();
  const claimed = await post("enrichment/jobs/claim");
  expect(claimed.status).toBe(200);
  const job = await claimed.json() as { id: number; lease_token: string; content_revision: number };
  expect(job.id).toBe(id);
  expect(await env.DB.prepare("SELECT state FROM enrichment_component_gates WHERE component='reading'")
    .first("state")).toBe("probing");
  expect((await admit(id, job.lease_token, 210_000, "reading")).status).toBe(200);
  expect((await reserve(id, job.lease_token, job.content_revision, "reading")).status).toBe(200);
  expect((await settle("reading")).status).toBe(200);
  const completion = { lease_token: job.lease_token, original_text: "stored text",
    ai_title: "测试标题", original_language: "en", translated_text: "中文译文",
    summary: "测试摘要", related_links: [], images: [], model: "fixture" };
  expect((await post(`enrichment/jobs/${id}/complete`, completion)).status).toBe(200);
  expect(await env.DB.prepare("SELECT state FROM enrichment_component_gates WHERE component='reading'")
    .first("state")).toBe("closed");
});
