import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { emitRequest, requestPolicy, resetObservabilityCacheForTest } from "../src/observability";

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

  it("bounds platform log volume and reports dropped events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
    expect((await publish({ version: 0, logs: "basic" })).status).toBe(200);
    const policy = await requestPolicy(env.DB);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const input = new Request("https://share.example/api/links/123?private=secret", { method: "POST" });
    const output = new Response(null, { status: 201 });
    for (let i = 0; i < 123; i++) emitRequest(policy, input, output, 1);
    expect(log).toHaveBeenCalledTimes(120);
    vi.setSystemTime(new Date(Date.now() + 60_001));
    emitRequest(policy, input, output, 1);
    expect(JSON.parse(String(log.mock.calls[120][0]))).toEqual({ schema: 1, kind: "worker_log_drops", count: 3 });
    expect(log).toHaveBeenCalledTimes(122);
  });

  it("labels private paid-attempt routes without logging their payload", async () => {
    expect((await publish({ version: 0, logs: "basic" })).status).toBe(200);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await request("/api/enrichment/provider-attempts/reserve?operation_key=private", {
      method: "POST", body: JSON.stringify({ secret: "private-prompt" })
    });
    expect(response.status).toBe(400);
    expect(log).toHaveBeenCalledOnce();
    const event = JSON.parse(String(log.mock.calls[0][0]));
    expect(event).toMatchObject({ route: "/api/enrichment/provider-attempts/reserve",
      method: "POST", status: 400 });
    expect(JSON.stringify(event)).not.toMatch(/private|prompt|operation_key/);
  });
});
