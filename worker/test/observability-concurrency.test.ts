import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { requestPolicy, resetObservabilityCacheForTest } from "../src/observability";

beforeEach(() => resetObservabilityCacheForTest());
afterEach(() => vi.restoreAllMocks());

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

type TestPolicy = { version: number; logs: "off" | "diagnostic";
  fallback_logs: "off" | null; diagnostic_until: number | null };

function heldDatabase(policy: () => TestPolicy, failPolicy = false) {
  const gate = deferred();
  let policyReads = 0, businessReads = 0;
  const DB = {
    prepare(sql: string) {
      const statement = {
        bind() { return statement; },
        async first() {
          if (sql.includes("FROM observability_policy")) {
            policyReads++;
            await gate.promise;
            if (failPolicy) throw new Error("unavailable policy fixture");
            return policy();
          }
          if (!sql.includes("FROM links WHERE id=?")) throw new Error("unexpected business query");
          businessReads++;
          return { id: 1, enrichment_status: "completed", enrichment_updated_at: null,
            enrichment_paid_uncertain: 0, content_revision: 1, app_body_revision: 1,
            personal_revision: 0, cache_decision_id: 0, cache_entity_revision: 0 };
        }
      };
      return statement;
    }
  } as unknown as D1Database;
  return { DB, release: gate.release, policyReads: () => policyReads, businessReads: () => businessReads };
}

function read(DB: D1Database, token = "internal") {
  return worker.fetch(new Request("https://performance.test/api/enrichment/jobs/1/cache-identity?private=omit", {
    headers: { Authorization: `Bearer ${token}`, "X-Cairn-Tag-System": "1" }
  }), { DB, ENRICHMENT_IMAGES: {} as R2Bucket, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}

it("starts business reads while a cold shared policy is pending, then applies its headers and safe logs", async () => {
  const database = heldDatabase(() => ({ version: 7, logs: "diagnostic", fallback_logs: "off",
    diagnostic_until: Date.now() + 60_000 }));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  let finished = 0;
  const requests = [read(database.DB), read(database.DB)].map(p => p.then(r => { finished++; return r; }));
  try {
    await vi.waitFor(() => expect(database.businessReads()).toBe(2));
    expect(database.policyReads()).toBe(1);
    expect(finished).toBe(0);
    expect(log).not.toHaveBeenCalled();
  } finally { database.release(); }
  const responses = await Promise.all(requests);
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Cairn-Observability-Version")).toBe("7");
    expect(response.headers.get("X-Cairn-Observability-Status")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ id: 1, cache_identity: { body_revision: 1 } });
  }
  // The shared policy read belongs to its initiating request only.
  const counts = responses.map(r => Number(r.headers.get("Server-Timing")?.match(/sql-count;desc="(\d+)"/)?.[1]));
  expect(counts.sort()).toEqual([1, 2]);
  expect(log).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|omit|performance\.test/);
});

it("does not emit with a previous diagnostic policy while an expired policy refresh disables logging", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const old = heldDatabase(() => ({ version: 1, logs: "diagnostic", fallback_logs: "off", diagnostic_until: now + 60_000 }));
  old.release();
  await requestPolicy(old.DB);
  clock.mockReturnValue(now + 30_001);
  const database = heldDatabase(() => ({ version: 2, logs: "off", fallback_logs: null, diagnostic_until: null }));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const pending = read(database.DB);
  try {
    await vi.waitFor(() => expect(database.businessReads()).toBe(1));
    expect(log).not.toHaveBeenCalled();
  } finally { database.release(); }
  const response = await pending;
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Cairn-Observability-Version")).toBe("2");
  expect(log).not.toHaveBeenCalled();
});

it("keeps business data readable and logs off if the concurrent initial policy read fails", async () => {
  const database = heldDatabase(() => ({ version: -1, logs: "off", fallback_logs: null, diagnostic_until: null }), true);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const pending = read(database.DB);
  try { await vi.waitFor(() => expect(database.businessReads()).toBe(1)); }
  finally { database.release(); }
  const response = await pending;
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Cairn-Observability-Status")).toBe("unavailable");
  expect(log).not.toHaveBeenCalled();
});

it("still rejects unauthorized requests without starting a business database read", async () => {
  const database = heldDatabase(() => ({ version: -1, logs: "off", fallback_logs: null, diagnostic_until: null }));
  const pending = read(database.DB, "wrong");
  database.release();
  expect((await pending).status).toBe(401);
  expect(database.businessReads()).toBe(0);
});
