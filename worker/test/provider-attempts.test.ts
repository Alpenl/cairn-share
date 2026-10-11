import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetObservabilityCacheForTest } from "../src/observability";
import { withoutLogEnvelope } from "./log-envelope";

const bindings = () => ({ ...env, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal",
  CAIRN_OPERATOR_TOKEN: "operator" });
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  resetObservabilityCacheForTest();
});

function call(path: string, body?: unknown, token = "internal", method = "POST") {
  return worker.fetch(new Request(`https://test/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      "X-Cairn-Provider-Attempt-Ledger": "1",
      ...(path.endsWith("/claim") ? { "X-Cairn-Source-Lease-Admission": "1" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), bindings());
}

async function fixture(stage: "fetch" | "reading" = "reading") {
  const created = await call("links", { url: "https://x.com/u/status/100" }, "app");
  const { id } = await created.json() as { id: number };
  await env.DB.prepare("UPDATE links SET original_text='archived original' WHERE id=?").bind(id).run();
  const claimed = await call("enrichment/jobs/claim", {});
  expect(claimed.status).toBe(200);
  const job = await claimed.json() as { lease_token: string; content_revision: number };
  expect((await call(`enrichment/jobs/${id}/lease-admit`, {
    lease_token: job.lease_token, stage: "reading", min_remaining_ms: 210_000
  })).status).toBe(200);
  if(stage==="fetch") await env.DB.prepare("UPDATE links SET enrichment_paid_stage='fetch' WHERE id=?").bind(id).run();
  return { id, ...job, stage };
}

function first(job: Awaited<ReturnType<typeof fixture>>) {
  return { operation_key: "a".repeat(64), request_hash: "b".repeat(64), model: "grok-test",
    stage: job.stage, variant: job.stage === "fetch" ? "fetch_thread" : "reading", attempt_number: 1,
    link_id: job.id, lease_token: job.lease_token, content_revision: job.content_revision,
    min_remaining_ms: 210_000 };
}
async function seedHistoricalFetch(body: ReturnType<typeof first>) {
 const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body.lease_token));
 const leaseHash=[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");
 await env.DB.prepare(`INSERT INTO enrichment_provider_attempts(operation_key,link_id,lease_hash,content_revision,stage,variant,attempt_number,request_hash,reservation_hash,model,created_at)
  VALUES(?,?,?,?,'fetch','fetch_thread',1,?,?,?,?)`).bind(body.operation_key,body.link_id,leaseHash,body.content_revision,body.request_hash,"0".repeat(64),body.model,new Date().toISOString()).run();
 return new Response(JSON.stringify({granted:true,reason:"reserved"}),{status:200});
}
const settle = (operation_key: string, http_status = 200) => ({ operation_key, http_status,
  response_id: "resp_test", input_tokens: 100, output_tokens: 20, total_tokens: 120,
  x_search_calls: 1, cost_usd_ticks: 1234 });
const reconcile = (operation_key: string) => ({ operation_key, verdict: "confirmed_not_billed",
  actor: "ops@example.org", evidence_kind: "provider_support",
  evidence_ref: "case-20260929-123" });
const recoveredSource = (operation_key: string) => ({ operation_key, response_id: "resp_test",
  actor: "ops@example.org", source: { original_text: "Recovered original source",
    original_language: "en", context_text: "Quoted context", related_links: [],
    image_urls: [], model: "grok-test" } });

it("grants one durable permit, rejects replay and binds to the current lease and content", async () => {
  const job = await fixture();
  const body = first(job);
  const path = "enrichment/provider-attempts/reserve";
  expect((await call(path, body, "app")).status).toBe(401);
  const firstResponse = await call(path, body);
  expect(firstResponse.status).toBe(200);
  expect(await firstResponse.json()).toEqual({ granted: true, reason: "reserved" });
  expect(await (await call(path, body)).json()).toEqual({ granted: false, reason: "already_reserved" });
  expect((await call(path, { ...body, request_hash: "c".repeat(64) })).status).toBe(409);
  expect((await call(path, { ...body, operation_key: "d".repeat(64) })).status).toBe(409);
  expect((await call(path, { ...body, operation_key: "e".repeat(64), content_revision: 99 })).status).toBe(409);
  const row = await env.DB.prepare(`SELECT lease_hash,content_revision,state FROM enrichment_provider_attempts
    WHERE operation_key=?`).bind(body.operation_key).first<{lease_hash:string;content_revision:number;state:string}>();
  expect(row).toMatchObject({ content_revision: job.content_revision, state: "reserved" });
  expect(row!.lease_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(row!.lease_hash).not.toBe(job.lease_token);
});

it("separates durable reservation from reported provider settlement in safe events", async () => {
  const job = await fixture();
  const body = first(job);
  expect((await call("internal/observability", { version: 1, logs: "basic" })).status).toBe(200);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const reservePath = "enrichment/provider-attempts/reserve";
    const settlePath = "enrichment/provider-attempts/settle";
    expect(await (await call(reservePath, body)).json()).toEqual({ granted: true, reason: "reserved" });
    expect(await (await call(reservePath, body)).json()).toEqual({ granted: false, reason: "already_reserved" });
    expect((await call(reservePath, { ...body, request_hash: "c".repeat(64) })).status).toBe(409);
    expect((await call(reservePath, { ...body, operation_key: "e".repeat(64) })).status).toBe(409);
    expect((await call(reservePath, { ...body, operation_key: "invalid" })).status).toBe(400);
    expect((await call(settlePath, settle(body.operation_key))).status).toBe(200);
    expect((await call(settlePath, settle(body.operation_key))).status).toBe(200);
    expect((await call(settlePath, settle(body.operation_key, 502))).status).toBe(409);
    const canary = { operation_key: "f".repeat(64), request_hash: "d".repeat(64),
      model: "grok-test", stage: "canary", variant: "canary", attempt_number: 1 };
    expect((await call(reservePath, canary)).status).toBe(200);
    expect((await call(settlePath, { operation_key: canary.operation_key, http_status: 502,
      response_id: null, input_tokens: null, output_tokens: null, total_tokens: null,
      x_search_calls: null, cost_usd_ticks: null })).status).toBe(200);
    await env.DB.prepare("UPDATE enrichment_provider_daily_usage SET total=? WHERE day=?")
      .bind(500, new Date().toISOString().slice(0, 10)).run();
    expect((await call(reservePath, { ...canary, operation_key: "8".repeat(64) })).status).toBe(429);
    const entries = log.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
    expect(entries.filter((entry) => entry.kind === "provider_attempt").map(withoutLogEnvelope)).toEqual([
      { schema: 1, config_version: 1, kind: "provider_attempt", action: "reserve",
        stage: "reading", outcome: "reserved", status: 200 },
      { schema: 1, config_version: 1, kind: "provider_attempt", action: "reserve",
        stage: "reading", outcome: "already_reserved", status: 200 },
      { schema: 1, config_version: 1, kind: "provider_attempt", action: "reserve",
        stage: "reading", outcome: "rejected", status: 409, reason: "operation_conflict" },
      { schema: 1, config_version: 1, kind: "provider_attempt", action: "reserve",
        stage: "reading", outcome: "rejected", status: 409, reason: "lease_conflict" },
      { schema: 1, config_version: 1, kind: "provider_attempt", action: "reserve",
        stage: "unknown", outcome: "rejected", status: 400, reason: "invalid_request" },
      { schema: 1, config_version: 1, kind: "provider_attempt", action: "settle",
        stage: "reading", outcome: "responded", status: 200,
        provider_status: 200, response_id_present: true },
      { schema: 1, config_version: 1, kind: "provider_attempt", action: "settle",
        stage: "reading", outcome: "replay", status: 200,
        provider_status: 200, response_id_present: true },
      { schema: 1, config_version: 1, kind: "provider_attempt", action: "settle",
        stage: "reading", outcome: "rejected", status: 409, reason: "operation_conflict" },
      { schema: 1, config_version: 1, kind: "provider_attempt", action: "reserve",
        stage: "canary", outcome: "reserved", status: 200 },
      { schema: 1, config_version: 1, kind: "provider_attempt", action: "settle",
        stage: "canary", outcome: "responded", status: 200,
        provider_status: 502, response_id_present: false },
      { schema: 1, config_version: 1, kind: "provider_attempt", action: "reserve",
        stage: "canary", outcome: "rejected", status: 429, reason: "budget_exhausted" }
    ]);
    expect(JSON.stringify(entries)).not.toContain(body.operation_key);
    expect(JSON.stringify(entries)).not.toContain(body.request_hash);
    expect(JSON.stringify(entries)).not.toContain(job.lease_token);
    expect((await call("internal/observability", { version: 2, logs: "off" })).status).toBe(200);
    const count = log.mock.calls.length;
    expect((await call(settlePath, settle(body.operation_key))).status).toBe(200);
    expect(log.mock.calls.length).toBe(count);
  } finally {
    log.mockRestore();
  }
});

it("rejects all new source-fetch permits",async()=>{
  const job=await fixture();const initial={...first(job),stage:"fetch",variant:"fetch_thread"};
  expect((await call("enrichment/provider-attempts/reserve",initial)).status).toBe(410);
  expect((await call("enrichment/provider-attempts/authorize-fallback",{operation_key:initial.operation_key})).status).toBe(410);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM enrichment_provider_attempts").first("n")).toBe(0);
});

it("rejects the retired source fallback authorization",async()=>{
  const job=await fixture();const initial={...first(job),stage:"fetch",variant:"fetch_thread"};
  expect((await call("enrichment/provider-attempts/reserve",initial)).status).toBe(410);
  expect((await call("enrichment/provider-attempts/authorize-fallback",{operation_key:initial.operation_key})).status).toBe(410);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM enrichment_provider_attempts").first("n")).toBe(0);
});

it("keeps a lost provider result charged across lease expiry and deletes private rows with the link", async () => {
  const job = await fixture();
  const body = first(job);
  expect((await call("enrichment/provider-attempts/reserve", body)).status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", job.id).run();
  expect((await call("enrichment/provider-attempts/reserve", { ...body,
    operation_key: "c".repeat(64) })).status).toBe(409);
  const listed = await call("enrichment/provider-attempts?state=reserved", undefined, "internal", "GET");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({ items: [{ operation_key: body.operation_key, state: "reserved" }] });
  const summary = await call("enrichment/provider-attempts/summary", undefined, "internal", "GET");
  expect(summary.status).toBe(200);
  expect(await summary.json()).toMatchObject({ unknown: { count: 1 },
    budget: { used: { total: 1, fetch_first: 0, fetch_fallback: 0, reading: 1 } } });
  expect((await call("enrichment/provider-attempts/summary", undefined, "app", "GET")).status).toBe(401);
  expect((await call("enrichment/provider-attempts?state=reserved", undefined, "app", "GET")).status).toBe(401);
  expect((await call(`links/${job.id}`, undefined, "app", "DELETE")).status).toBe(204);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_provider_attempts WHERE link_id=?")
    .bind(job.id).first<{n:number}>())?.n).toBe(0);
});

it("lets only the separate operator inspect one permit without exposing source or hashes", async () => {
  const job = await fixture();
  const body = first(job);
  const path = `enrichment/provider-attempts/inspect?operation_key=${body.operation_key}`;
  expect((await call("enrichment/provider-attempts/reserve", body)).status).toBe(200);
  expect((await call(path, undefined, "app", "GET")).status).toBe(401);
  expect((await call(path, undefined, "internal", "GET")).status).toBe(401);
  expect((await call("enrichment/provider-attempts/inspect?operation_key=bad", undefined, "operator", "GET")).status).toBe(400);
  expect((await call(path + "&state=all", undefined, "operator", "GET")).status).toBe(400);
  expect((await call(`enrichment/provider-attempts/inspect?operation_key=${"f".repeat(64)}`,
    undefined, "operator", "GET")).status).toBe(404);
  const unknown = await call(path, undefined, "operator", "GET");
  expect(unknown.status).toBe(200);
  const unknownBody = await unknown.text();
  expect(JSON.parse(unknownBody)).toMatchObject({ attempt: {
    operation_key: body.operation_key, link_id: job.id, content_revision: job.content_revision,
    state: "reserved", response_id: null, current_paid_unresolved: 1
  } });
  expect(unknownBody).not.toContain(job.lease_token);
  expect(unknownBody).not.toContain(body.request_hash);
  expect(unknownBody).not.toContain("https://x.com/");
  expect((await call("enrichment/provider-attempts/settle", settle(body.operation_key))).status).toBe(200);
  expect(await (await call(path, undefined, "operator", "GET")).json()).toMatchObject({ attempt: {
    state: "responded", response_id: "resp_test", http_status: 200, input_tokens: 100
  } });
  expect((await call(`links/${job.id}`, undefined, "app", "DELETE")).status).toBe(204);
  expect((await call(path, undefined, "operator", "GET")).status).toBe(404);
});

it("requires separate operator proof and an expired matching lease before releasing an unknown attempt", async () => {
  const job = await fixture();
  const body = first(job);
  const path = "enrichment/provider-attempts/reconcile";
  expect((await call("enrichment/provider-attempts/reserve", body)).status).toBe(200);
  expect((await call(path, reconcile(body.operation_key), "internal")).status).toBe(401);
  expect((await call(path, reconcile(body.operation_key), "app")).status).toBe(401);
  expect((await call(path, reconcile(body.operation_key), "operator")).status).toBe(409);
  expect((await call(path, { ...reconcile(body.operation_key), evidence_ref: "no" }, "operator")).status).toBe(400);
  expect((await call(`enrichment/jobs/${job.id}/fail`, {
    lease_token: job.lease_token, error: "provider_result_unknown"
  })).status).toBe(200);
  expect(await env.DB.prepare(`SELECT enrichment_status,enrichment_lease_token,
    enrichment_paid_uncertain FROM links WHERE id=?`).bind(job.id).first())
    .toMatchObject({ enrichment_status: "failed", enrichment_lease_token: job.lease_token,
      enrichment_paid_uncertain: 1 });
  expect((await call(path, reconcile(body.operation_key), "operator")).status).toBe(409);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", job.id).run();
  expect(await (await call(path, reconcile(body.operation_key), "operator")).json())
    .toEqual({ reconciled: true, status: "pending" });
  const inspected = await call(`enrichment/provider-attempts/inspect?operation_key=${body.operation_key}`,
    undefined, "operator", "GET");
  expect(await inspected.json()).toMatchObject({ attempt: { state: "confirmed_not_billed",
    evidence_kind: "provider_support", current_paid_unresolved: 0 } });
  expect(await env.DB.prepare(`SELECT enrichment_status,enrichment_paid_uncertain,enrichment_attempts,
    enrichment_lease_token FROM links WHERE id=?`).bind(job.id).first())
    .toMatchObject({ enrichment_status: "pending", enrichment_paid_uncertain: 0,
      enrichment_attempts: 0, enrichment_lease_token: null });
  expect(await (await call(path, reconcile(body.operation_key), "operator")).json())
    .toEqual({ reconciled: true, status: "pending" });
  expect((await call(path, { ...reconcile(body.operation_key), evidence_ref: "case-20260929-456" }, "operator")).status).toBe(409);
  expect((await call("enrichment/provider-attempts/settle", settle(body.operation_key))).status).toBe(409);
  const rows = await call("enrichment/provider-attempts?state=confirmed_not_billed", undefined, "internal", "GET");
  expect(await rows.json()).toMatchObject({ items: [{ operation_key: body.operation_key,
    state: "confirmed_not_billed", reconciled_by: "ops@example.org" }] });
  const summary = await call("enrichment/provider-attempts/summary", undefined, "internal", "GET");
  expect(await summary.json()).toMatchObject({ unknown: { count: 0 }, budget: { used: { total: 1 } } });
  const claimed = await call("enrichment/jobs/claim", {});
  expect(claimed.status).toBe(200);
  const next = await claimed.json() as { lease_token: string };
  expect(next.lease_token).not.toBe(job.lease_token);
  expect((await call("enrichment/provider-attempts/reserve", body)).status).toBe(200);
  expect(await (await call("enrichment/provider-attempts/reserve", body)).json())
    .toEqual({ granted: false, reason: "already_reserved" });
});

it("reports operator-confirmed nonbilling only after its audit and queue transition commit", async () => {
  const job = await fixture();
  const permit = first(job);
  expect((await call("enrichment/provider-attempts/reserve", permit)).status).toBe(200);
  expect((await call(`enrichment/jobs/${job.id}/fail`, {
    lease_token: job.lease_token, error: "provider_result_unknown"
  })).status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", job.id).run();
  expect((await call("internal/observability", { version: 1, logs: "basic" })).status).toBe(200);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const path = "enrichment/provider-attempts/reconcile";
    const body = reconcile(permit.operation_key);
    expect((await call(path, body, "operator")).status).toBe(200);
    expect((await call(path, body, "operator")).status).toBe(200);
    expect((await call(path, { ...body, evidence_ref: "case-20260929-other" }, "operator")).status).toBe(409);
    const entries = log.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
    expect(entries.filter((entry) => entry.kind === "provider_attempt").map((entry) =>
      [entry.action, entry.stage, entry.outcome, entry.status])).toEqual([
      ["reconcile", "reading", "confirmed_not_billed", 200],
      ["reconcile", "reading", "replay", 200],
      ["reconcile", "unknown", "rejected", 409]
    ]);
    expect(JSON.stringify(entries)).not.toContain(permit.operation_key);
    expect(JSON.stringify(entries)).not.toContain(body.evidence_ref);
    expect(await env.DB.prepare("SELECT enrichment_status,enrichment_paid_uncertain FROM links WHERE id=?")
      .bind(job.id).first()).toMatchObject({ enrichment_status: "pending", enrichment_paid_uncertain: 0 });
  } finally {
    log.mockRestore();
  }
});

it("recovers one settled source atomically after expiry without another paid permit", async () => {
  const job = await fixture("fetch");
  const permit = first(job);
  const path = "enrichment/provider-attempts/recover-source";
  const body = recoveredSource(permit.operation_key);
  expect((await call(path, body, "app")).status).toBe(401);
  expect((await call(path, body, "internal")).status).toBe(401);
  expect((await seedHistoricalFetch(permit)).status).toBe(200);
  expect((await call("enrichment/provider-attempts/settle", settle(permit.operation_key))).status).toBe(200);
  expect((await call(path, body, "operator")).status).toBe(409);
  expect((await call(`enrichment/jobs/${job.id}/fail`, {
    lease_token: job.lease_token, error: "provider_result_unknown"
  })).status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", job.id).run();
  const recovered = await call(path, body, "operator");
  expect(recovered.status).toBe(200);
  const receipt = await recovered.json() as { recovered: boolean; id: number; content_revision: number };
  expect(receipt).toMatchObject({ recovered: true, id: job.id, status: "source_saved" });
  expect(receipt.content_revision).toBeGreaterThan(job.content_revision);
  const link = await env.DB.prepare(`SELECT original_text,source_context_text,enrichment_status,
    enrichment_paid_uncertain,enrichment_lease_token,content_revision FROM links WHERE id=?`)
    .bind(job.id).first();
  expect(link).toMatchObject({ original_text: body.source.original_text,
    source_context_text: body.source.context_text, enrichment_status: "pending",
    enrichment_paid_uncertain: 0, enrichment_lease_token: null,
    content_revision: receipt.content_revision });
  expect((await env.DB.prepare("SELECT payload FROM enrichment_sources WHERE link_id=?")
    .bind(job.id).first<{ payload: string }>())?.payload).toContain("Recovered original source");
  expect(await env.DB.prepare(`SELECT content_revision,completeness FROM evidence_snapshots
    WHERE link_id=? ORDER BY id DESC LIMIT 1`).bind(job.id).first())
    .toMatchObject({ content_revision: receipt.content_revision, completeness: "complete" });
  expect(await env.DB.prepare(`SELECT source_payload,evidence_payload,lease_token,response
    FROM enrichment_provider_source_recoveries WHERE operation_key=?`).bind(permit.operation_key).first())
    .toMatchObject({ source_payload: null, evidence_payload: null, lease_token: null });
  expect(await (await call(path, body, "operator")).json()).toEqual(receipt);
  expect((await call(path, { ...body, source: { ...body.source, original_text: "conflict" } }, "operator")).status).toBe(409);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_provider_source_recoveries")
    .first<{ n: number }>())?.n).toBe(1);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_provider_attempts WHERE link_id=?")
    .bind(job.id).first<{ n: number }>())?.n).toBe(1);
  expect((await env.DB.prepare("SELECT total FROM enrichment_provider_daily_usage WHERE day=?")
    .bind(new Date().toISOString().slice(0, 10)).first<{ total: number }>())?.total).toBe(1);
  expect((await call(`links/${job.id}`, undefined, "app", "DELETE")).status).toBe(204);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_provider_source_recoveries")
    .first<{ n: number }>())?.n).toBe(0);
  expect((await env.DB.prepare("SELECT total FROM enrichment_provider_daily_usage WHERE day=?")
    .bind(new Date().toISOString().slice(0, 10)).first<{ total: number }>())?.total).toBe(1);
});

it("reports settled source recovery and replay without logging source or permit identifiers", async () => {
  const job = await fixture("fetch");
  const permit = first(job);
  expect((await seedHistoricalFetch(permit)).status).toBe(200);
  expect((await call("enrichment/provider-attempts/settle", settle(permit.operation_key))).status).toBe(200);
  expect((await call(`enrichment/jobs/${job.id}/fail`, {
    lease_token: job.lease_token, error: "provider_result_unknown"
  })).status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", job.id).run();
  expect((await call("internal/observability", { version: 1, logs: "basic" })).status).toBe(200);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const path = "enrichment/provider-attempts/recover-source";
    const body = recoveredSource(permit.operation_key);
    expect((await call(path, body, "operator")).status).toBe(200);
    expect((await call(path, body, "operator")).status).toBe(200);
    const entries = log.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
    expect(entries.filter((entry) => entry.kind === "provider_recovery").map((entry) =>
      [entry.stage, entry.outcome, entry.status])).toEqual([
      ["source", "committed", 200], ["source", "replay", 200]
    ]);
    expect(entries.filter((entry) => entry.kind === "worker_request").map((entry) => entry.route))
      .toEqual(Array(2).fill("/api/enrichment/provider-attempts/recover-source"));
    expect(JSON.stringify(entries)).not.toContain(permit.operation_key);
    expect(JSON.stringify(entries)).not.toContain(body.source.original_text);
  } finally {
    log.mockRestore();
  }
});

it("rejects unbound, changed and failed source recovery without partial writes", async () => {
  const job = await fixture("fetch");
  const permit = first(job);
  const path = "enrichment/provider-attempts/recover-source";
  const body = recoveredSource(permit.operation_key);
  expect((await seedHistoricalFetch(permit)).status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", job.id).run();
  expect((await call(path, body, "operator")).status).toBe(409);
  expect((await call("enrichment/provider-attempts/settle", settle(permit.operation_key))).status).toBe(200);
  expect((await call(path, { ...body, response_id: "resp_other" }, "operator")).status).toBe(409);
  expect((await call(path, { ...body, source: { ...body.source, model: "other" } }, "operator")).status).toBe(409);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_provider_source_recoveries")
    .first<{ n: number }>())?.n).toBe(0);
  await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=?")
    .bind(job.id).run();
  expect((await call(path, body, "operator")).status).toBe(409);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_provider_source_recoveries")
    .first<{ n: number }>())?.n).toBe(0);
});

it("rolls back source recovery audit when the evidence write fails", async () => {
  const job = await fixture("fetch");
  const permit = first(job);
  expect((await seedHistoricalFetch(permit)).status).toBe(200);
  expect((await call("enrichment/provider-attempts/settle", settle(permit.operation_key))).status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", job.id).run();
  await env.DB.prepare(`CREATE TRIGGER block_source_recovery_snapshot BEFORE INSERT ON evidence_snapshots
    WHEN NEW.link_id=${job.id} BEGIN SELECT RAISE(ABORT,'injected snapshot failure'); END`).run();
  await expect(call("enrichment/provider-attempts/recover-source", recoveredSource(permit.operation_key), "operator"))
    .rejects.toThrow();
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_provider_source_recoveries")
    .first<{ n: number }>())?.n).toBe(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_sources WHERE link_id=?")
    .bind(job.id).first<{ n: number }>())?.n).toBe(0);
  expect(await env.DB.prepare("SELECT original_text,enrichment_paid_uncertain FROM links WHERE id=?")
    .bind(job.id).first()).toMatchObject({ original_text: "archived original", enrichment_paid_uncertain: 1 });
});

it("cannot reconcile a settled response or a changed content version", async () => {
  const job = await fixture();
  const body = first(job);
  expect((await call("enrichment/provider-attempts/reserve", body)).status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=?,content_revision=content_revision+1 WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", job.id).run();
  expect((await call("enrichment/provider-attempts/reconcile", reconcile(body.operation_key), "operator")).status).toBe(409);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_provider_reconciliations")
    .first<{n:number}>())?.n).toBe(0);
  await env.DB.prepare("UPDATE links SET content_revision=? WHERE id=?").bind(job.content_revision, job.id).run();
  expect((await call("enrichment/provider-attempts/settle", settle(body.operation_key))).status).toBe(200);
  expect((await call("enrichment/provider-attempts/reconcile", reconcile(body.operation_key), "operator")).status).toBe(409);
});

it("rolls back the operator audit if releasing the blocked link fails", async () => {
  const job = await fixture();
  const body = first(job);
  expect((await call("enrichment/provider-attempts/reserve", body)).status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", job.id).run();
  await env.DB.prepare(`CREATE TRIGGER block_reconciliation BEFORE UPDATE ON links
    WHEN OLD.id=${job.id} AND OLD.enrichment_paid_uncertain=1 AND NEW.enrichment_status='pending'
    BEGIN SELECT RAISE(ABORT,'injected reconciliation failure'); END`).run();
  await expect(call("enrichment/provider-attempts/reconcile", reconcile(body.operation_key), "operator"))
    .rejects.toThrow();
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_provider_reconciliations")
    .first<{n:number}>())?.n).toBe(0);
  expect(await env.DB.prepare("SELECT enrichment_paid_uncertain,enrichment_status FROM links WHERE id=?")
    .bind(job.id).first()).toMatchObject({ enrichment_paid_uncertain: 1,
    enrichment_status: "processing" });
});

it("spaces canaries without a four-per-day lockout and preserves the global ledger", async () => {
  const path = "enrichment/provider-attempts/reserve";
  for (let n = 0; n < 6; n++) {
    const body = { operation_key: n.toString(16).repeat(64), request_hash: "f".repeat(64),
      model: "grok-test", stage: "canary", variant: "canary", attempt_number: 1 };
    expect(await (await call(path, body)).json()).toEqual({ granted: true, reason: "reserved" });
    const blocked = await call(path, {...body, operation_key:"f".repeat(64)});
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({error:"canary_cooldown"});
    expect(blocked.headers.get("Retry-After")).toBe("60");
    await env.DB.prepare("UPDATE enrichment_provider_attempts SET created_at=? WHERE stage='canary'")
      .bind(new Date(Date.now()-61_000).toISOString()).run();
  }
  const summary = await call("enrichment/provider-attempts/summary", undefined, "internal", "GET");
  expect(await summary.json()).toMatchObject({ budget: { used: { canary: 6, total: 6 } } });
});

it("defers a budget-denied stage without charging a job attempt or losing its priority", async () => {
  const job = await fixture();
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<500)
    INSERT INTO enrichment_provider_attempts
      (operation_key,stage,variant,attempt_number,request_hash,reservation_hash,model,created_at)
    SELECT printf('%064x',x),'canary','canary',1,?,?,'fixture',? FROM n`)
    .bind("a".repeat(64), "b".repeat(64), new Date().toISOString()).run();
  const denied = await call("enrichment/provider-attempts/reserve", first(job));
  expect(denied.status).toBe(429);
  expect(await denied.json()).toEqual({ error: "budget_exhausted" });
  const deferred = await call(`enrichment/jobs/${job.id}/budget-defer`, {
    lease_token: job.lease_token, stage: "reading" });
  expect(deferred.status).toBe(200);
  expect(await deferred.json()).toMatchObject({ id: job.id, status: "deferred" });
  expect(await env.DB.prepare(`SELECT enrichment_status,enrichment_attempts,enrichment_paid_uncertain,
    enrichment_next_retry_at FROM links WHERE id=?`).bind(job.id).first())
    .toMatchObject({ enrichment_status: "pending", enrichment_attempts: 0, enrichment_paid_uncertain: 0 });
  expect((await call("enrichment/jobs/claim", {})).status).toBe(204);
  await env.DB.prepare("DELETE FROM enrichment_provider_attempts WHERE link_id IS NULL").run();
  // Advance the fixture's daily aggregate window without altering production
  // code; deleting private attempt rows alone must never refund quota.
  await env.DB.prepare("DELETE FROM enrichment_provider_daily_usage").run();
  await env.DB.prepare("UPDATE links SET enrichment_next_retry_at='2000-01-01T00:00:00.000Z' WHERE id=?")
    .bind(job.id).run();
  const resumed = await call("enrichment/jobs/claim", {});
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toMatchObject({ id: job.id, attempt: 1 });
});

