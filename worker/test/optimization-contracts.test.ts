import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { EMPTY_AUTOMATIC, canonicalJSON } from "../src/domain";
import { readBoundedJSON } from "../src/json-body";
import { archiveOldRunPayloads, hydrateRunPayload } from "../src/run-archive";
import { validRunProvenance } from "../src/run-provenance";
import go from "./fixtures/tag-system-go-completion.json";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const settings = (DB = env.DB, bucket = env.ENRICHMENT_IMAGES) => ({ DB, ENRICHMENT_IMAGES: bucket, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
const modern = { "X-Cairn-Tag-System": "1", "X-Cairn-Content-Functions": "1" };
function call(path: string, body?: unknown, headers: Record<string, string> = modern, DB = env.DB, token = "app") {
  return worker.fetch(new Request(`https://test/api/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), settings(DB));
}
async function seed(id = 1) {
  await env.DB.prepare("INSERT INTO links(id,url,note,created_at) VALUES(?,?,'saved note','2026-01-01T00:00:00.000Z')").bind(id, `https://example.com/${id}`).run();
  return id;
}
async function automatic(id: number, topics = ["ai_coding"], resources = ["skill"], functions = ["method"]) {
  const run = await env.DB.prepare(`INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,target_generation,
    requested_model,policy_version,policy,answers,operation_key,created_at,payload_hash)
    VALUES(?,1,'s','h',0,'m','p','{}','{}',?,'2026-01-01T00:00:00.000Z',?) RETURNING id`)
    .bind(id, crypto.randomUUID(), "a".repeat(64)).first<number>("id");
  const view = { ...EMPTY_AUTOMATIC, topics, resource_kinds: resources, content_functions: functions };
  await env.DB.prepare(`INSERT INTO classification_decisions(link_id,run_id,content_revision,policy_version,policy,automatic,operation_key,created_at)
    VALUES(?,?,1,'p','{}',?,?,'2026-01-01')`).bind(id, run, JSON.stringify(view), crypto.randomUUID()).run();
  return run!;
}
async function state(id: number) { return (await (await call(`bookmarks/${id}/tags`)).json()) as any; }
async function act(id: number, actions: unknown[], key = crypto.randomUUID()) {
  const s = await state(id);
  return call(`bookmarks/${id}/tags`, { operation_key: key, expected_revision: s.revision, expected_decision_id: s.decision_id,
    expected_content_revision: s.content_revision, actions });
}

it("stops chunked oversized JSON without reading or retaining the remaining stream", async () => {
  let canceled = false, pulls = 0;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); }, cancel() { canceled = true; } });
  const request = new Request("https://test", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  await expect(readBoundedJSON(request, 2048)).rejects.toMatchObject({ code: "request_too_large" });
  expect(canceled).toBe(true); expect(pulls).toBeLessThanOrEqual(4);
  await expect(readBoundedJSON(new Request("https://test", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }))).rejects.toMatchObject({ code: "invalid_content_type" });
});

it("returns bounded matching search text without transferring complete bodies or changing legacy shapes", async () => {
  await seed(); const text = "before ".repeat(1000) + "distinctNeedle target paragraph " + "after ".repeat(1000);
  await env.DB.prepare("UPDATE links SET original_text=?,translated_text=?,summary='short summary' WHERE id=1").bind(text, text).run();
  const response = await call("links?include=enrichment&q=distinctNeedle", undefined, { ...modern, "X-Cairn-Search-Summary": "1" });
  expect(response.status).toBe(200); expect(response.headers.get("X-Cairn-Search-Summary")).toBe("1");
  const page = await response.json() as any;
  expect(page.items[0].search_excerpt).toContain("distinctNeedle"); expect(page.items[0].search_excerpt.length).toBeLessThanOrEqual(240);
  expect(page.items[0].enrichment).not.toHaveProperty("original_text"); expect(page.items[0].enrichment).not.toHaveProperty("translated_text");
  const old = await (await call("links?include=enrichment&q=distinctNeedle", undefined, {})).json() as any;
  expect(old.items[0]).not.toHaveProperty("search_excerpt");
  const oldInternal = await (await call("enrichment/jobs?q=distinctNeedle", undefined, {}, env.DB, "internal")).json() as any;
  expect(oldInternal.items[0].original_text).toBe(text);
  const internal = await (await call("enrichment/jobs?q=distinctNeedle", undefined, { ...modern, "X-Cairn-Search-Summary": "1" }, env.DB, "internal")).json() as any;
  expect(internal.items[0].search_excerpt).toContain("distinctNeedle"); expect(internal.items[0].original_text).toBeNull();
});

