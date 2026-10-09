import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { withoutLogEnvelope } from "./log-envelope";

const bindings = () => ({ ...env, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function call(path: string, body: unknown = {}, token = "internal") {
  return worker.fetch(new Request(`https://test/api/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      "X-Cairn-Provider-Attempt-Ledger": "1" },
    body: JSON.stringify(body)
  }), bindings());
}

async function link(url: string) {
  const response = await call("links", { url }, "app");
  expect(response.status).toBe(201);
  const { id } = await response.json() as {id:number};
  await env.DB.prepare("UPDATE links SET original_text='fixture archived original' WHERE id=?").bind(id).run();
  return id;
}

const enqueue = (id: number, key = `manual-process-${id}`) =>
  call(`enrichment/jobs/${id}/enqueue`, { operation_key: key });

it("persists and coalesces a manual rerun, then claims it before routine work", async () => {
  const routine = await link("https://x.com/u/status/1");
  const manual = await link("https://x.com/u/status/2");
  await env.DB.prepare("UPDATE links SET enrichment_status='completed',original_text='saved post' WHERE id=?")
    .bind(manual).run();
  const first = await enqueue(manual);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ id: manual, status: "pending" });
  expect((await enqueue(manual)).status).toBe(200);
  expect(await env.DB.prepare("SELECT enrichment_status,manual_priority,original_text FROM links WHERE id=?")
    .bind(manual).first()).toMatchObject({ enrichment_status: "pending", manual_priority: 1,
      original_text: "saved post" });
  expect(await (await call("enrichment/jobs/claim")).json()).toMatchObject({ id: manual });
  expect(await (await call("enrichment/jobs/claim")).json()).toMatchObject({ id: routine });
});

it("logs accepted, replay, claim and rejection after their durable outcomes", async () => {
  const id = await link("https://x.com/u/status/201");
  expect((await call("internal/observability", { version: 1, logs: "basic" })).status).toBe(200);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect((await enqueue(id, "private-process-key")).status).toBe(200);
    expect((await enqueue(id, "private-process-key")).status).toBe(200);
    expect((await call("enrichment/jobs/claim")).status).toBe(200);
    expect((await enqueue(id, "new-process-key")).status).toBe(409);
    const entries = log.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
    expect(entries.filter((entry) => entry.kind === "manual_request").map((entry) =>
      [entry.action, entry.outcome, entry.status])).toEqual([
      ["process", "accepted", 200], ["process", "replay", 200], ["process", "rejected", 409]
    ]);
    expect(entries.filter((entry) => entry.kind === "source_claim").map(withoutLogEnvelope)).toEqual([
      { schema: 1, config_version: 1, kind: "source_claim", origin: "scheduled",
        outcome: "claimed", status: 200 }
    ]);
    expect(JSON.stringify(entries)).not.toContain("private-process-key");
    expect((await call("internal/observability", { version: 2, logs: "off" })).status).toBe(200);
    const count = log.mock.calls.length;
    expect((await enqueue(id, "private-process-key")).status).toBe(200);
    expect(log.mock.calls.length).toBe(count);
  } finally {
    log.mockRestore();
  }
});

it("accepts an explicit manual rerun of a dropped bookmark without making automatic drop eligible", async () => {
  const automaticDrop = await link("https://x.com/u/status/10");
  const manualDrop = await link("https://x.com/u/status/11");
  await env.DB.prepare("UPDATE links SET curation_status='drop' WHERE id IN (?,?)")
    .bind(automaticDrop, manualDrop).run();
  expect((await enqueue(manualDrop)).status).toBe(200);
  expect(await (await call("enrichment/jobs/claim")).json()).toMatchObject({ id: manualDrop });
  expect((await call("enrichment/jobs/claim")).status).toBe(204);
});

it("returns 429 before adding more pending work and preserves a pasted source", async () => {
  await env.DB.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100)
    INSERT INTO links(url,created_at,manual_priority) SELECT 'https://x.com/u/status/'||n,'t',1 FROM seq`).run();
  const id = await link("https://x.com/u/status/101");
  const queued = await enqueue(id);
  expect(queued.status).toBe(429);
  expect(queued.headers.get("Retry-After")).toBe("5");
  expect(await queued.json()).toEqual({ error: "manual_queue_full" });
  const refresh = await call(`enrichment/jobs/${id}/refresh-source`);
  expect(refresh.status).toBe(410);
  const revision = await env.DB.prepare("SELECT content_revision FROM links WHERE id=?")
    .bind(id).first<number>("content_revision");
  const pasted = await call(`enrichment/jobs/${id}/manual-source`, {
    operation_key: "manual-over-limit", expected_revision: revision, original_text: "keep this in form"
  });
  expect(pasted.status).toBe(429);
  expect(pasted.headers.get("Retry-After")).toBe("5");
  expect(await env.DB.prepare("SELECT original_text,manual_priority,refresh_requested_at FROM links WHERE id=?")
    .bind(id).first()).toMatchObject({ original_text: "fixture archived original", manual_priority: 0,
      refresh_requested_at: null });
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM manual_source_operations").first<number>("n")).toBe(0);
  await env.DB.prepare("UPDATE links SET original_text='existing original' WHERE id=1").run();
  expect((await enqueue(1)).status).toBe(200);
});

it("marks queue-limit rejection without a false accepted event", async () => {
  await env.DB.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100)
    INSERT INTO links(url,created_at,manual_priority) SELECT 'https://x.com/u/status/'||n,'t',1 FROM seq`).run();
  const id = await link("https://x.com/u/status/301");
  const revision = await env.DB.prepare("SELECT content_revision FROM links WHERE id=?")
    .bind(id).first<number>("content_revision");
  expect((await call("internal/observability", { version: 1, logs: "basic" })).status).toBe(200);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect((await enqueue(id, "over-limit-process")).status).toBe(429);
    expect((await call(`enrichment/jobs/${id}/manual-source`, {
      operation_key: "over-limit-source", expected_revision: revision, original_text: "private text"
    })).status).toBe(429);
    const entries = log.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
    expect(entries.filter((entry) => entry.kind === "manual_request").map((entry) =>
      [entry.action, entry.outcome, entry.status])).toEqual([
      ["process", "rejected", 429], ["source", "rejected", 429]
    ]);
    expect(JSON.stringify(entries)).not.toContain("private text");
  } finally {
    log.mockRestore();
  }
});

it("rejects active processing leases while source refresh remains retired", async()=>{
 const id=await link("https://x.com/u/status/20");
 expect((await call(`enrichment/jobs/${id}/refresh-source`)).status).toBe(410);
 expect((await call(`enrichment/jobs/${id}/claim`)).status).toBe(200);
 expect((await enqueue(id)).status).toBe(409);
});

it("replays an accepted operation after completion without starting a second paid run", async () => {
  const id = await link("https://x.com/u/status/99");
  expect((await enqueue(id, "one-logical-request")).status).toBe(200);
  const claimed = await call("enrichment/jobs/claim");
  expect(await claimed.json()).toMatchObject({ id });
  await env.DB.prepare("UPDATE links SET enrichment_status='completed',manual_priority=0 WHERE id=?")
    .bind(id).run();
  expect((await enqueue(id, "one-logical-request")).status).toBe(200);
  expect(await env.DB.prepare("SELECT enrichment_status,manual_priority FROM links WHERE id=?")
    .bind(id).first()).toEqual({ enrichment_status: "completed", manual_priority: 0 });
  const other = await link("https://x.com/u/status/100");
  expect((await enqueue(other, "one-logical-request")).status).toBe(409);
  expect((await call(`enrichment/jobs/${id}/refresh-source`, {
    operation_key: "one-logical-request"
  })).status).toBe(410);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM manual_request_operations")
    .first<number>("n")).toBe(1);
});

it("rejects both new and replayed source refresh requests",async()=>{
 const id=await link("https://x.com/u/status/30");const body={operation_key:"refresh-once"};
 for(let i=0;i<2;i++)expect((await call(`enrichment/jobs/${id}/refresh-source`,body)).status).toBe(410);
 expect(await env.DB.prepare("SELECT refresh_requested_at FROM links WHERE id=?").bind(id).first("refresh_requested_at")).toBeNull();
});
