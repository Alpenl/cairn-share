import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { pruneLiveHistory } from "../src/history-retention";
import { compactOverrides, effectiveView, EMPTY_AUTOMATIC, type Override } from "../src/domain";
import vectors from "./fixtures/override-vectors.json";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const fixtureEnv = () => ({ DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
const call = (path: string, body?: unknown, method = body ? "POST" : "GET", aware = true) => worker.fetch(new Request(`https://test/api/${path}`, {
  method, headers: { Authorization: "Bearer app", "Content-Type": "application/json", ...(aware ? { "X-Cairn-Tag-System": "1" } : {}) },
  body: body ? JSON.stringify(body) : undefined
}), fixtureEnv());
async function seed() {
  const response = await call("links", { url: `https://x.com/u/status/${crypto.randomUUID()}` });
  const { id } = await response.json() as { id: number };
  await auto(id, ["image_creation", "ai_coding"], ["skill"]);
  return id;
}
async function auto(id: number, topics: string[], resources: string[]) {
  const run = await env.DB.prepare(`INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,target_generation,requested_model,policy_version,answers,operation_key,created_at)
    VALUES(?,1,'s','h',1,'m','p','{}',?,'2026-09-30')`).bind(id, crypto.randomUUID()).run();
  await env.DB.prepare(`INSERT INTO classification_decisions(link_id,run_id,content_revision,policy_version,policy,automatic,operation_key,created_at)
    VALUES(?,?,1,'p','{}',?,?,'2026-09-30')`).bind(id, run.meta.last_row_id, JSON.stringify({ ...EMPTY_AUTOMATIC, topics, resource_kinds: resources }), crypto.randomUUID()).run();
}
const get = async (id: number) => (await call(`bookmarks/${id}/tags`)).json() as Promise<any>;
async function act(id: number, actions: unknown[], key = crypto.randomUUID()) {
  const state = await get(id);
  return call(`bookmarks/${id}/tags`, { operation_key: key, expected_revision: state.revision,
    expected_decision_id: state.decision_id, expected_content_revision: state.content_revision, actions });
}

it("publishes 12 independent topics and 6 resources only to negotiated readers", async () => {
  const old = await (await call("v2-taxonomy", undefined, "GET", false)).json() as any;
  expect(old.version).toBe("2026-09-20.1"); expect(old).not.toHaveProperty("resource_kinds");
  const current = await (await call("v2-taxonomy")).json() as any;
  expect(current.version).toBe("2026-09-30.1");
  expect(current.topics.filter((t: any) => t.active && !t.deprecated)).toHaveLength(12);
  expect(current.resource_kinds).toHaveLength(6);
  expect(current.topics.find((t: any) => t.id === "llm").deprecated).toBe(true);
});

it("rejects one automatic label without pinning its neighbours or future new labels", async () => {
  const id = await seed();
  expect((await act(id, [{ action: "reject", tag_ref: "system/topics/ai_coding" }])).status).toBe(200);
  await auto(id, ["ai_coding", "video_creation"], ["prompt"]);
  const next = await get(id);
  expect(next.selection.topics).toEqual(["video_creation"]);
  expect(next.selection.resource_kinds).toEqual(["prompt"]);
  expect(next.state.fields.topics.values[0].origin).toBe("automatic");
  expect((await env.DB.prepare(`SELECT action,term FROM curation_overrides WHERE link_id=?`).bind(id).all()).results)
    .toEqual([{ action: "reject", term: "ai_coding" }]);
});

it("distinguishes adoption from confirmation and records explicit no-visible-change confirmation", async () => {
  const id = await seed();
  await act(id, [{ action: "accept", tag_ref: "system/topics/video_creation" }]);
  await act(id, [{ action: "confirm", tag_ref: "system/resource_kinds/skill" }]);
  const current = await get(id);
  expect(current.state.fields.topics.values.find((v: any) => v.term === "video_creation")).toMatchObject({ human_action: "accept", confirmed: false });
  expect(current.state.fields.resource_kinds.values[0]).toMatchObject({ human_action: "confirm", confirmed: true });
  expect(current.state.fields.topics.values.find((v: any) => v.term === "image_creation").origin).toBe("automatic");
});

it("replaces atomically, persists an exact receipt and rejects id reuse with changed intent", async () => {
  const id = await seed(), state = await get(id), operation_key = crypto.randomUUID();
  const body = { operation_key, expected_revision: state.revision, actions: [{ action: "replace", from_tag_ref: "system/topics/ai_coding", to_tag_ref: "system/topics/video_creation" }] };
  await env.DB.prepare(`CREATE TRIGGER fail_tag_projection BEFORE INSERT ON current_projections BEGIN SELECT RAISE(ABORT,'fail replace'); END`).run();
  await expect(call(`bookmarks/${id}/tags`, body)).rejects.toThrow("fail replace");
  expect(await env.DB.prepare(`SELECT COUNT(*) n FROM curation_overrides WHERE link_id=?`).bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare(`SELECT COUNT(*) n FROM tag_operations WHERE link_id=?`).bind(id).first("n")).toBe(0);
  await env.DB.prepare("DROP TRIGGER fail_tag_projection").run();
  expect((await call(`bookmarks/${id}/tags`, body)).status).toBe(200);
  expect((await call(`bookmarks/${id}/tags`, body)).status).toBe(200);
  expect((await call(`bookmarks/${id}/tags`, { ...body, actions: [{ action: "reject", tag_ref: "system/topics/image_creation" }] })).status).toBe(409);
  expect((await get(id)).selection.topics).toEqual(["image_creation", "video_creation"]);
  expect(await env.DB.prepare(`SELECT COUNT(*) n FROM tag_operations WHERE link_id=?`).bind(id).first("n")).toBe(1);
});

it("undo restores prior manual state and follows changed automatic results", async () => {
  const id = await seed(), key = crypto.randomUUID();
  await act(id, [{ action: "reject", tag_ref: "system/topics/image_creation" }], key);
  await auto(id, ["video_creation"], ["skill"]);
  const undone = await act(id, [{ action: "undo", operation_id: key }]);
  expect(undone.status).toBe(200);
  expect((await get(id)).selection.topics).toEqual(["video_creation"]);
  expect((await get(id)).state.fields.topics.values[0].origin).toBe("automatic");
  const undoKey = (await undone.json() as any).operation_id;
  expect((await act(id, [{ action: "undo", operation_id: undoKey }])).status).toBe(409);
});

it("supports optional custom identities, collisions, idempotent reuse and safe detach/archive", async () => {
  const id = await seed();
  expect((await call("custom-tags", { label: "图像生成", operation_key: "collision" })).status).toBe(409);
  const create = await (await call("custom-tags", { label: "我的图片项目", operation_key: "create" })).json() as any;
  const duplicate = await (await call("custom-tags", { label: " 我的图片项目 ", operation_key: "reuse" })).json() as any;
  expect(duplicate.tag.id).toBe(create.tag.id);
  expect((await call("custom-tags", { label: "不同名称", operation_key: "reuse" })).status).toBe(409);
  await act(id, [{ action: "attach", tag_ref: create.tag.tag_ref }]);
  expect((await get(id)).custom_tags).toHaveLength(1);
  expect((await call(`custom-tags/${create.tag.id}`, { operation_key: "delete", expected_revision: 1 }, "DELETE")).status).toBe(409);
  expect((await call(`custom-tags/${create.tag.id}`, { operation_key: "archive", expected_revision: 1, detach_all: true }, "DELETE")).status).toBe(200);
  expect((await get(id)).custom_tags).toEqual([]);
  expect((await act(id, [{ action: "attach", tag_ref: create.tag.tag_ref }])).status).toBe(400);
});

it("filters effective resources and customs, counts the complete set and exports all values", async () => {
  const first = await seed(), second = await seed();
  await auto(second, ["video_creation"], ["software"]);
  const custom = await (await call("custom-tags", { label: "本周", operation_key: "week" })).json() as any;
  await act(first, [{ action: "attach", tag_ref: custom.tag.tag_ref }]);
  const listed = await (await call(`links?include=enrichment&resource_kinds=skill&custom_tags=${custom.tag.id}`)).json() as any;
  expect(listed.items.map((r: any) => r.id)).toEqual([first]);
  expect(listed.items[0].enrichment.classification.resource_kinds).toEqual(["skill"]);
  expect(listed.items[0].custom_tags[0].id).toBe(custom.tag.id);
  const counts = await (await call("tag-counts?resource_kinds=skill")).json() as any;
  expect(counts.total).toBe(1); expect(counts.resource_kinds).toEqual([{ id: "skill", count: 1 }]);
  const exported = await (await call("tag-export?resource_kinds=skill")).json() as any;
  expect(exported.links[0].topics).toHaveLength(2);
  expect((await call("links?include=enrichment&resource_kinds=skill", undefined, "GET", false)).status).toBe(409);
});

it("keeps lightweight override history beyond diagnostics retention and cascades on bookmark deletion", async () => {
  const id = await seed();
  await act(id, [{ action: "reject", tag_ref: "system/topics/ai_coding" }]);
  await env.DB.prepare("UPDATE tag_change_facts SET created_at='2020-01-01'").run();
  await pruneLiveHistory(fixtureEnv(), Date.parse("2026-09-30"));
  expect((await (await call(`bookmarks/${id}/tag-history`)).json() as any).events).toHaveLength(1);
  await call(`links/${id}`, undefined, "DELETE");
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM tag_change_facts WHERE link_id=?").bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM tag_operations WHERE link_id=?").bind(id).first("n")).toBe(0);
});

