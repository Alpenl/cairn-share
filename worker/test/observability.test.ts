import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { emitRequest, emitWorkerBusiness, requestPolicy, resetObservabilityCacheForTest } from "../src/observability";

const API_TOKEN = "app_test_token";
const ENRICHER_TOKEN = "enricher_test_token";
const endpoint = "/api/internal/observability";

beforeEach(async () => {
  resetObservabilityCacheForTest();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function request(path: string, init: RequestInit = {}, token: string | null = ENRICHER_TOKEN): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return worker.fetch(new Request(`https://share.example${path}`, { ...init, headers }), {
    DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
    CAIRN_API_TOKEN: API_TOKEN, CAIRN_ENRICHER_TOKEN: ENRICHER_TOKEN
  } satisfies Env);
}

function publish(body: unknown, token: string | null = ENRICHER_TOKEN): Promise<Response> {
  return request(endpoint, { method: "POST", body: JSON.stringify(body) }, token);
}

describe("application observability control", () => {
  it("rejects public writes, malformed policies, and oversized bodies", async () => {
    expect((await publish({ version: 0, logs: "basic" }, null)).status).toBe(401);
    expect((await publish({ version: 0, logs: "basic" }, API_TOKEN)).status).toBe(401);
    expect((await publish({ version: 0, logs: "basic", secret: "leak" })).status).toBe(400);
    expect((await publish({ version: 0, logs: "diagnostic", fallback_logs: "off", diagnostic_until: Date.now() + 7200000 })).status).toBe(400);
    expect((await publish({ version: 0, logs: "basic", padding: "x".repeat(2000) })).status).toBe(400);
    const row = await env.DB.prepare("SELECT version FROM observability_policy").first<{ version: number }>();
    expect(row?.version).toBe(-1);
  });

  it("publishes monotonically, accepts the same replay, and rejects conflicts", async () => {
    const basic = { version: 0, logs: "basic" };
    expect((await publish(basic)).status).toBe(200);
    expect((await publish(basic)).status).toBe(200);
    const old = await publish({ version: 0, logs: "off" });
    expect(old.status).toBe(409);
    await expect(old.json()).resolves.toEqual({ error: "observability_version_conflict", version: 0 });
    expect((await publish({ version: 1, logs: "off" })).status).toBe(200);
    expect((await publish(basic)).status).toBe(409);
    const row = await env.DB.prepare("SELECT version, logs FROM observability_policy").first<{ version: number; logs: string }>();
    expect(row).toMatchObject({ version: 1, logs: "off" });
  });

  it("expires diagnostics locally and only emits safe route templates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
    const until = Date.now() + 1000;
    expect((await publish({ version: 0, logs: "diagnostic", fallback_logs: "off", diagnostic_until: until })).status).toBe(200);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await request("/api/links/123?private=secret", { method: "GET" }, API_TOKEN);
    expect(first.headers.get("x-cairn-observability-version")).toBe("0");
    expect(consoleLog).toHaveBeenCalledOnce();
    const event = JSON.parse(String(consoleLog.mock.calls[0][0]));
    expect(event).toMatchObject({ route: "/api/links/:id", method: "GET", status: 404, d1_stats: "unavailable" });
    expect(JSON.stringify(event)).not.toMatch(/123|private|secret/);
    vi.setSystemTime(new Date(Date.now() + 1001));
    await request("/health", { method: "GET" });
    expect(consoleLog).toHaveBeenCalledOnce();
  });

  it("uses one cached policy read and observes an external update after 30 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
    const first = await request("/health", { method: "GET" });
    expect(first.headers.get("x-cairn-observability-version")).toBe("-1");
    await env.DB.prepare("UPDATE observability_policy SET version = 2, logs = 'basic' WHERE singleton = 1").run();
    const cached = await request("/health", { method: "GET" });
    expect(cached.headers.get("x-cairn-observability-version")).toBe("-1");
    vi.setSystemTime(new Date(Date.now() + 30001));
    const refreshed = await request("/health", { method: "GET" });
    expect(refreshed.headers.get("x-cairn-observability-version")).toBe("2");
  });

  it("fails closed when the policy table is unavailable", async () => {
    await env.DB.prepare("DROP TABLE observability_policy").run();
    const response = await request("/health", { method: "GET" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-cairn-observability-status")).toBe("unavailable");
    expect(response.headers.get("x-cairn-observability-version")).toBe("-1");
    expect((await publish({ version: 0, logs: "diagnostic", fallback_logs: "off", diagnostic_until: Date.now() + 1000 })).status).toBe(503);
  });

  it("keeps a confirmed policy on refresh failure, expires diagnostics, and recovers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
    const until = Date.now() + 40_000;
    expect((await publish({ version: 0, logs: "diagnostic", fallback_logs: "basic", diagnostic_until: until })).status).toBe(200);
    const failingDB = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => {
          if (sql.includes("FROM observability_policy")) throw new Error("D1 unavailable");
          return target.prepare(sql);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as D1Database;
    const health = (database: D1Database) => worker.fetch(new Request("https://share.example/health"), {
      DB: database, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
      CAIRN_API_TOKEN: API_TOKEN, CAIRN_ENRICHER_TOKEN: ENRICHER_TOKEN
    } satisfies Env);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.setSystemTime(new Date(Date.now() + 30_001));
    const stale = await health(failingDB);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-cairn-observability-version")).toBe("0");
    expect(stale.headers.get("x-cairn-observability-status")).toBe("unavailable");
    expect(log).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date(Date.now() + 10_000));
    const expired = await health(failingDB);
    expect(expired.headers.get("x-cairn-observability-status")).toBe("unavailable");
    expect(log).toHaveBeenCalledOnce(); // fallback basic omits successful GETs

    await env.DB.prepare("UPDATE observability_policy SET version=1,logs='off',fallback_logs=NULL,diagnostic_until=NULL WHERE singleton=1").run();
    vi.setSystemTime(new Date(Date.now() + 5_001));
    const recovered = await health(env.DB);
    expect(recovered.headers.get("x-cairn-observability-version")).toBe("1");
    expect(recovered.headers.get("x-cairn-observability-status")).toBeNull();
    expect(log).toHaveBeenCalledOnce();
  });

  it("bounds platform log volume and reports dropped events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
    expect((await publish({ version: 0, logs: "basic" })).status).toBe(200);
    const policy = await requestPolicy(env.DB);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const input = new Request("https://share.example/api/links/123?private=secret", { method: "POST" });
    const output = new Response(null, { status: 201 });
    for (let i = 0; i < 123; i++) emitRequest(policy, input, output, 1);
    expect(log).toHaveBeenCalledTimes(122);
    expect(JSON.parse(String(log.mock.calls[120][0]))).toMatchObject({
      kind: "worker_log_drops", lane: "request", count: 1
    });
    expect(JSON.parse(String(log.mock.calls[121][0]))).toMatchObject({
      kind: "worker_log_drops", lane: "request", count: 2
    });
    const status = await request(endpoint, { method: "GET" });
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("private, no-store");
    await expect(status.json()).resolves.toMatchObject({ scope: "isolate", effective_logs: "basic",
      collector_delivery: "unknown",
      window: { request: { emitted: 120, dropped: 3 } },
      totals: { request: { emitted: 120, dropped: 3 } } });
    vi.setSystemTime(new Date(Date.now() + 60_001));
    emitRequest(policy, input, output, 1);
    expect(JSON.parse(String(log.mock.calls[122][0]))).toMatchObject({
      kind: "worker_log_drops", lane: "request", count: 3 });
    expect(log).toHaveBeenCalledTimes(124);
  });

  it("reserves a separate bounded lane for business events under request floods", async () => {
    expect((await publish({ version: 0, logs: "basic" })).status).toBe(200);
    const policy = await requestPolicy(env.DB);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const input = new Request("https://share.example/api/enrichment/jobs", { method: "POST" });
    for (let i = 0; i < 200; i++) emitRequest(policy, input, new Response(null, { status: 200 }), 1);
    emitWorkerBusiness(policy, { kind: "provider_attempt", action: "reserve", stage: "reading",
      outcome: "reserved", status: 200 });
    expect(log.mock.calls.some(([raw]) => JSON.parse(String(raw)).kind === "provider_attempt")).toBe(true);
    const status = await request(endpoint, { method: "GET" });
    await expect(status.json()).resolves.toMatchObject({ scope: "isolate",
      window: { request: { emitted: 120, dropped: 80 }, business: { emitted: 1, dropped: 0 } } });
    expect((await request(endpoint, { method: "GET" }, API_TOKEN)).status).toBe(401);
    expect((await publish({ version: 1, logs: "off" })).status).toBe(200);
    const before = log.mock.calls.length;
    emitWorkerBusiness(await requestPolicy(env.DB), { kind: "provider_attempt", action: "reserve",
      stage: "reading", outcome: "reserved", status: 200 });
    expect(log).toHaveBeenCalledTimes(before);
    const off = await request(endpoint, { method: "GET" });
    await expect(off.json()).resolves.toMatchObject({ effective_logs: "off",
      totals: { request: { dropped: 80 }, business: { emitted: 1 } } });
  });

  it("counts console write errors without failing business processing", async () => {
    expect((await publish({ version: 0, logs: "basic" })).status).toBe(200);
    const policy = await requestPolicy(env.DB);
    vi.spyOn(console, "log").mockImplementation(() => { throw new Error("collector unavailable"); });
    expect(() => emitWorkerBusiness(policy, { kind: "source_claim", origin: "scheduled",
      outcome: "claimed", status: 200 })).not.toThrow();
    const status = await request(endpoint, { method: "GET" });
    await expect(status.json()).resolves.toMatchObject({ scope: "isolate",
      totals: { business: { emitted: 1, write_errors: 1 } } });
  });

  it("labels private paid-attempt routes without logging their payload", async () => {
    expect((await publish({ version: 0, logs: "basic" })).status).toBe(200);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await request("/api/enrichment/provider-attempts/reserve?operation_key=private", {
      method: "POST", body: JSON.stringify({ secret: "private-prompt" })
    });
    expect(response.status).toBe(400);
    expect(log).toHaveBeenCalledTimes(2);
    const attempt = JSON.parse(String(log.mock.calls[0][0]));
    expect(attempt).toMatchObject({ kind: "provider_attempt", action: "reserve",
      stage: "unknown", outcome: "rejected", status: 400, reason: "invalid_request" });
    const event = JSON.parse(String(log.mock.calls[1][0]));
    expect(event).toMatchObject({ route: "/api/enrichment/provider-attempts/reserve",
      method: "POST", status: 400 });
    expect(JSON.stringify([attempt, event])).not.toMatch(/private|prompt|operation_key/);
  });

  it("records overview cache state and scoped D1 cost in diagnostics", async () => {
    const until = Date.now() + 60_000;
    expect((await publish({ version: 0, logs: "diagnostic", fallback_logs: "off", diagnostic_until: until })).status).toBe(200);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await request("/api/enrichment/overview?", { method: "GET" })).status).toBe(200);
    const miss = JSON.parse(String(log.mock.calls[0][0]));
    expect(miss).toMatchObject({ route: "/api/enrichment/overview", cache_state: "MISS",
      d1_stats: { query: "overview_aggregate", scope: "aggregate_only", rows_written: 0 } });
    expect(miss.d1_stats.rows_read).toBeGreaterThanOrEqual(0);
    expect((await request("/api/enrichment/overview", { method: "GET" })).status).toBe(200);
    const hit = JSON.parse(String(log.mock.calls[1][0]));
    expect(hit).toMatchObject({ route: "/api/enrichment/overview", cache_state: "HIT", d1_stats: "unavailable" });
  });

  it("records each effective export batch cost and can switch logging off", async () => {
    expect((await publish({ version: 0, logs: "basic" })).status).toBe(200);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const send = () => request("/api/v2/links/effective-batch", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [123] })
    });
    const response = await send();
    expect(response.status).toBe(200);
    const wire = await response.text();
    const bytes = new TextEncoder().encode(wire).length;
    const event = JSON.parse(String(log.mock.calls[0][0]));
    expect(event).toMatchObject({ route: "/api/v2/links/effective-batch", method: "POST",
      status: 200, response_bytes: bytes,
      d1_stats: { query: "effective_batch", scope: "effective_view_only",
        sql_count: 1, rows_written: 0 } });
    expect(event.d1_stats.rows_read).toBeGreaterThanOrEqual(0);
    expect(event.d1_stats.rows_read).toBe((JSON.parse(wire) as { d1: { rows_read: number } }).d1.rows_read);
    expect(response.headers.get("Server-Timing")).toMatch(/db;dur=/);
    expect(log).toHaveBeenCalledOnce();

    expect((await publish({ version: 1, logs: "off" })).status).toBe(200);
    const quiet = await send();
    expect(quiet.status).toBe(200);
    expect(log).toHaveBeenCalledOnce();
    expect((await quiet.json() as { d1: { sql_count: number } }).d1.sql_count).toBe(1);
  });
});
