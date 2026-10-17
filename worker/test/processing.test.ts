import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";

const capability = "X-Cairn-App-Processing";
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(() => vi.restoreAllMocks());
async function call(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", token = "app", db = env.DB, ack = "1") {
  return worker.fetch(new Request(`https://test.example/api/${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [capability]: ack,
      "X-Cairn-Classification-Budget": "1", "X-Cairn-Classification-Gate": "1" },
    body: body === undefined ? undefined : JSON.stringify(body) }),
    { DB: db, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}
type View = { version: number; id: number; fence: string; content_revision: number; source_hash: string | null; target_generation: number;
  stages: Record<string, Record<string, unknown>>; actions: Record<string, { allowed: boolean; blocked_reason: string | null }> };
async function setup(primary = true, url = "https://x.com/fixture/status/123") {
  const { id } = await (await call("links", { url })).json() as { id: number };
  const image = `enrichment/${id}/${"a".repeat(64)}.png`;
  await env.DB.prepare(`UPDATE links SET original_text=?,enrichment_status='completed',images=?,related_links='["https://external.example/article"]',
    ai_title='Keep title',summary='Keep summary',translated_text='Keep translation',why='Private human explanation',personal_revision=1,
    classification='{"topics":[],"form":"method","use":"try"}' WHERE id=?`).bind(primary ? "Primary source" : null, JSON.stringify([image]), id).run();
  if (primary) expect((await call(`v2/links/${id}/evidence`, { snapshot: { blocks: [
    { id: "primary", role: "primary", text: "Primary source", acquired: "browser" }], fetched_at: "2026-10-17", retrieval: "browser", truncation: { truncated: false } }
  }, "POST", "internal")).status).toBe(200);
  const spec = await (await call("v2/question-specs", { spec_id: "processing-spec", spec_version: 1, questions: {} }, "POST", "internal")).json() as { spec_hash: string };
  expect((await call("enrichment/classifications/target", { spec_id: "processing-spec", spec_hash: spec.spec_hash,
    taxonomy_version: "2026-09-20.1", policy_version: "processing-policy", requested_model: "processing-fixture", protocol: "v2" }, "POST", "internal")).status).toBe(200);
  await env.DB.prepare("UPDATE classification_jobs SET status='completed',target_generation=1 WHERE link_id=?").bind(id).run();
  await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,source,confirmed,revision,operation_key,created_at)
    VALUES (?,'topic','manual-topic','reject','human',1,1,'processing-override','2026-10-17')`).bind(id).run();
  await env.DB.prepare(`INSERT INTO curation_events(link_id,kind,payload,revision,operation_key,created_at)
    VALUES (?,'why','{"why":"human explanation"}',1,'processing-event','2026-10-17')`).bind(id).run();
  const path = `bookmarks/${id}/processing`;
  const view = await (await call(path)).json() as View;
  return { id, path, view, image, body: { version: 1, operation_key: "processing-fixture", fence: view.fence, action: "retry_classification",
    expected_content_revision: view.content_revision, target_generation: view.target_generation } };
}
async function counts() {
  return env.DB.prepare(`SELECT (SELECT COUNT(*) FROM evidence_snapshots) AS snapshots,
    (SELECT COUNT(*) FROM classification_operations) AS operations,(SELECT COUNT(*) FROM classification_provider_attempts) AS attempts,
    (SELECT COUNT(*) FROM enrichment_provider_attempts) AS reading_attempts,(SELECT COUNT(*) FROM budget_ledger) AS budget,
    (SELECT COUNT(*) FROM curation_events) AS events,(SELECT COUNT(*) FROM curation_overrides) AS overrides`).first<Record<string, number>>();
}
async function retained(id: number) {
  return env.DB.prepare("SELECT ai_title,summary,translated_text,images,related_links,classification,why,personal_revision,curation_status FROM links WHERE id=?").bind(id).first();
}
async function job(id: number) { return env.DB.prepare("SELECT * FROM classification_jobs WHERE link_id=?").bind(id).first<Record<string, unknown>>(); }
function beforeBatch(action: () => Promise<void>) {
  let done = false;
  return new Proxy(env.DB, { get(target, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => { if (!done) { done = true; await action(); } return target.batch(statements); };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
}

it("reports four independent states with no inferred reading provenance and no writes or network calls", async () => {
  const f = await setup(), before = await counts();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("status must not fetch"));
  expect(f.view).toMatchObject({ version: 1, id: f.id, stages: { source: { state: "available" },
    reading: { state: "completed", output_state: "unversioned", content_revision: null },
    classification: { state: "completed", output_state: "absent" }, human: { state: "recorded", revision: 2, events: 1, overrides: 1 } },
    policy_replay: { supported: false, reason: "local_policy_executor_required" }, model_calls: 0 });
  expect(f.view.actions.save_primary).toEqual({ allowed: false, blocked_reason: "primary_already_present", model_calls_now: 0,
    may_call_model_later: true, queues: ["reading", "classification"] });
  for (const [path, token] of [[f.path, "app"], [`v2/links/${f.id}/processing`, "internal"]]) {
    const response = await call(path, undefined, "GET", token);
    expect(response.status).toBe(200); expect(response.headers.get(capability)).toBe("1");
    expect(response.headers.get("Cache-Control")).toContain("no-store"); expect(await response.json()).toEqual(f.view);
  }
  expect(fetch).not.toHaveBeenCalled(); expect(await counts()).toEqual(before);
});

it.each([false, true])("saves a missing primary with prior contextual snapshot=%s, preserving media, reading, history and human records", async archived => {
  const f = await setup(false);
  if (archived) expect((await call(`v2/links/${f.id}/evidence`, { snapshot: { blocks: [
    { id: "image", role: "legacy_unknown", text: "Unattributed image text", acquired: "browser" }], fetched_at: "old", retrieval: "browser", truncation: { truncated: true } }
  }, "POST", "internal")).status).toBe(200);
  const view = await (await call(f.path)).json() as View, before = await counts(), keep = await retained(f.id), queued = await job(f.id);
  const text = "Human supplied primary 🙂\nKeep exact whitespace. ";
  const body = { ...f.body, fence: view.fence, expected_content_revision: view.content_revision, action: "save_primary", text };
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("save must never fetch"));
  const response = await call(f.path, body); expect(response.status).toBe(200);
  const receipt = await response.json() as Record<string, unknown>;
  expect(receipt).toMatchObject({ status: "source_saved", action: "save_primary", content_revision: view.content_revision + 1,
    classification_queued: true, reading_queued: true, model_calls: 0, replayed: false });
  expect(await retained(f.id)).toEqual(keep); expect(fetch).not.toHaveBeenCalled();
  expect(await counts()).toEqual({ ...before, snapshots: before!.snapshots + 1, operations: 1 });
  const nextJob = await job(f.id);
  expect(nextJob).toMatchObject({ status: "pending", revision: Number(queued?.revision ?? 0) + 1,
    input_revision: Number(queued?.input_revision ?? 0) + 1, content_revision: receipt.content_revision, evidence_hash: receipt.source_hash });
  const stored = await env.DB.prepare("SELECT payload FROM evidence_snapshots WHERE link_id=? AND content_revision=?")
    .bind(f.id, receipt.content_revision).first<string>("payload");
  const source = JSON.parse(stored!);
  expect(source.blocks.at(-1)).toMatchObject({ role: "primary", text, acquired: "manual" });
  expect(source.truncation.truncated).toBe(archived);
  if (archived) expect(source.blocks[0]).toEqual({ acquired: "browser", id: "image", role: "legacy_unknown", text: "Unattributed image text", url: "", relation: "" });
  expect(await (await call(`enrichment/jobs/${f.id}/source`, undefined, "GET", "internal")).json()).toMatchObject({ original_text: text, model: "manual_primary" });
  // Simulate response loss: receipt recovery must work after a new lease starts.
  await env.DB.prepare("UPDATE links SET enrichment_status='processing',enrichment_lease_until=NULL WHERE id=?").bind(f.id).run();
  expect(await (await call(f.path, body)).json()).toEqual({ ...receipt, replayed: true });
  expect((await job(f.id))?.revision).toBe(nextJob?.revision);
  expect((await call(f.path, { ...body, text: "changed under same key" })).status).toBe(409);
});

it.each(["retry_reading", "retry_classification"])("atomically re-arms only %s and replays concurrent duplicate intents once", async action => {
  const f = await setup(), before = await counts(), keep = await retained(f.id), queued = await job(f.id);
  const readingBefore = await env.DB.prepare("SELECT enrichment_status,enrichment_attempts,enrichment_updated_at FROM links WHERE id=?").bind(f.id).first();
  const body = { ...f.body, action };
  const replies = await Promise.all([call(f.path, body), call(f.path, body)]);
  expect(replies.map(r => r.status)).toEqual([200, 200]);
  const receipts = await Promise.all(replies.map(r => r.json())) as Record<string, unknown>[];
  expect(receipts.map(r => r.replayed).sort()).toEqual([false, true]);
  expect(receipts[0]).toMatchObject({ action, model_calls: 0, reading_queued: action === "retry_reading", classification_queued: action === "retry_classification" });
  expect(await retained(f.id)).toEqual(keep); expect(await counts()).toEqual({ ...before, operations: 1 });
  if (action === "retry_reading") expect(await job(f.id)).toEqual(queued);
  else {
    expect((await job(f.id))?.revision).toBe(Number(queued!.revision) + 1);
    expect((await job(f.id))?.input_revision).toBe(queued!.input_revision);
    expect(await env.DB.prepare("SELECT enrichment_status,enrichment_attempts,enrichment_updated_at FROM links WHERE id=?").bind(f.id).first()).toEqual(readingBefore);
  }
  expect((await call(f.path, { ...body, operation_key: "different-nonce-stale-fence" })).status).toBe(409);
});

it.each(["content", "personal", "target", "media", "reading_lease", "classification_lease", "reading_unknown", "classification_unknown", "source_checkpoint", "run"])("rejects an interleaved %s change at the database boundary", async change => {
  const f = await setup(), before = await counts();
  const db = beforeBatch(async () => {
    if (change === "content" || change === "personal") await env.DB.prepare(`UPDATE links SET ${change === "content" ? "content_revision" : "personal_revision"}=${change === "content" ? "content_revision" : "personal_revision"}+1 WHERE id=?`).bind(f.id).run();
    if (change === "target") await env.DB.prepare("UPDATE classification_target_state SET generation=0 WHERE id=1").run();
    if (change === "media") await env.DB.prepare("UPDATE links SET images='[]' WHERE id=?").bind(f.id).run();
    if (change === "reading_lease") await env.DB.prepare("UPDATE links SET enrichment_status='processing',enrichment_lease_until=NULL WHERE id=?").bind(f.id).run();
    if (change === "classification_lease") await env.DB.prepare("UPDATE classification_jobs SET status='processing',lease_until=NULL WHERE link_id=?").bind(f.id).run();
    if (change === "reading_unknown") await env.DB.prepare("UPDATE links SET enrichment_paid_uncertain=1 WHERE id=?").bind(f.id).run();
    if (change === "classification_unknown") await env.DB.prepare("INSERT INTO classification_reservations(reservation_key,link_id,payload_hash,identity,created_at) VALUES ('new',?,'hash','{}','now')").bind(f.id).run();
    if (change === "source_checkpoint") await env.DB.prepare("INSERT INTO enrichment_sources(link_id,url,original_text,payload,fetched_at) SELECT id,url,original_text,'{}','now' FROM links WHERE id=?").bind(f.id).run();
    if (change === "run") await env.DB.prepare(`INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,target_generation,
      requested_model,policy_version,answers,operation_key,status,created_at)
      SELECT id,content_revision,'processing-spec','hash',1,'fixture','policy','{}','arrived-run','succeeded','now' FROM links WHERE id=?`).bind(f.id).run();
  });
  expect((await call(f.path, f.body, "POST", "app", db)).status).toBe(409);
  expect(await counts()).toEqual(before);
});

it("keeps uncertain, busy, queued and unsupported stages separate instead of disabling unrelated retry", async () => {
  const f = await setup();
  await env.DB.prepare("UPDATE links SET enrichment_paid_uncertain=1,enrichment_status='processing',enrichment_lease_until=NULL WHERE id=?").bind(f.id).run();
  let view = await (await call(f.path)).json() as View;
  expect(view.stages.reading.state).toBe("result_unknown");
  expect(view.actions.retry_reading).toMatchObject({ allowed: false, blocked_reason: "provider_result_unknown" });
  expect(view.actions.retry_classification.allowed).toBe(true);
  expect((await call(f.path, { ...f.body, fence: view.fence })).status).toBe(200);
  view = await (await call(f.path)).json() as View;
  expect(view.actions.retry_classification).toMatchObject({ allowed: false, blocked_reason: "already_queued" });
});

it("does not pretend arbitrary-site reading is supported while keeping its source/classification path available", async () => {
  const f = await setup(false, "https://example.com/article");
  expect(f.view.actions.save_primary.allowed).toBe(true);
  const receipt = await (await call(f.path, { ...f.body, action: "save_primary", text: "New primary" })).json();
  expect(receipt).toMatchObject({ reading_queued: false, classification_queued: true });
  const view = await (await call(f.path)).json() as View;
  expect(view.actions.retry_reading).toMatchObject({ allowed: false, blocked_reason: "reading_unsupported" });
});

it("normalizes absent legacy related links in the same source revision and makes the exact new source claimable", async () => {
  const f = await setup(false);
  await env.DB.prepare("UPDATE links SET related_links=NULL WHERE id=?").bind(f.id).run();
  const view = await (await call(f.path)).json() as View;
  expect(view.actions.save_primary.allowed).toBe(true);
  const beforeJob = await job(f.id);
  const response = await call(f.path, { ...f.body, fence: view.fence, expected_content_revision: view.content_revision, action: "save_primary", text: "Primary restored" });
  expect(response.status).toBe(200);
  const saved = await response.json() as Record<string, unknown>;
  expect(saved.content_revision).toBe(view.content_revision + 1);
  expect(await env.DB.prepare("SELECT related_links FROM links WHERE id=?").bind(f.id).first("related_links")).toBe("[]");
  expect((await job(f.id))?.revision).toBe(Number(beforeJob?.revision ?? 0) + 1);
  const claimed = await call("enrichment/classifications/claim", { protocol: "v2", spec_ids: ["processing-spec"],
    taxonomy_versions: ["2026-09-20.1"], policy_versions: ["processing-policy"], models: ["processing-fixture"], expected_generation: 1 }, "POST", "internal");
  expect(claimed.status).toBe(200);
  expect(await claimed.json()).toMatchObject({ id: f.id, content_revision: saved.content_revision, evidence_hash: saved.source_hash });
});

it("recovers concurrent primary saves once, retains an old checkpoint and never exposes the internal receipt as a model completion", async () => {
  const f = await setup(false);
  const oldPayload = '{"old":"exact checkpoint bytes","context_text":""}';
  await env.DB.prepare("INSERT INTO enrichment_sources(link_id,url,original_text,payload,fetched_at) SELECT id,url,'',?,'old' FROM links WHERE id=?")
    .bind(oldPayload, f.id).run();
  const view = await (await call(f.path)).json() as View, before = await counts(), oldJob = await job(f.id);
  const body = { ...f.body, fence: view.fence, expected_content_revision: view.content_revision, action: "save_primary", text: "New primary" };
  const replies = await Promise.all([call(f.path, body), call(f.path, body)]);
  expect(replies.map(r => r.status)).toEqual([200, 200]);
  const receipts = await Promise.all(replies.map(r => r.json())) as Record<string, unknown>[];
  expect(receipts.map(r => r.replayed).sort()).toEqual([false, true]);
  expect(await counts()).toEqual({ ...before, snapshots: before!.snapshots + 1, operations: 1 });
  expect((await job(f.id))?.revision).toBe(Number(oldJob?.revision ?? 0) + 1);
  const payload = await env.DB.prepare("SELECT payload FROM evidence_snapshots WHERE link_id=? AND content_revision=?")
    .bind(f.id, receipts[0].content_revision).first<string>("payload");
  expect(JSON.parse(payload!).previous_source_checkpoint).toBe(oldPayload);
  expect((await call(`enrichment/classifications/${f.id}/complete`, { operation_key: `app-processing:${body.operation_key}`,
    lease_token: "not-an-app-authority", revision: 1, result: {} }, "POST", "app")).status).toBe(401);
});

it("enforces the existing manual queue capacity again at commit while a class-only retry remains independent", async () => {
  const f = await setup();
  const before = await counts();
  const fill = async () => { await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100)
    INSERT INTO links(url,created_at,enrichment_status,manual_priority) SELECT 'https://x.com/capacity/'||x,'now','pending',1 FROM n`).run(); };
  const db = beforeBatch(fill);
  expect((await call(f.path, { ...f.body, action: "retry_reading" }, "POST", "app", db)).status).toBe(409);
  expect(await counts()).toEqual(before);
  const view = await (await call(f.path)).json() as View;
  expect(view.actions.retry_reading).toMatchObject({ allowed: false, blocked_reason: "manual_queue_full" });
  expect(view.actions.retry_classification.allowed).toBe(true);
  expect((await call(f.path, { ...f.body, fence: view.fence })).status).toBe(200);
});

it.each(["unversioned", "partial"])("does not label %s historical classification output as current", async kind => {
  const f = await setup();
  await env.DB.prepare(`INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,target_generation,requested_model,
    policy_version,answers,operation_key,coverage,status,created_at,evidence_snapshot_id,source_hash)
    SELECT l.id,l.content_revision,t.spec_id,t.spec_hash,t.generation,t.requested_model,t.policy_version,'{}','processing-run',
      ?,'succeeded','now',?,? FROM links l JOIN classification_targets t ON t.generation=1 WHERE l.id=?`)
    .bind(kind === "partial" ? "partial" : "complete", kind === "partial" ? await env.DB.prepare("SELECT id FROM evidence_snapshots WHERE link_id=?").bind(f.id).first("id") : null,
      kind === "partial" ? f.view.source_hash : null, f.id).run();
  const view = await (await call(f.path)).json() as View;
  expect(view.stages.classification.output_state).toBe(kind);
});

it("blocks a successful provider call without a committed result and accepts only its exact durable completion receipt", async () => {
  const f = await setup();
  const identity = JSON.stringify({ revision: 4, input_revision: 3, target_generation: 1 });
  await env.DB.prepare("INSERT INTO classification_reservations(reservation_key,link_id,payload_hash,identity,created_at) VALUES ('known-success',?,'hash',?,'now')")
    .bind(f.id, identity).run();
  await env.DB.prepare("INSERT INTO classification_attempt_operations(operation_key,link_id,payload_hash,created_at) VALUES ('known-success',?,'hash','now')").bind(f.id).run();
  await env.DB.prepare(`INSERT INTO classification_provider_attempts(link_id,operation_key,reservation_key,call_json,created_at)
    VALUES (?,'known-success','known-success','{"http_status":200,"usage_missing":false,"error_class":"none"}','now')`).bind(f.id).run();
  let view = await (await call(f.path)).json() as View;
  expect(view.stages.classification.state).toBe("result_unknown");
  expect(view.actions.retry_classification).toMatchObject({ allowed: false, blocked_reason: "provider_result_unknown" });
  // Another successful generation is not proof about this exact attempt.
  await env.DB.prepare(`INSERT INTO classification_operations(operation_key,link_id,payload_hash,status,response,created_at)
    VALUES (?,?,'hash','applied','{"status":"completed"}','now')`).bind(`classify-${f.id}-rev-4-input-3-gen-2`, f.id).run();
  view = await (await call(f.path)).json() as View;
  expect(view.actions.retry_classification.allowed).toBe(false);
  await env.DB.prepare(`INSERT INTO classification_operations(operation_key,link_id,payload_hash,status,response,created_at)
    VALUES (?,?,'hash','applied','{"status":"completed"}','now')`).bind(`classify-${f.id}-rev-4-input-3-gen-1`, f.id).run();
  view = await (await call(f.path)).json() as View;
  expect(view.actions.retry_classification.allowed).toBe(true);
  expect((await call(f.path, { ...f.body, fence: view.fence })).status).toBe(200);
});

it("rolls back the source, queue and receipt together on a late database error, then accepts the unchanged intent", async () => {
  const f = await setup(false), before = await counts(), keep = await retained(f.id), queued = await job(f.id);
  const body = { ...f.body, action: "save_primary", text: "New primary" };
  await env.DB.prepare(`CREATE TRIGGER processing_fail BEFORE UPDATE ON classification_operations WHEN NEW.status='app_processing'
    BEGIN SELECT RAISE(ABORT,'processing receipt fixture failure'); END`).run();
  await expect(call(f.path, body)).rejects.toThrow("processing receipt fixture failure");
  expect(await counts()).toEqual(before); expect(await retained(f.id)).toEqual(keep); expect(await job(f.id)).toEqual(queued);
  await env.DB.prepare("DROP TRIGGER processing_fail").run();
  expect((await call(f.path, body)).status).toBe(200);
});

it.each(["source", "primary", "legacy", "drop", "classification_unknown"])("refuses %s without a new receipt or inference", async kind => {
  const f = await setup(); let expected = "source_snapshot_unavailable";
  if (kind === "source") await env.DB.prepare("UPDATE evidence_snapshots SET payload='{}' WHERE link_id=?").bind(f.id).run();
  if (kind === "primary") { expected = "primary_source_required"; await env.DB.prepare("UPDATE links SET original_text=NULL WHERE id=?").bind(f.id).run(); }
  if (kind === "legacy") { expected = "v2_required"; await env.DB.prepare("UPDATE classification_target_state SET generation=0 WHERE id=1").run(); }
  if (kind === "drop") { expected = "excluded_from_processing"; await env.DB.prepare("UPDATE links SET curation_status='drop' WHERE id=?").bind(f.id).run(); }
  if (kind === "classification_unknown") { expected = "provider_result_unknown"; await env.DB.prepare("INSERT INTO classification_reservations(reservation_key,link_id,payload_hash,identity,created_at) VALUES ('unknown',?,'hash','{}','now')").bind(f.id).run(); }
  const view = await (await call(f.path)).json() as View;
  expect(view.actions.retry_classification).toMatchObject({ allowed: false, blocked_reason: expected });
  const before = await counts(); expect((await call(f.path, { ...f.body, fence: view.fence })).status).toBe(409);
  expect(await counts()).toEqual(before);
});

it("requires the exact App allowlist, authentication, capability and bounded closed payload", async () => {
  const f = await setup();
  expect((await call(f.path, undefined, "GET", "wrong")).status).toBe(401);
  expect((await call(`v2/links/${f.id}/processing`)).status).toBe(401);
  expect((await call(f.path, undefined, "GET", "app", env.DB, "0")).status).toBe(409);
  expect((await call(`${f.path}?spec=arbitrary`)).status).toBe(400);
  expect((await call(f.path, { ...f.body, requested_model: "not-allowed" })).status).toBe(400);
  expect((await call(f.path, { ...f.body, text: "unexpected on retry" })).status).toBe(400);
  expect((await call(f.path, { ...f.body, action: "policy_replay" })).status).toBe(400);
  expect((await call(f.path, { ...f.body, action: "save_primary", text: "界".repeat(33334) })).status).toBe(400);
  expect((await call(f.path, { ...f.body, action: "save_primary", text: "\ud800" })).status).toBe(400);
  expect((await call(f.path, undefined, "DELETE")).status).toBe(405);
  expect((await call("bookmarks/999999/processing")).status).toBe(404);
});
