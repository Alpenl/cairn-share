import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";

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