it("cannot release a lease after a paid permit wins the race", async () => {
  const job = await fixture();
  expect((await call("enrichment/provider-attempts/reserve", first(job))).status).toBe(200);
  expect((await call(`enrichment/jobs/${job.id}/budget-defer`, {
    lease_token: job.lease_token, stage: "fetch" })).status).toBe(409);
  expect(await env.DB.prepare(`SELECT enrichment_status,enrichment_attempts,
    enrichment_paid_uncertain,enrichment_lease_token FROM links WHERE id=?`)
    .bind(job.id).first()).toMatchObject({ enrichment_status: "processing",
      enrichment_attempts: 1, enrichment_paid_uncertain: 1,
      enrichment_lease_token: job.lease_token });
});

it("cannot install newly fetched LLM source under a reading lease",async()=>{
 const job=await fixture();
 expect((await call(`enrichment/jobs/${job.id}/source`,{lease_token:job.lease_token,source:recoveredSource("a".repeat(64)).source})).status).toBe(410);
 expect(await env.DB.prepare("SELECT original_text FROM links WHERE id=?").bind(job.id).first("original_text")).toBe("archived original");
});

it("does not complete reading without a settled reading attempt", async () => {
  const job = await fixture();
  await env.DB.prepare("UPDATE links SET enrichment_paid_stage=NULL WHERE id=?").bind(job.id).run();
  const source = { original_text: "saved source", original_language: "en", context_text: "",
    related_links: [], image_urls: [], model: "manual" };
  expect((await call(`enrichment/jobs/${job.id}/source`, { lease_token: job.lease_token, source })).status).toBe(200);
  expect((await call(`enrichment/jobs/${job.id}/lease-admit`, {
    lease_token: job.lease_token, stage: "reading", min_remaining_ms: 210_000
  })).status).toBe(200);
  const completion = { lease_token: job.lease_token, original_text: source.original_text,
    ai_title: "标题", original_language: "en", translated_text: "译文", summary: "摘要",
    related_links: [], images: [], model: "manual" };
  const complete = () => call(`enrichment/jobs/${job.id}/complete`, completion);
  expect((await complete()).status).toBe(409);
  const revision = await env.DB.prepare("SELECT content_revision FROM links WHERE id=?")
    .bind(job.id).first<{content_revision:number}>();
  const reading = { ...first(job), operation_key: "e".repeat(64), request_hash: "f".repeat(64),
    stage: "reading", variant: "reading", attempt_number: 1, content_revision: revision!.content_revision };
  expect((await call("enrichment/provider-attempts/reserve", reading)).status).toBe(200);
  expect((await complete()).status).toBe(409);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_completion_receipts WHERE link_id=?")
    .bind(job.id).first<{n:number}>())?.n).toBe(0);
  expect((await call("enrichment/provider-attempts/settle", settle(reading.operation_key))).status).toBe(200);
  expect((await complete()).status).toBe(200);
});