it("pages the genuine FIFO learning queue with tied dates, exact total, and negotiated effective tags", async () => {
  for (let id = 1; id <= 5; id++) { await seed(id); await automatic(id); }
  await env.DB.prepare("UPDATE links SET learned=1 WHERE id=2").run(); await env.DB.prepare("UPDATE links SET curation_status='drop' WHERE id=4").run();
  expect((await call("links/queue", undefined, {})).status).toBe(409);
  const headers = { ...modern, "X-Cairn-Queue": "1" };
  const first = await call("links/queue?include=enrichment&limit=2", undefined, headers);
  expect(first.status).toBe(200); expect(first.headers.get("X-Cairn-Content-Functions")).toBe("1");
  const page = await first.json() as any;
  expect(page.links.map((x: any) => x.id)).toEqual([1, 3]); expect(page.total).toBe(3);
  expect(page.links[0].enrichment.classification).toMatchObject({ topics: ["ai_coding"], resource_kinds: ["skill"], content_functions: ["method"] });
  const next = await (await call(`links/queue?include=enrichment&limit=2&cursor=${page.next_cursor}`, undefined, headers)).json() as any;
  expect(next.links.map((x: any) => x.id)).toEqual([5]); expect(next.total).toBe(3); expect(next.next_cursor).toBeNull();
});

it("exports a single read snapshot and refuses continuation after deletion or edits", async () => {
  for (const id of [1, 2, 3]) { await seed(id); await automatic(id); }
  let deleted = false;
  const DB = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(s, k) {
        if (k === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
        if (k === "first") return async (...args: unknown[]) => {
          const result = await s.first(...args as []);
          if (!deleted && sql.includes("AS rows") && sql.includes("matched AS MATERIALIZED")) { deleted = true; await env.DB.prepare("DELETE FROM links WHERE id=3").run(); }
          return result;
        };
        const v = Reflect.get(s, k); return typeof v === "function" ? v.bind(s) : v;
      } }); return wrap(target.prepare(sql));
    };
    const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v;
  } });
  const headers = { ...modern, "X-Cairn-Tag-Export": "1" };
  const response = await call("tag-export?limit=1", undefined, headers, DB);
  expect(response.status).toBe(200); expect(deleted).toBe(true);
  const first = await response.json() as any; expect(first.links.map((x: any) => x.id)).toEqual([3]); expect(first.total).toBe(3);
  const next = await call(`tag-export?limit=1&cursor=${first.next_cursor}`, undefined, headers);
  expect(next.status).toBe(409); expect(await next.json()).toMatchObject({ error: "snapshot_changed" });
  const current = await (await call("tag-export", undefined, modern)).json() as any;
  expect(current.total).toBe(2); expect(current.links.map((x: any) => x.id)).toEqual([2, 1]);
});

