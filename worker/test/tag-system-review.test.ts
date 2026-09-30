import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { semanticSpecHash } from "../src/domain";
import goCompletion from "./fixtures/tag-system-go-completion.json";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

function call(path: string, body?: unknown, method = body ? "POST" : "GET", db = env.DB) {
  return worker.fetch(new Request(`https://test/api/${path}`, {
    method, headers: { Authorization: "Bearer app", "Content-Type": "application/json", "X-Cairn-Tag-System": "1" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), { DB: db, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}
async function link() {
  const response = await call("links", { url: `https://example.com/${crypto.randomUUID()}` });
  return (await response.json() as { id: number }).id;
}
async function custom() {
  const response = await call("custom-tags", { operation_key: crypto.randomUUID(), label: "本周实验" });
  expect(response.status).toBe(200);
  return (await response.json() as { tag: { id: string; tag_ref: string; revision: number } }).tag;
}
async function state(id: number) {
  return (await (await call(`bookmarks/${id}/tags`)).json()) as { revision: number; decision_id: number; content_revision: number; custom_tags: unknown[] };
}
async function action(id: number, actions: unknown[], db = env.DB) {
  const current = await state(id);
  return call(`bookmarks/${id}/tags`, { operation_key: crypto.randomUUID(), expected_revision: current.revision,
    expected_decision_id: current.decision_id, expected_content_revision: current.content_revision, actions }, "POST", db);
}
function beforeFirstBatch(action: () => Promise<void>) {
  let invoked = false;
  return new Proxy(env.DB, { get(target, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      if (!invoked) { invoked = true; await action(); }
      return target.batch(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

it("independent review: archival between attach preflight and transaction cannot revive a custom tag", async () => {
  const id = await link(), tag = await custom();
  const db = beforeFirstBatch(async () => {
    expect((await call(`custom-tags/${tag.id}`, { operation_key: "archive-winner", expected_revision: tag.revision, detach_all: true }, "DELETE")).status).toBe(200);
  });
  expect((await action(id, [{ action: "attach", tag_ref: tag.tag_ref }], db)).status).toBe(409);
  expect((await state(id)).custom_tags).toEqual([]);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM custom_tag_links WHERE tag_id=?").bind(tag.id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM tag_operations WHERE link_id=?").bind(id).first("n")).toBe(0);
});

it("independent review: new association after archive preflight makes scope conflict instead of untracked deletion", async () => {
  const first = await link(), second = await link(), tag = await custom();
  expect((await action(first, [{ action: "attach", tag_ref: tag.tag_ref }])).status).toBe(200);
  const db = beforeFirstBatch(async () => {
    expect((await action(second, [{ action: "attach", tag_ref: tag.tag_ref }])).status).toBe(200);
  });
  expect((await call(`custom-tags/${tag.id}`, { operation_key: "archive-stale", expected_revision: tag.revision, detach_all: true }, "DELETE", db)).status).toBe(409);
  expect((await state(first)).custom_tags).toHaveLength(1);
  expect((await state(second)).custom_tags).toHaveLength(1);
  expect(await env.DB.prepare("SELECT status FROM custom_tags WHERE id=?").bind(tag.id).first("status")).toBe("active");
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM custom_tag_operations WHERE operation_key='archive-stale'").first("n")).toBe(0);
});

it("independent review: confirmation cannot claim a material revision the client never read", async () => {
  const id = await link();
  expect((await action(id, [{ action: "accept", tag_ref: "system/topics/image_creation" }])).status).toBe(200);
  const current = await state(id);
  const body = { operation_key: "confirm-stale", expected_revision: current.revision, expected_decision_id: current.decision_id,
    actions: [{ action: "confirm", tag_ref: "system/topics/image_creation" }] };
  expect((await call(`bookmarks/${id}/tags`, body)).status).toBe(409);
  await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=?").bind(id).run();
  expect((await call(`bookmarks/${id}/tags`, { ...body, expected_content_revision: current.content_revision })).status).toBe(409);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM tag_operations WHERE operation_key='confirm-stale'").first("n")).toBe(0);
});

it("independent review: tag counts apply the same reason and translated-text query as the library", async () => {
  const id = await link();
  await env.DB.prepare("UPDATE links SET translated_text='只在翻译里出现的词',why='这次收藏原因',curation_status='kept' WHERE id=?").bind(id).run();
  expect((await action(id, [{ action: "accept", tag_ref: "system/topics/image_creation" }])).status).toBe(200);
  for (const q of ["只在翻译里出现", "这次收藏原因"]) {
    const params = new URLSearchParams({ q, curation_status: "kept", topics: "image_creation" });
    const response = await call(`tag-counts?${params}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, topics: [{ id: "image_creation", count: 1 }] });
  }
  const excluded = await call("tag-counts?curation_status=inbox&topics=image_creation");
  expect(await excluded.json()).toMatchObject({ total: 0 });
});

function internal(path: string, body?: unknown, method = body ? "POST" : "GET") {
  return worker.fetch(new Request(`https://test/api/${path}`, {
    method, headers: { Authorization: "Bearer internal", "Content-Type": "application/json", "X-Cairn-Tag-System": "1",
      "X-Cairn-Classification-Budget": "1", "X-Cairn-Classification-Gate": "1" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}

async function goQueue() {
  const id = await (await call("links", { url: goCompletion.input.url, note: goCompletion.input.note })).json().then(value => (value as { id: number }).id);
  await env.DB.prepare("UPDATE links SET original_text=?,why='Human reason remains',curation_status='kept' WHERE id=?")
    .bind(goCompletion.input.original_text, id).run();
  expect((await internal(`v2/links/${id}/evidence`, { snapshot: {
    blocks: [{ id: "primary", role: "primary", text: goCompletion.input.original_text }],
    retrieval: "manual", fetched_at: "2026-09-30T00:00:00Z", truncation: { truncated: false }
  } })).status).toBe(200);
  expect((await action(id, [{ action: "accept", tag_ref: "system/topics/video_creation" }])).status).toBe(200);
  const result = structuredClone(goCompletion.result);
  expect((await internal("v2/question-specs", { ...goCompletion.spec, spec_hash: result.spec_hash })).status).toBe(200);
  const target = { spec_id: result.spec_id, spec_hash: result.spec_hash, taxonomy_version: result.classification.taxonomy_version,
    policy_version: result.policy_version, requested_model: result.requested_model, protocol: "v2" };
  expect((await internal("enrichment/classifications/target", target)).status).toBe(200);
  const response = await internal("enrichment/classifications/claim", { protocol: "v2", spec_ids: [target.spec_id],
    taxonomy_versions: [target.taxonomy_version], policy_versions: [target.policy_version], models: [target.requested_model] });
  expect(response.status, await response.clone().text()).toBe(200);
  const job = await response.json() as Record<string, unknown>;
  const personal = await env.DB.prepare("SELECT original_text,note,why,curation_status,personal_revision FROM links WHERE id=?").bind(id).first();
  const overrides = (await env.DB.prepare("SELECT field,term,action,revision,operation_key FROM curation_overrides WHERE link_id=? ORDER BY id").bind(id).all()).results;
  return { id, target, result, job, personal, overrides };
}

it("independent review: actual Go 30-question metadata completes and leaves original text and human facts unchanged", async () => {
  const { id, result, job, personal, overrides } = await goQueue();
  expect(goCompletion.spec.questions).toHaveLength(30);
  expect(result.raw_judgments.metadata_version).toBe(1);
  expect(result.raw_judgments.judgments.resource_kind_skill).toMatchObject({ kind: "noul", dimension: "resource_kinds", term_id: "skill", noul: .96 });
  expect(result.raw_judgments.wire_state).not.toContain(goCompletion.input.note);
  const body = { ...job, operation_key: "actual-go-complete", result };
  const completed = await internal(`enrichment/classifications/${id}/complete`, body);
  expect(completed.status, await completed.clone().text()).toBe(200);
  expect((await internal(`enrichment/classifications/${id}/complete`, body)).status).toBe(200);
  // links.curation is the bounded v1 display projection and follows the new
  // automatic baseline. Durable human facts are the untouched overrides.
  expect(await env.DB.prepare("SELECT original_text,note,why,curation_status,personal_revision FROM links WHERE id=?").bind(id).first()).toEqual(personal);
  expect((await env.DB.prepare("SELECT field,term,action,revision,operation_key FROM curation_overrides WHERE link_id=? ORDER BY id").bind(id).all()).results).toEqual(overrides);
  const run = await env.DB.prepare("SELECT raw_judgments,answers,requested_model,resolved_model FROM classification_runs WHERE link_id=?").bind(id)
    .first<{ raw_judgments: string; answers: string; requested_model: string; resolved_model: string }>();
  expect(JSON.parse(run!.raw_judgments)).toEqual(result.raw_judgments);
  expect(JSON.parse(run!.answers)).toEqual(result.answers);
  expect(run!.requested_model).toBe(result.requested_model);
  expect(run!.resolved_model).toBe(result.model);
  const current = await (await call(`bookmarks/${id}/tags`)).json() as any;
  expect(current.selection.topics).toEqual(["image_creation", "video_creation"]);
  expect(current.selection.resource_kinds).toEqual(["skill"]);
  expect(current.state.fields.topics.values.find((value: { term: string }) => value.term === "video_creation").origin).toBe("human");
  expect(await env.DB.prepare("SELECT resource_kinds FROM link_selections_v2 WHERE link_id=?").bind(id).first("resource_kinds")).toBe('["skill"]');
  const listed = await (await call("links?include=enrichment&resource_kinds=skill")).json() as any;
  expect(listed.items.map((value: { id: number }) => value.id)).toEqual([id]);
  expect(listed.items[0].enrichment.classification.resource_kinds).toEqual(["skill"]);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_runs WHERE link_id=?").bind(id).first("n")).toBe(1);
});

it("independent review: another valid registered spec cannot complete the current target", async () => {
  const { id, result, job, personal, overrides } = await goQueue();
  const alternate = { ...structuredClone(goCompletion.spec), spec_id: "another-registered-spec" };
  const alternateHash = await semanticSpecHash(alternate);
  expect((await internal("v2/question-specs", { ...alternate, spec_hash: alternateHash })).status).toBe(200);
  result.spec_id = alternate.spec_id;
  result.spec_hash = alternateHash;
  result.raw_judgments.spec_id = alternate.spec_id;
  result.raw_judgments.spec_hash = alternateHash;
  const rejected = await internal(`enrichment/classifications/${id}/complete`, { ...job, operation_key: "wrong-result-spec", result });
  expect(rejected.status, await rejected.clone().text()).toBe(409);
  expect(await rejected.json()).toMatchObject({ error: "target_changed" });
  expect(await env.DB.prepare("SELECT original_text,note,why,curation_status,personal_revision FROM links WHERE id=?").bind(id).first()).toEqual(personal);
  expect((await env.DB.prepare("SELECT field,term,action,revision,operation_key FROM curation_overrides WHERE link_id=? ORDER BY id").bind(id).all()).results).toEqual(overrides);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_runs WHERE link_id=?").bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_decisions WHERE link_id=?").bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_operations WHERE link_id=?").bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT status FROM classification_jobs WHERE link_id=?").bind(id).first("status")).toBe("processing");
});

it.each(["projection_mismatch", "retired_topic", "unknown_resource"])("independent review: %s cannot be recorded as a new automatic result", async (invalid) => {
  const { id, result, job, personal, overrides } = await goQueue();
  if (invalid === "projection_mismatch") result.classification.topics = ["video_creation"];
  if (invalid === "retired_topic") {
    result.classification.topics = ["llm"];
    result.automatic.topics = ["llm"];
  }
  if (invalid === "unknown_resource") result.automatic.resource_kinds = ["unregistered_kind"];
  const rejected = await internal(`enrichment/classifications/${id}/complete`, { ...job, operation_key: invalid, result });
  expect(rejected.status, await rejected.clone().text()).toBe(400);
  expect(await rejected.json()).toMatchObject({ error: "invalid_classification" });
  expect(await env.DB.prepare("SELECT original_text,note,why,curation_status,personal_revision FROM links WHERE id=?").bind(id).first()).toEqual(personal);
  expect((await env.DB.prepare("SELECT field,term,action,revision,operation_key FROM curation_overrides WHERE link_id=? ORDER BY id").bind(id).all()).results).toEqual(overrides);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_runs WHERE link_id=?").bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_decisions WHERE link_id=?").bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_operations WHERE link_id=?").bind(id).first("n")).toBe(0);
});
