import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { taxonomy } from "../src/curation";

const bindings = () => ({ ...env, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
const operation = "manual-source-fixture-1";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function call(path: string, body?: unknown, token = "internal", method?: string) {
  return worker.fetch(new Request(`https://test/api/${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      "X-Cairn-Classification-Budget": "1",
      "X-Cairn-Provider-Attempt-Ledger": "1",
      ...(path.endsWith("/claim") ? { "X-Cairn-Source-Lease-Admission": "1" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), bindings());
}

async function link(url = "https://x.com/source/status/42") {
  const response = await call("links", { url }, "app");
  expect(response.status).toBe(201);
  return (await response.json() as { id: number }).id;
}

async function state(id: number) {
  return env.DB.prepare(`SELECT original_text,content_revision,enrichment_status,enrichment_lease_token,
    refresh_epoch,summary FROM links WHERE id=?`).bind(id).first<{
      original_text: string | null; content_revision: number; enrichment_status: string;
      enrichment_lease_token: string | null; refresh_epoch: number; summary: string | null;
    }>();
}

it("commits manual source before accepting and replays the same operation without requeueing", async () => {
  const id = await link();
  const text = "手动提供的原文";
  const before = (await state(id))!;
  const body = { operation_key: operation, expected_revision: before.content_revision, original_text: text };
  const identity = await call(`enrichment/jobs/${id}?include_cache_identity=1`);
  expect(await identity.json()).toMatchObject({ cache_identity: { content_revision: before.content_revision } });
  const response = await call(`enrichment/jobs/${id}/manual-source`, body);
  expect(response.status).toBe(200);
  const accepted = await response.json() as { content_revision: number };
  expect(accepted.content_revision).toBeGreaterThan(before.content_revision);
  const saved = await state(id);
  expect(saved).toMatchObject({ original_text: text, content_revision: accepted.content_revision,
    enrichment_status: "pending", enrichment_lease_token: null, refresh_epoch: 1 });
  const snapshot = await call(`enrichment/jobs/${id}/source`);
  expect(await snapshot.json()).toMatchObject({ original_text: text, model: "manual", context_text: "" });
  expect(await env.DB.prepare("SELECT status FROM classification_jobs WHERE link_id=?").bind(id).first("status")).toBe("pending");
  const evidence = await env.DB.prepare(`SELECT content_revision,content_hash,payload FROM evidence_snapshots
    WHERE link_id=? ORDER BY id DESC LIMIT 1`).bind(id).first<{
      content_revision: number; content_hash: string; payload: string
    }>();
  expect(evidence?.content_revision).toBe(accepted.content_revision);
  expect(JSON.parse(evidence!.payload)).toMatchObject({
    blocks: [{ text, role: "primary", acquired: "manual" }], retrieval: "manual"
  });
  const claim = await call("enrichment/classifications/claim", {
    taxonomy_version: taxonomy.version, policy_version: "jev-tags-v1", model: "jev-latest"
  });
  expect(claim.status).toBe(200);
  expect(await claim.json()).toMatchObject({ id, content_revision: accepted.content_revision,
    evidence_hash: evidence!.content_hash });

  const receipt = await call(`enrichment/jobs/${id}/manual-source`, body);
  expect(receipt.status).toBe(200);
  expect(await receipt.json()).toEqual({ id, status: "source_saved", content_revision: accepted.content_revision });
  expect(await state(id)).toEqual(saved);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM manual_source_operations WHERE link_id=?").bind(id).first("n")).toBe(1);
  expect((await call(`enrichment/jobs/${id}/manual-source`, { ...body, original_text: "different" })).status).toBe(409);
  expect(await state(id)).toEqual(saved);
  const readingClaim = await call(`enrichment/jobs/${id}/claim`, {});
  expect(readingClaim.status).toBe(200);
  expect(await readingClaim.json()).toMatchObject({ id, refresh_epoch: 0 });
});

it("logs source acceptance only after durable evidence and distinguishes replay", async () => {
  const id = await link("https://x.com/source/status/205");
  const revision = (await state(id))!.content_revision;
  expect((await call("internal/observability", { version: 1, logs: "basic" })).status).toBe(200);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const body = { operation_key: "private-source-key", expected_revision: revision,
      original_text: "手动提供的敏感原文" };
    expect((await call(`enrichment/jobs/${id}/manual-source`, body)).status).toBe(200);
    expect((await call(`enrichment/jobs/${id}/manual-source`, body)).status).toBe(200);
    expect((await call(`enrichment/jobs/${id}/manual-source`, { ...body,
      operation_key: "other", expected_revision: revision + 2 })).status).toBe(409);
    expect((await call(`enrichment/jobs/${id}/claim`, {})).status).toBe(200);
    const entries = log.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
    expect(entries.filter((entry) => entry.kind === "manual_request").map((entry) =>
      [entry.action, entry.outcome, entry.status])).toEqual([
      ["source", "accepted", 200], ["source", "replay", 200], ["source", "rejected", 409]
    ]);
    expect(entries.filter((entry) => entry.kind === "source_claim")).toEqual([
      { schema: 1, config_version: 1, kind: "source_claim", origin: "by_id",
        outcome: "claimed", status: 200 }
    ]);
    expect(JSON.stringify(entries)).not.toContain(body.operation_key);
    expect(JSON.stringify(entries)).not.toContain(body.original_text);
  } finally {
    log.mockRestore();
  }
});

it("rejects an active lease, then fences an expired one without losing curation", async () => {
  const id = await link();
  const leased = await call(`enrichment/jobs/${id}/claim`, {});
  const { lease_token } = await leased.json() as { lease_token: string };
  await env.DB.prepare("UPDATE links SET why='human note',curation_status='kept' WHERE id=?").bind(id).run();
  const body = {
    operation_key: operation, expected_revision: (await state(id))!.content_revision, original_text: "manual text"
  };
  const before = await state(id);
  const busy = await call(`enrichment/jobs/${id}/manual-source`, body);
  expect(busy.status).toBe(409);
  expect(await busy.json()).toMatchObject({ error: "lease_conflict" });
  expect(await state(id)).toEqual(before);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM manual_source_operations").first("n")).toBe(0);
  expect((await call(`enrichment/jobs/${id}/lease-admit`, {
    lease_token, stage: "fetch", min_remaining_ms: 210_000
  })).status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind(new Date(Date.now() - 1000).toISOString(), id).run();
  expect((await call(`enrichment/jobs/${id}/manual-source`, body)).status).toBe(200);
  expect(await env.DB.prepare("SELECT enrichment_paid_uncertain,enrichment_paid_stage FROM links WHERE id=?")
    .bind(id).first()).toEqual({ enrichment_paid_uncertain: 0, enrichment_paid_stage: null });
  expect((await call(`enrichment/jobs/${id}/source`, { lease_token, source: {
    original_text: "stale text", original_language: "en", context_text: "", related_links: [], image_urls: [], model: "fixture"
  } })).status).toBe(409);
  expect(await env.DB.prepare("SELECT why,curation_status FROM links WHERE id=?").bind(id).first()).toEqual({
    why: "human note", curation_status: "kept"
  });
  expect((await state(id))?.original_text).toBe("manual text");
});

it("sets a one-shot fetch intent only for an explicit refresh", async () => {
  const id = await link();
  const refreshed = await call(`enrichment/jobs/${id}/refresh-source`, {});
  expect(refreshed.status).toBe(200);
  const claim = await call(`enrichment/jobs/${id}/claim`, {});
  expect(claim.status).toBe(200);
  const job = await claim.json() as { refresh_epoch: number; lease_token: string };
  expect(job.refresh_epoch).toBe(1);
  expect((await call(`enrichment/jobs/${id}/refresh-source`, {})).status).toBe(409);
  const ack = await call(`enrichment/jobs/${id}/refresh-source/ack`, {
    epoch: job.refresh_epoch, status: "completed"
  });
  expect(ack.status).toBe(200);
  await env.DB.prepare(`UPDATE links SET enrichment_status='pending',enrichment_lease_token=NULL,
    enrichment_lease_until=NULL WHERE id=?`).bind(id).run();
  const retry = await call(`enrichment/jobs/${id}/claim`, {});
  expect(await retry.json()).toMatchObject({ id, refresh_epoch: 0 });
});

it("consumes a refresh intent in the successful source checkpoint transaction", async () => {
  const id = await link();
  expect((await call(`enrichment/jobs/${id}/refresh-source`, {})).status).toBe(200);
  const claimed = await call(`enrichment/jobs/${id}/claim`, {});
  expect(claimed.status).toBe(200);
  const job = await claimed.json() as { lease_token: string; refresh_epoch: number };
  expect(job.refresh_epoch).toBe(1);
  const body = { lease_token: job.lease_token, source: { original_text: "new source text",
    original_language: "en", context_text: "", related_links: [], image_urls: [], model: "fixture" } };
  await env.DB.prepare(`CREATE TRIGGER reject_refresh_source BEFORE INSERT ON enrichment_sources
    BEGIN SELECT RAISE(ABORT, 'synthetic source insert failure'); END`).run();
  await expect(call(`enrichment/jobs/${id}/source`, body)).rejects.toThrow("synthetic source insert failure");
  expect(await env.DB.prepare("SELECT original_text,refresh_requested_at FROM links WHERE id=?")
    .bind(id).first()).toMatchObject({ original_text: null, refresh_requested_at: expect.any(String) });
  await env.DB.prepare("DROP TRIGGER reject_refresh_source").run();
  expect((await call(`enrichment/jobs/${id}/source`, body)).status).toBe(200);
  expect(await env.DB.prepare("SELECT original_text,refresh_requested_at FROM links WHERE id=?")
    .bind(id).first()).toEqual({ original_text: "new source text", refresh_requested_at: null });
  // An identical checkpoint can be retried after its HTTP response is lost.
  expect((await call(`enrichment/jobs/${id}/source`, body)).status).toBe(200);
  await env.DB.prepare(`UPDATE links SET enrichment_status='pending',enrichment_lease_token=NULL,
    enrichment_lease_until=NULL WHERE id=?`).bind(id).run();
  const next = await call(`enrichment/jobs/${id}/claim`, {});
  expect(next.status).toBe(200);
  expect(await next.json()).toMatchObject({ id, refresh_epoch: 0 });
});

it("claims a newer manual source ahead of an older routine retrieval", async () => {
  const routine = await link("https://x.com/source/status/1");
  const manual = await link("https://x.com/source/status/2");
  const revision = (await state(manual))!.content_revision;
  expect((await call(`enrichment/jobs/${manual}/manual-source`, {
    operation_key: "manual-priority", expected_revision: revision, original_text: "pasted post"
  })).status).toBe(200);
  const first = await call("enrichment/jobs/claim", {});
  expect(await first.json()).toMatchObject({ id: manual, refresh_epoch: 0 });
  const second = await call("enrichment/jobs/claim", {});
  expect(await second.json()).toMatchObject({ id: routine, refresh_epoch: 0 });
});

it("requires current content revision and internal credentials", async () => {
  const id = await link();
  const revision = (await state(id))!.content_revision;
  const body = { operation_key: operation, expected_revision: revision, original_text: "manual text" };
  expect((await call(`enrichment/jobs/${id}/manual-source`, body, "app")).status).toBe(401);
  expect((await call(`enrichment/jobs/${id}/manual-source`, { ...body, expected_revision: revision + 1 })).status).toBe(409);
  expect((await call(`enrichment/jobs/${id}/manual-source`, body)).status).toBe(200);
  expect((await call(`enrichment/jobs/${id}/manual-source`, { ...body, operation_key: "another" })).status).toBe(409);
  expect((await call(`enrichment/jobs/${id}/manual-source`, { ...body, operation_key: operation, expected_revision: revision + 1 })).status).toBe(409);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM manual_source_operations WHERE link_id=?").bind(id).first("n")).toBe(1);
  const other = await link("https://example.com/not-x");
  expect((await call(`enrichment/jobs/${other}/manual-source`, { ...body, operation_key: "other", expected_revision: (await state(other))!.content_revision })).status).toBe(409);
});

it("rolls back the source, lease fence and receipt when snapshot storage fails", async () => {
  const id = await link();
  const lease = await (await call(`enrichment/jobs/${id}/claim`, {})).json() as { lease_token: string };
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind(new Date(Date.now() - 1000).toISOString(), id).run();
  const before = await state(id);
  await env.DB.prepare(`CREATE TRIGGER reject_manual_source BEFORE INSERT ON enrichment_sources
    BEGIN SELECT RAISE(ABORT, 'injected source failure'); END`).run();
  await expect(call(`enrichment/jobs/${id}/manual-source`, {
    operation_key: operation, expected_revision: before!.content_revision, original_text: "private fixture"
  })).rejects.toThrow("injected source failure");
  expect(await state(id)).toEqual(before);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM manual_source_operations").first("n")).toBe(0);
  expect((await state(id))?.enrichment_lease_token).toBe(lease.lease_token);
});

it("accepts concurrent replays once and advances provenance when primary bytes are unchanged", async () => {
  const id = await link();
  const lease = await (await call(`enrichment/jobs/${id}/claim`, {})).json() as { lease_token: string };
  const text = "same primary bytes";
  expect((await call(`enrichment/jobs/${id}/source`, { lease_token: lease.lease_token, source: {
    original_text: text, original_language: "en", context_text: "", related_links: [], image_urls: [], model: "fixture"
  } })).status).toBe(200);
  await env.DB.prepare("UPDATE links SET enrichment_lease_until=? WHERE id=?")
    .bind(new Date(Date.now() - 1000).toISOString(), id).run();
  const before = (await state(id))!;
  const body = { operation_key: operation, expected_revision: before.content_revision, original_text: text };
  const responses = await Promise.all(Array.from({ length: 4 }, () => call(`enrichment/jobs/${id}/manual-source`, body)));
  expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200]);
  const revisions = await Promise.all(responses.map(response => response.json() as Promise<{ content_revision: number }>));
  expect(new Set(revisions.map(row => row.content_revision)).size).toBe(1);
  expect(revisions[0].content_revision).toBe(before.content_revision + 1);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM manual_source_operations WHERE link_id=?").bind(id).first("n")).toBe(1);
  const evidence = await env.DB.prepare("SELECT payload FROM evidence_snapshots WHERE link_id=? ORDER BY id DESC LIMIT 1")
    .bind(id).first<{ payload: string }>();
  expect(JSON.parse(evidence!.payload)).toMatchObject({ retrieval: "manual",
    blocks: [{ role: "primary", text, acquired: "manual" }] });
});

it("rejects oversized text and removes receipts with deleted bookmarks", async () => {
  const id = await link();
  const revision = (await state(id))!.content_revision;
  expect((await call(`enrichment/jobs/${id}/manual-source`, {
    operation_key: operation, expected_revision: revision, original_text: "字".repeat(40_000)
  })).status).toBe(400);
  expect((await call(`enrichment/jobs/${id}/manual-source`, {
    operation_key: operation, expected_revision: revision, original_text: "private fixture"
  })).status).toBe(200);
  expect((await call(`links/${id}`, undefined, "app", "DELETE")).status).toBe(204);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM manual_source_operations").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM enrichment_sources").first("n")).toBe(0);
});