it("rebuilds both OLD and NEW membership identities including a tag changed into an entity", async () => {
  await seed(); await seed(2); await automatic(1); await automatic(2, ["image_creation"], ["software"]);
  await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,source,revision,operation_key,created_at)
    VALUES(1,'topics','video_creation','accept','human',1,'move-fact','t')`).run();
  await env.DB.prepare("UPDATE curation_overrides SET link_id=2 WHERE operation_key='move-fact'").run();
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM effective_tag_memberships WHERE link_id=1 AND term='video_creation'").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM effective_tag_memberships WHERE link_id=2 AND term='video_creation'").first("n")).toBe(1);
  await env.DB.prepare("UPDATE curation_overrides SET field='entities' WHERE operation_key='move-fact'").run();
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM effective_tag_memberships WHERE link_id=2 AND term='video_creation'").first("n")).toBe(0);
});

it("reports observed correction samples, confirmations and explicit resource confusion without counting undo as training", async () => {
  await seed(); await automatic(1);
  expect((await act(1, [{ action: "confirm", tag_ref: "system/topics/ai_coding" }])).status).toBe(200);
  expect((await act(1, [{ action: "replace", from_tag_ref: "system/resource_kinds/skill", to_tag_ref: "system/resource_kinds/prompt" }], "replace-resource")).status).toBe(200);
  const report = await (await call("v2/tags/quality", undefined, modern, env.DB, "internal")).json() as any;
  expect(report.terms.find((x: any) => x.tag_ref === "system/resource_kinds/skill")).toMatchObject({ observed_automatic: 2, rejected_automatic: 1, rejection_rate: .5 });
  expect(report.terms.find((x: any) => x.tag_ref === "system/topics/ai_coding")).toMatchObject({ confirmations: 1, additions: 0 });
  expect(report.confusion_pairs).toContainEqual({ dimension: "resource_kinds", from_tag_ref: "system/resource_kinds/skill", to_tag_ref: "system/resource_kinds/prompt", count: 1 });
  expect((await act(1, [{ action: "undo", operation_id: "replace-resource" }])).status).toBe(200);
  const updated = await (await call("v2/tags/quality", undefined, modern, env.DB, "internal")).json() as any;
  expect(updated.confusion_pairs).toEqual([]);
});

it("counts one rejected exposure when a batch clears and rejects the same automatic term", async () => {
  await seed(); await automatic(1);
  expect((await act(1, [{ action: "set_empty", dimension: "resource_kinds" }, { action: "reject", tag_ref: "system/resource_kinds/skill" }])).status).toBe(200);
  const report = await (await call("v2/tags/quality", undefined, modern, env.DB, "internal")).json() as any;
  expect(report.terms.find((x: any) => x.tag_ref === "system/resource_kinds/skill")).toMatchObject({ observed_automatic: 1, rejected_automatic: 1, rejection_rate: 1 });
});

it("archives referenced old run payloads, preserves current runs and restores exact legacy and paged history", async () => {
  await seed(); const old = await automatic(1), current = await automatic(1, ["image_creation"]);
  const raw = JSON.stringify({ metadata_version: 1, evidence_hash: "e".repeat(64), judgments: { synthetic: { noul: .92 } } });
  await env.DB.prepare("UPDATE classification_runs SET answers='{" + '"synthetic":{"type":"noul","noul":0.92}' + "}',raw_judgments=?,wire_evidence_hash=? WHERE id=?").bind(raw, "e".repeat(64), old).run();
  expect(await archiveOldRunPayloads(settings(), "2026-05-01", "2026-10-01")).toBe(1);
  const row = await env.DB.prepare("SELECT * FROM classification_runs WHERE id=?").bind(old).first<any>();
  expect(row.raw_judgments).toBeNull(); expect(row.answers).toBe("{}"); expect(row.archive_key).toContain(`/history/classification/${old}/`);
  expect((await hydrateRunPayload(settings(), row)).raw_judgments).toBe(raw);
  expect(await env.DB.prepare("SELECT archive_key FROM classification_runs WHERE id=?").bind(current).first("archive_key")).toBeNull();
  const headers = { ...modern, "X-Cairn-Run-History": "1" };
  const summary = await (await call("v2/links/1/runs?view=summary&limit=1", undefined, headers, env.DB, "internal")).json() as any;
  expect(summary.runs[0].id).toBe(current); expect(summary.runs[0]).not.toHaveProperty("raw_judgments"); expect(summary.next_after_id).toBe(current);
  const detail = await (await call(`v2/links/1/runs/${old}`, undefined, headers, env.DB, "internal")).json() as any;
  expect(detail.archived).toBe(true); expect(detail.raw_judgments).toEqual(JSON.parse(raw));
  const legacy = await (await call("v2/links/1/runs", undefined, {}, env.DB, "internal")).json() as any;
  expect(legacy.runs.map((x: any) => x.id)).toEqual([old, current]); expect(legacy.runs[0]).not.toHaveProperty("archived"); expect(legacy.runs[0].raw_judgments).toEqual(JSON.parse(raw));
  await env.ENRICHMENT_IMAGES.put(row.archive_key, "corrupt");
  expect((await call(`v2/links/1/runs/${old}`, undefined, headers, env.DB, "internal")).status).toBe(503);
  await env.ENRICHMENT_IMAGES.delete(row.archive_key);
  await expect(hydrateRunPayload(settings(), row)).rejects.toThrow("run_archive_unavailable");
});

async function goComplete() {
  await seed();
  await env.DB.prepare("UPDATE links SET url=?,original_text=?,why='human reason',curation_status='kept' WHERE id=1")
    .bind(go.input.url, go.input.original_text).run();
  const internal = (path: string, body?: unknown) => call(path, body, { ...modern, "X-Cairn-Classification-Budget": "1", "X-Cairn-Classification-Gate": "1" }, env.DB, "internal");
  expect((await internal("v2/links/1/evidence", { snapshot: { blocks: [{ id: "primary", role: "primary", text: go.input.original_text }],
    retrieval: "manual", fetched_at: "2026-09-30T00:00:00Z", truncation: { truncated: false } } })).status).toBe(200);
  expect((await internal("v2/question-specs", { ...go.spec, spec_hash: go.result.spec_hash })).status).toBe(200);
  const target = { spec_id: go.result.spec_id, spec_hash: go.result.spec_hash, taxonomy_version: go.result.classification.taxonomy_version,
    policy_version: go.result.policy_version, requested_model: go.result.requested_model, protocol: "v2" };
  expect((await internal("enrichment/classifications/target", target)).status).toBe(200);
  const claimed = await internal("enrichment/classifications/claim", { protocol: "v2", spec_ids: [target.spec_id],
    taxonomy_versions: [target.taxonomy_version], policy_versions: [target.policy_version], models: [target.requested_model] });
  const job = await claimed.json() as any; expect(claimed.status).toBe(200);
  expect((await internal("enrichment/classifications/1/complete", { ...job, operation_key: "original-completion", result: go.result })).status).toBe(200);
  const run = await env.DB.prepare("SELECT * FROM classification_runs WHERE link_id=1").first<any>();
  return { internal, target, run };
}
async function digest(value: unknown) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(value)));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

it("replays a new target policy over an old generation without changing source, manual facts or provider budget", async () => {
  const { internal, target, run } = await goComplete();
  expect((await act(1, [{ action: "reject", tag_ref: "system/topics/image_creation" }])).status).toBe(200);
  const before = await env.DB.prepare("SELECT original_text,note,why,personal_revision,content_revision FROM links WHERE id=1").first<any>();
  const overrides = (await env.DB.prepare("SELECT * FROM curation_overrides WHERE link_id=1").all()).results;
  const policy = { ...go.result.policy, version: "jev-policy-reviewed", topic_accept: .75 };
  expect((await internal("enrichment/classifications/target", { ...target, policy_version: policy.version })).status).toBe(200);
  const generation = await env.DB.prepare("SELECT generation FROM classification_target_state WHERE id=1").first<number>("generation");
  const body = { operation_key: "policy-target-replay", run_ids: [run.id], policy_version: policy.version, policy, policy_hash: await digest(policy),
    automatic: go.result.automatic, expected_revision: before.personal_revision, content_revision: before.content_revision,
    spec_id: run.spec_id, spec_hash: run.spec_hash, requested_model: run.requested_model, resolved_model: run.resolved_model, expected_target_generation: generation };
  const response = await internal("v2/links/1/policy-replays", body);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ policy_hash: body.policy_hash, target_generation: generation, replayed: false });
  expect(await env.DB.prepare("SELECT original_text,note,why,personal_revision,content_revision FROM links WHERE id=1").first()).toEqual(before);
  expect((await env.DB.prepare("SELECT * FROM curation_overrides WHERE link_id=1").all()).results).toEqual(overrides);
  expect((await state(1)).selection.topics).not.toContain("image_creation");
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_runs").first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT status,target_generation,policy_version FROM classification_jobs WHERE link_id=1").first()).toMatchObject({ status: "completed", target_generation: generation, policy_version: policy.version });
  const replay = await internal("v2/links/1/policy-replays", { ...body, expected_revision: before.personal_revision + 1 });
  expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ replayed: true });
  expect((await internal("v2/links/1/policy-replays", { ...body, policy_hash: "f".repeat(64) })).status).toBe(400);
  await env.DB.prepare("UPDATE classification_jobs SET status='processing',lease_token='concurrent',lease_until=? WHERE link_id=1")
    .bind(new Date(Date.now() + 60000).toISOString()).run();
  expect((await internal("v2/links/1/policy-replays", { ...body, operation_key: "busy-replay" })).status).toBe(409);
});

it("policy experiments leave the deployed target queue untouched and lose CAS races atomically", async () => {
  const { internal, run } = await goComplete();
  const s = await state(1), policy = { ...go.result.policy, version: "replay-experiment", topic_accept: .7 };
  const generation = await env.DB.prepare("SELECT generation FROM classification_target_state WHERE id=1").first<number>("generation");
  const body = { operation_key: "policy-experiment", run_ids: [run.id], policy_version: policy.version, policy, policy_hash: await digest(policy),
    automatic: go.result.automatic, expected_revision: s.revision, content_revision: s.content_revision, spec_id: run.spec_id,
    spec_hash: run.spec_hash, requested_model: run.requested_model, resolved_model: run.resolved_model, expected_target_generation: generation };
  const queue = await env.DB.prepare("SELECT * FROM classification_jobs WHERE link_id=1").first();
  expect((await internal("v2/links/1/policy-replays", body)).status).toBe(200);
  expect(await env.DB.prepare("SELECT * FROM classification_jobs WHERE link_id=1").first()).toEqual(queue);
  let raced = false;
  const DB = new Proxy(env.DB, { get(target, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      if (!raced) { raced = true; await env.DB.prepare("UPDATE links SET personal_revision=personal_revision+1 WHERE id=1").run(); }
      return target.batch(statements);
    };
    const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v;
  } });
  const response = await call("v2/links/1/policy-replays", { ...body, operation_key: "policy-race" }, modern, DB, "internal");
  expect(response.status).toBe(409); expect(raced).toBe(true);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_decisions WHERE operation_key='policy-race'").first("n")).toBe(0);
});

it("reads modern detail body identity and effective labels at one SQL boundary", async () => {
  await seed(); await automatic(1);
  let changed = false;
  const DB = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(s, k) {
        if (k === "bind") return (...values: unknown[]) => wrap(s.bind(...values));
        if (k === "first") return async (...args: unknown[]) => {
          const result = await s.first(...args as []);
          if (!changed && sql.includes("AS tag_topics") && sql.includes("cache_decision_id")) { changed = true; await automatic(1, ["image_creation"], ["prompt"]); }
          return result;
        };
        const v = Reflect.get(s, k); return typeof v === "function" ? v.bind(s) : v;
      } }); return wrap(target.prepare(sql));
    };
    const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v;
  } });
  const response = await call("enrichment/jobs/1?include_cache_identity=1", undefined, modern, DB, "internal");
  expect(response.status).toBe(200); expect(changed).toBe(true);
  const old = await response.json() as any;
  expect(old.classification).toMatchObject({ topics: ["ai_coding"], resource_kinds: ["skill"] });
  expect((await state(1)).selection).toMatchObject({ topics: ["image_creation"], resource_kinds: ["prompt"] });
});

it("reuses cold archived raw judgments only after verified object restoration", async () => {
  const { run } = await goComplete();
  await env.DB.prepare("DELETE FROM classification_decisions WHERE link_id=1").run();
  await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=1").run();
  await env.DB.prepare("UPDATE classification_runs SET created_at='2026-01-01' WHERE id=?").bind(run.id).run();
  expect(await archiveOldRunPayloads(settings(), "2026-05-01", "2026-10-01")).toBe(1);
  const raw = structuredClone(go.result.raw_judgments) as any;
  raw.calls = []; raw.reused = Object.keys(raw.judgments); raw.reused_from = Object.fromEntries(raw.reused.map((id: string) => [id, run.id]));
  raw.usage = { input_tokens: 0, output_tokens: 0 }; raw.usage_missing = false;
  const expected = { specId: go.result.spec_id, specHash: go.result.spec_hash, requestedModel: go.result.requested_model,
    resolvedModel: go.result.model, coverage: "complete", answers: go.result.answers, usage: raw.usage };
  expect(await validRunProvenance(settings(), 1, raw, expected)).toBe(true);
  const stored = await env.DB.prepare("SELECT archive_key,archive_bytes FROM classification_runs WHERE id=?").bind(run.id).first<any>();
  await env.ENRICHMENT_IMAGES.put(stored.archive_key, "x".repeat(stored.archive_bytes));
  expect(await validRunProvenance(settings(), 1, raw, expected)).toBe(false);
});

it("does not orphan a private archive if the bookmark disappears after object put", async () => {
  await seed(); await automatic(1); await automatic(1);
  let key = "";
  const bucket = new Proxy(env.ENRICHMENT_IMAGES, { get(target, property) {
    if (property === "put") return async (path: string, value: string, options: R2PutOptions) => {
      key = path; const result = await target.put(path, value, options); await env.DB.prepare("DELETE FROM links WHERE id=1").run(); return result;
    };
    const v = Reflect.get(target, property); return typeof v === "function" ? v.bind(target) : v;
  } });
  expect(await archiveOldRunPayloads(settings(env.DB, bucket), "2026-05-01", "2026-10-01")).toBe(0);
  expect(key).not.toBe(""); expect(await env.ENRICHMENT_IMAGES.get(key)).toBeNull();
});

it("does not return a cold private run fetched during bookmark deletion", async () => {
  await seed(); const old = await automatic(1); await automatic(1);
  expect(await archiveOldRunPayloads(settings(), "2026-05-01", "2026-10-01")).toBe(1);
  const row = await env.DB.prepare("SELECT * FROM classification_runs WHERE id=?").bind(old).first<any>();
  const bucket = new Proxy(env.ENRICHMENT_IMAGES, { get(target, property) {
    if (property === "get") return async (path: string) => { const object = await target.get(path); await env.DB.prepare("DELETE FROM links WHERE id=1").run(); return object; };
    const v = Reflect.get(target, property); return typeof v === "function" ? v.bind(target) : v;
  } });
  await expect(hydrateRunPayload(settings(env.DB, bucket), row)).rejects.toThrow("run_archive_unavailable");
});

it("persists failed reserved attempts after lease expiry without spending again or changing a queue", async () => {
  await seed();
  const nonce = "a".repeat(64), requestHash = "b".repeat(64), evidenceHash = "c".repeat(64);
  const identity = { operation_key: nonce, link_id: 1, lease_token: "past-lease", revision: 1, input_revision: 1,
    target_generation: 0, spec_id: "s", content_revision: 1, evidence_snapshot_id: 1, evidence_hash: evidenceHash, model: "jev-1.13.0", request_hash: requestHash };
  await env.DB.prepare("INSERT INTO question_specs(spec_id,spec_hash,spec_version,payload,requested_model,created_at) VALUES('s','h',1,?, 'jev-1.13.0','t')")
    .bind(JSON.stringify({ questions: [{ id: "topic_ai_coding" }] })).run();
  await env.DB.prepare("INSERT INTO classification_reservations(reservation_key,link_id,payload_hash,identity,created_at) VALUES(?,1,?,?, 't')")
    .bind(nonce, "d".repeat(64), JSON.stringify(identity)).run();
  const { operation_key: unused, model: ignored, request_hash: other, ...common } = identity;
  const body = { ...common, operation_key: "attempt-failed", calls: [{ reservation_key: nonce, request_hash: requestHash,
    state_hash: "e".repeat(64), question_ids: ["topic_ai_coding"], requested_model: "jev-1.13.0", http_status: 429,
    latency_ms: 50, usage_missing: true, usage: null, error_class: "rate_limit" }] };
  const headers = { "X-Cairn-Classification-Attempts": "1" };
  const first = await call("v2/classification-attempts", body, headers, env.DB, "internal");
  expect(first.status, await first.clone().text()).toBe(200); expect(await first.json()).toMatchObject({ stored: true, replayed: false, attempt_ids: [1] });
  expect(await (await call("v2/classification-attempts", body, headers, env.DB, "internal")).json()).toMatchObject({ replayed: true, attempt_ids: [1] });
  expect((await call("v2/classification-attempts", { ...body, lease_token: "different" }, headers, env.DB, "internal")).status).toBe(409);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_jobs").first("n")).toBe(0);
  await env.DB.prepare("DELETE FROM links WHERE id=1").run();
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_provider_attempts").first("n")).toBe(0);
});
