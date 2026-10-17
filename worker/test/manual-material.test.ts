import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { canonicalJSON } from "../src/domain";

const capability = "X-Cairn-App-Manual-Material";
const caps = { protocol: "v2", spec_ids: ["material-spec"], taxonomy_versions: ["2026-09-20.1"],
  policy_versions: ["material-policy"], models: ["material-fixture"] };
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(() => vi.restoreAllMocks());
async function call(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", token = "app", db = env.DB, ack = "1") {
  return worker.fetch(new Request(`https://test.example/api/${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [capability]: ack,
      "X-Cairn-Classification-Budget": "1", "X-Cairn-Classification-Gate": "1" },
    body: body === undefined ? undefined : JSON.stringify(body) }),
    { DB: db, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}
async function setup(truncated = false) {
  const { id } = await (await call("links", { url: "https://example.com/material" })).json() as { id: number };
  const external = "https://external.example/article", image = `enrichment/${id}/${"a".repeat(64)}.png`;
  await env.DB.prepare(`UPDATE links SET original_text='Primary source',related_links=?,images=?,enrichment_status='completed',
    ai_title='Keep title',summary='Keep summary',translated_text='Keep translation' WHERE id=?`)
    .bind(JSON.stringify([external]), JSON.stringify([image]), id).run();
  expect((await call(`v2/links/${id}/evidence`, { snapshot: { blocks: [
    { id: "primary", role: "primary", text: "Primary source", acquired: "browser" },
    { id: "quote", role: "quoted", text: "Quoted author" }], fetched_at: "2026-10-17", retrieval: "browser", truncation: { truncated } }
  }, "POST", "internal")).status).toBe(200);
  const spec = await (await call("v2/question-specs", { spec_id: "material-spec", spec_version: 1, questions: {} }, "POST", "internal")).json() as { spec_hash: string };
  expect((await call("enrichment/classifications/target", { spec_id: "material-spec", spec_hash: spec.spec_hash,
    taxonomy_version: "2026-09-20.1", policy_version: "material-policy", requested_model: "material-fixture", protocol: "v2" }, "POST", "internal")).status).toBe(200);
  await env.DB.prepare("UPDATE classification_jobs SET status='completed',target_generation=1 WHERE link_id=?").bind(id).run();
  await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,source,confirmed,revision,operation_key,created_at)
    VALUES (?,'topic','manual-topic','reject','human',1,0,'manual-override','2026-10-17')`).bind(id).run();
  await env.DB.prepare(`INSERT INTO curation_events(link_id,kind,payload,revision,operation_key,created_at)
    VALUES (?,'why','{"why":"human explanation"}',0,'manual-event','2026-10-17')`).bind(id).run();
  const path = `bookmarks/${id}/manual-material`;
  const view = await (await call(path)).json() as { source: { content_revision: number; evidence_snapshot_id: number; source_hash: string; target_generation: number } };
  const body = { version: 1, operation_key: "manual-fixture", expected_content_revision: view.source.content_revision,
    evidence_snapshot_id: view.source.evidence_snapshot_id, source_hash: view.source.source_hash, target_generation: view.source.target_generation,
    kind: "external_link", source_ref: external, text: "Human supplied fragment 🙂\nKeep exact whitespace. " };
  return { id, path, body, external, image };
}
async function stable(id: number) {
  return env.DB.prepare(`SELECT original_text,ai_title,summary,translated_text,images,related_links,enrichment_status,
    enrichment_paid_uncertain,curation_status,personal_revision,classification,why FROM links WHERE id=?`).bind(id).first();
}
async function counts() {
  return env.DB.prepare(`SELECT (SELECT COUNT(*) FROM evidence_snapshots) AS snapshots,
    (SELECT COUNT(*) FROM evidence_requests) AS requests,(SELECT COUNT(*) FROM classification_provider_attempts) AS attempts,
    (SELECT COUNT(*) FROM enrichment_provider_attempts) AS reading_attempts,(SELECT COUNT(*) FROM budget_ledger) AS budget,
    (SELECT COUNT(*) FROM curation_events) AS events,(SELECT COUNT(*) FROM curation_overrides) AS overrides`).first();
}
function beforeBatch(action: () => Promise<void>) {
  let done = false;
  return new Proxy(env.DB, { get(target, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => { if (!done) { done = true; await action(); } return target.batch(statements); };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
}

it("only reports observed gaps without fetching, writing, or offering semantic uncertainty as a gap", async () => {
  const f = await setup(true), before = await counts();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("manual route must never fetch"));
  for (const [path, token] of [[f.path, "app"], [`v2/links/${f.id}/manual-material`, "internal"]]) {
    const response = await call(path, undefined, "GET", token);
    expect(response.status).toBe(200); expect(response.headers.get(capability)).toBe("1");
    expect(response.headers.get("Cache-Control")?.split(/,\s*/)).toContain("no-store");
    expect(await response.json()).toMatchObject({ version: 1, id: f.id, can_submit: true, blocked_reason: null, max_text_bytes: 100000,
      options: [{ kind: "external_link", source_ref: f.external, role: "external_article" },
        { kind: "image_text", source_ref: f.image, role: "legacy_unknown" },
        { kind: "truncation", source_ref: "primary", role: "author_continuation" }, { kind: "truncation", source_ref: "quote", role: "quoted" }] });
  }
  expect(await counts()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  await env.DB.prepare("UPDATE links SET related_links='[]',images='[]' WHERE id=?").bind(f.id).run();
  await env.DB.prepare(`UPDATE evidence_snapshots SET payload=json_set(payload,'$.truncation.truncated',json('false')) WHERE link_id=?`).bind(f.id).run();
  // Corrupted identity is not converted into an available material action.
  expect(await (await call(f.path)).json()).toMatchObject({ can_submit: false, blocked_reason: "source_snapshot_unavailable" });
});

it.each(["external_link", "image_text", "truncation", "primary-continuation"])("appends a %s fragment atomically and queues the exact claimable source once", async kind => {
  const f = await setup(true), before = await stable(f.id), beforeCounts = await counts();
  const oldSource = await env.DB.prepare("SELECT payload FROM evidence_snapshots WHERE id=?").bind(f.body.evidence_snapshot_id).first<string>("payload");
  const jobRevision = await env.DB.prepare("SELECT revision FROM classification_jobs WHERE link_id=?").bind(f.id).first<number>("revision");
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no external/model request"));
  const body = { ...f.body, kind: kind === "primary-continuation" ? "truncation" : kind,
    source_ref: kind === "image_text" ? f.image : kind === "truncation" ? "quote" : kind === "primary-continuation" ? "primary" : f.external };
  const saved = await call(f.path, body); expect(saved.status).toBe(200);
  const receipt = await saved.json() as { request_id: string; content_revision: number; source_hash: string; evidence_snapshot_id: number };
  expect(receipt).toMatchObject({ version: 1, status: "material_saved", changed: true, classification_queued: true, model_calls: 0, replayed: false });
  expect(await stable(f.id)).toEqual(before);
  expect(await counts()).toEqual({ ...beforeCounts, snapshots: 2, requests: 1 }); expect(fetch).not.toHaveBeenCalled();
  const current = await env.DB.prepare("SELECT payload FROM evidence_snapshots WHERE id=?").bind(receipt.evidence_snapshot_id).first<string>("payload");
  const archived = JSON.parse(current!);
  expect(archived.blocks.slice(0, 2)).toEqual(JSON.parse(oldSource!).blocks);
  expect(archived.truncation).toEqual(JSON.parse(oldSource!).truncation);
  expect(archived.blocks[2]).toMatchObject({ acquired: "manual", text: f.body.text,
    role: kind === "image_text" ? "legacy_unknown" : kind === "truncation" ? "quoted" : kind === "primary-continuation" ? "author_continuation" : "external_article" });
  expect(JSON.parse(archived.blocks[2].relation)).toMatchObject({ partial: true, scope: "manual_material", model_calls: 0, why_needed: body.kind });
  const bytes = new TextEncoder().encode(canonicalJSON(archived));
  expect([...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("")).toBe(receipt.source_hash);
  expect(await env.DB.prepare("SELECT revision FROM classification_jobs WHERE link_id=?").bind(f.id).first("revision")).toBe(jobRevision! + 1);
  const claimed = await call("enrichment/classifications/claim", { ...caps, expected_generation: 1 }, "POST", "internal");
  expect(claimed.status).toBe(200);
  expect(await claimed.json()).toMatchObject({ id: f.id, content_revision: receipt.content_revision,
    evidence_snapshot_id: receipt.evidence_snapshot_id, evidence_hash: receipt.source_hash });
  // Receipt lookup precedes live lease and stale-source checks after response loss.
  expect(await (await call(f.path, body)).json()).toEqual({ ...receipt, replayed: true });
  expect(await (await call("v2/evidence-requests/recoverable", undefined, "GET", "internal")).json()).toEqual({ requests: [] });
  expect((await call(`v2/evidence-requests/${receipt.request_id}/claim`, { owner_token: "must-not-execute" }, "POST", "internal")).status).toBe(409);
});

it("deduplicates concurrent same-key retries and repeat material under a new key without another source or queued attempt", async () => {
  const f = await setup();
  const replies = await Promise.all([call(f.path, f.body), call(f.path, f.body)]);
  expect(replies.map(r => r.status)).toEqual([200, 200]);
  const a = await replies[0].json() as Record<string, unknown>, b = await replies[1].json() as typeof a;
  expect(a.request_id).toBe(b.request_id); expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  const prior = await counts(), revision = await env.DB.prepare("SELECT revision FROM classification_jobs WHERE link_id=?").bind(f.id).first("revision");
  const duplicate = await call(f.path, { ...f.body, operation_key: "same-fragment-new-key", expected_content_revision: a.content_revision,
    evidence_snapshot_id: a.evidence_snapshot_id, source_hash: a.source_hash });
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toMatchObject({ changed: false, classification_queued: false, model_calls: 0 });
  expect(await counts()).toEqual({ ...prior, requests: 2 });
  expect(await env.DB.prepare("SELECT revision FROM classification_jobs WHERE link_id=?").bind(f.id).first("revision")).toBe(revision);
  expect((await call(f.path, { ...f.body, text: "changed under existing key" })).status).toBe(409);
});

it.each(["source", "target", "reading-lease", "classification-lease", "unknown", "references", "images"])("rejects a %s change at the actual write boundary without partial writes", async change => {
  const f = await setup(); const before = await counts();
  const db = beforeBatch(async () => {
    if (change === "source") await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=?").bind(f.id).run();
    else if (change === "target") await env.DB.prepare("UPDATE classification_target_state SET generation=0 WHERE id=1").run();
    else if (change === "reading-lease") await env.DB.prepare("UPDATE links SET enrichment_status='processing',enrichment_lease_until=NULL WHERE id=?").bind(f.id).run();
    else if (change === "classification-lease") await env.DB.prepare("UPDATE classification_jobs SET status='processing',lease_until=NULL WHERE link_id=?").bind(f.id).run();
    else if (change === "unknown") await env.DB.prepare("UPDATE links SET enrichment_paid_uncertain=1 WHERE id=?").bind(f.id).run();
    else await env.DB.prepare(`UPDATE links SET ${change === "images" ? "images" : "related_links"}='[]' WHERE id=?`).bind(f.id).run();
  });
  expect((await call(f.path, f.body, "POST", "app", db)).status).toBe(409);
  expect(await counts()).toEqual(before);
});

it.each(["reading", "classification", "reservation", "unknown-http", "legacy", "no-primary", "drop"])("truthfully blocks %s before offering or accepting a paid follow-up", async kind => {
  const f = await setup();
  let reason = "processing_busy";
  if (kind === "reading") await env.DB.prepare("UPDATE links SET enrichment_status='processing',enrichment_lease_until=NULL WHERE id=?").bind(f.id).run();
  if (kind === "classification") await env.DB.prepare("UPDATE classification_jobs SET status='processing',lease_until=NULL WHERE link_id=?").bind(f.id).run();
  if (kind === "reservation" || kind === "unknown-http") {
    reason = "provider_result_unknown";
    await env.DB.prepare("INSERT INTO classification_reservations(reservation_key,link_id,payload_hash,identity,created_at) VALUES ('uncertain',?,'hash','{}','now')").bind(f.id).run();
    if (kind === "unknown-http") {
      await env.DB.prepare("INSERT INTO classification_attempt_operations(operation_key,link_id,payload_hash,created_at) VALUES ('uncertain',?,'hash','now')").bind(f.id).run();
      await env.DB.prepare(`INSERT INTO classification_provider_attempts(link_id,operation_key,reservation_key,call_json,created_at)
        VALUES (?,'uncertain','uncertain','{"http_status":451,"usage_missing":true}','now')`).bind(f.id).run();
    }
  }
  if (kind === "legacy") { reason = "v2_required"; await env.DB.prepare("UPDATE classification_target_state SET generation=0 WHERE id=1").run(); }
  if (kind === "no-primary") {
    reason = "primary_source_required";
    await env.DB.prepare("UPDATE links SET original_text='' WHERE id=?").bind(f.id).run();
    expect((await call(`v2/links/${f.id}/evidence`, { snapshot: { blocks: [{ id: "unknown", role: "legacy_unknown", text: "Image text" }],
      fetched_at: "2026-10-17", retrieval: "browser", truncation: { truncated: false } } }, "POST", "internal")).status).toBe(200);
  }
  if (kind === "drop") { reason = "excluded_from_classification"; await env.DB.prepare("UPDATE links SET curation_status='drop' WHERE id=?").bind(f.id).run(); }
  expect(await (await call(f.path)).json()).toMatchObject({ can_submit: false, blocked_reason: reason });
  const before = await counts();
  expect((await call(f.path, f.body)).status).toBe(409); expect(await counts()).toEqual(before);
});

it("does not invent a gap when complete source has no missing references", async () => {
  const f = await setup();
  const snapshot = JSON.parse((await env.DB.prepare("SELECT payload FROM evidence_snapshots WHERE id=?")
    .bind(f.body.evidence_snapshot_id).first<string>("payload"))!);
  await env.DB.prepare("UPDATE links SET related_links='[]',images='[]' WHERE id=?").bind(f.id).run();
  expect((await call(`v2/links/${f.id}/evidence`, { snapshot: { ...snapshot, fetched_at: "2026-10-17" } }, "POST", "internal")).status).toBe(200);
  expect(await (await call(f.path)).json()).toMatchObject({ can_submit: false, blocked_reason: "no_observed_gap", options: [] });
  expect((await call(f.path, f.body)).status).toBe(409);
});

it("rolls back source, queue and receipt together and safely retries the same intent", async () => {
  const f = await setup(), before = await counts(), link = await stable(f.id);
  await env.DB.prepare(`CREATE TRIGGER reject_manual_receipt BEFORE UPDATE ON evidence_requests WHEN NEW.protocol=2 AND NEW.status='completed'
    BEGIN SELECT RAISE(ABORT,'manual receipt fixture failure'); END`).run();
  await expect(call(f.path, f.body)).rejects.toThrow("manual receipt fixture failure");
  expect(await counts()).toEqual(before); expect(await stable(f.id)).toEqual(link);
  await env.DB.prepare("DROP TRIGGER reject_manual_receipt").run();
  expect((await call(f.path, f.body)).status).toBe(200);
});

it("keeps exact authorization, method, body, scope and deletion boundaries", async () => {
  const f = await setup(), before = await counts();
  for (const token of ["", "wrong", "internal"]) expect((await call(f.path, undefined, "GET", token)).status).toBe(401);
  expect((await call(`v2/links/${f.id}/manual-material`, undefined, "GET", "app")).status).toBe(401);
  expect((await call(f.path, f.body, "POST", "app", env.DB, "")).status).toBe(409);
  for (const method of ["PATCH", "DELETE", "HEAD"]) expect((await call(f.path, undefined, method)).status).toBe(405);
  expect((await call(`${f.path}?model=other`)).status).toBe(400);
  for (const patch of [{ text: " " }, { text: "中".repeat(33334) }, { text: "a".repeat(140000) }, { kind: "semantic_uncertainty" },
    { version: 2 }, { expected_content_revision: 0 }, { extra: true }]) expect((await call(f.path, { ...f.body, ...patch })).status).toBe(400);
  for (const patch of [{ source_ref: "https://127.0.0.1/internal" }, { source_ref: `enrichment/999/${"a".repeat(64)}.png`, kind: "image_text" },
    { expected_content_revision: f.body.expected_content_revision + 1 }]) expect((await call(f.path, { ...f.body, ...patch })).status).toBe(409);
  expect(await counts()).toEqual(before);
  expect((await call(f.path, f.body)).status).toBe(200);
  expect((await call(`links/${f.id}`, undefined, "DELETE")).status).toBe(204);
  expect((await call(f.path, f.body)).status).toBe(404);
  expect(await env.DB.prepare("SELECT COUNT(*) FROM evidence_requests").first("COUNT(*)")).toBe(0);
});