it("compacts manual state without changing multi/single barriers and reset semantics", () => {
  for (const vector of vectors.vectors) {
    const original = vector.overrides as Override[], compact = compactOverrides(original);
    const expected = effectiveView(vector.automatic, original), actual = effectiveView(vector.automatic, compact);
    expect({ ...actual, revision: 0 }).toEqual({ ...expected, revision: 0 });
  }
});

it("undoing a later edit preserves an earlier explicit confirmation", async () => {
  const id = await seed();
  await act(id, [{ action: "confirm", tag_ref: "system/resource_kinds/skill" }]);
  const key = crypto.randomUUID();
  await act(id, [{ action: "reject", tag_ref: "system/resource_kinds/skill" }], key);
  await act(id, [{ action: "undo", operation_id: key }]);
  expect((await get(id)).state.fields.resource_kinds.values[0]).toMatchObject({ human_action: "confirm", confirmed: true });
});

it("completes the actual new vocabulary queue and persists independent resources", async () => {
  const internal = (path: string, body: unknown) => worker.fetch(new Request(`https://test/api/${path}`, {
    method: "POST", headers: { Authorization: "Bearer internal", "Content-Type": "application/json", "X-Cairn-Tag-System": "1", "X-Cairn-Classification-Budget": "1" },
    body: JSON.stringify(body)
  }), fixtureEnv());
  const { id } = await (await call("links", { url: "https://x.com/synthetic/status/777" })).json() as { id: number };
  await env.DB.prepare("UPDATE links SET original_text='Reusable portrait Skill for image generation' WHERE id=?").bind(id).run();
  expect((await internal(`v2/links/${id}/evidence`, { snapshot: {
    blocks: [{ id: "primary", role: "primary", text: "Reusable portrait Skill for image generation" }],
    retrieval: "manual", fetched_at: "2026-09-30T00:00:00Z", truncation: { truncated: false }
  } })).status).toBe(200);
  expect((await internal("v2/question-specs", { spec_id: "tag-system-test", spec_version: 1, questions: {
    topic_image_creation: { type: "noul", instructions: "Is this image generation?", criteria: "Substantially discusses creating images." },
    resource_kind_skill: { type: "noul", instructions: "Is this an installable Skill?", criteria: "Introduces an installable reusable Agent Skill." }
  } })).status).toBe(200);
  const spec_hash = await env.DB.prepare("SELECT spec_hash FROM question_specs WHERE spec_id='tag-system-test'").first<string>("spec_hash");
  const target = { spec_id: "tag-system-test", spec_hash, taxonomy_version: "2026-09-30.1", policy_version: "jev-policy-v3", requested_model: "jev-latest", protocol: "v2" };
  expect((await internal("enrichment/classifications/target", target)).status).toBe(200);
  const claim = await internal("enrichment/classifications/claim", { protocol: "v2", spec_ids: [target.spec_id], taxonomy_versions: [target.taxonomy_version],
    policy_versions: [target.policy_version], models: [target.requested_model] });
  expect(claim.status).toBe(200);
  const job = await claim.json() as Record<string, unknown>;
  const response = await internal(`enrichment/classifications/${id}/complete`, { ...job, operation_key: "new-taxonomy-complete", result: {
    model: "jev-pinned", requested_model: target.requested_model, policy_version: target.policy_version, spec_id: target.spec_id, spec_hash,
    answers: { topic_image_creation: { type: "noul", noul: .95 }, resource_kind_skill: { type: "noul", noul: .96 } },
    classification: { topics: ["image_creation"], form: "tool", use: "", uncertainty: false, taxonomy_version: target.taxonomy_version,
      why_suggestion: "", entities: [], discarded_tags: [] },
    automatic: { ...EMPTY_AUTOMATIC, topics: ["image_creation"], resource_kinds: ["skill"], form: "tool" }
  } });
  expect(response.status, await response.clone().text()).toBe(200);
  const current = await get(id);
  expect(current.selection.topics).toEqual(["image_creation"]);
  expect(current.selection.resource_kinds).toEqual(["skill"]);
  const decision = await env.DB.prepare("SELECT automatic FROM classification_decisions WHERE link_id=? ORDER BY id DESC LIMIT 1").bind(id).first<string>("automatic");
  expect(JSON.parse(decision!).resource_kinds).toEqual(["skill"]);
  expect(await env.DB.prepare("SELECT resource_kinds FROM link_selections_v2 WHERE link_id=?").bind(id).first("resource_kinds")).toBe('["skill"]');
  const page = await (await call("links?include=enrichment&resource_kinds=skill")).json() as any;
  expect(page.items[0].enrichment.classification.resource_kinds).toEqual(["skill"]);
});
