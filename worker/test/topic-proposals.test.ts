import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { validateTopicProposal } from "../src/topic-proposals";
import { taxonomyV2 } from "../src/taxonomy-v2";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const definition = () => ({
  id: "food_photography", label: "美食摄影", description: "以食物和菜品为主体的摄影、布光及构图。",
  aliases: ["食物摄影"], includes: ["菜品拍摄与布光"], excludes: ["只有菜谱而未讨论摄影"],
  recall_terms: ["美食摄影", "food photography"], granularity: "specific", navigation: false,
  relations: [{ id: "image_creation", kind: "related" }],
});
async function source() {
  const row = await env.DB.prepare("INSERT INTO links(url, original_text, content_revision, created_at) VALUES (?, ?, 2, ?) RETURNING id")
    .bind(`https://example.com/${crypto.randomUUID()}`, "这篇主要讨论美食摄影中的菜品拍摄与布光。", new Date().toISOString()).first<{ id: number }>();
  return { link_id: row!.id, content_revision: 2, quote: "美食摄影中的菜品拍摄与布光" };
}

it("one well-defined rare concept can be a pending proposal without becoming a tag", async () => {
  const evidence = await source(), before = JSON.stringify(taxonomyV2());
  const payload = { term: definition(), evidence: [evidence] };
  const first = await validateTopicProposal(payload, env), second = await validateTopicProposal(payload, env);
  expect(first.ok).toBe(true);
  expect(first).toEqual(second);
  if (first.ok) {
    expect(first.term.granularity).toBe("specific");
    expect(first.evidence[0].source_hash).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(JSON.stringify(taxonomyV2())).toBe(before);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM curation_overrides").first("n")).toBe(0);
});

it("rejects synonyms and compound topic-resource names instead of creating duplicate identities", async () => {
  const topic = taxonomyV2().topics.find(term => term.id === "portrait_photography")!;
  expect(topic).toBeDefined();
  expect(await validateTopicProposal({ term: { ...definition(), label: topic.label }, evidence: [] }, env))
    .toMatchObject({ ok: false, error: "existing_topic", existing_terms: [topic.id] });
  expect(await validateTopicProposal({ term: { ...definition(), label: "AI写真Skill" }, evidence: [] }, env))
    .toMatchObject({ ok: false, error: "use_topic_resource_combination", existing_terms: [topic.id, "skill"] });
  expect(await validateTopicProposal({ term: { ...definition(), aliases: ["图像生成"] }, evidence: [] }, env))
    .toMatchObject({ ok: false, error: "existing_topic", existing_terms: ["image_creation"] });
});

it("requires real current primary evidence and never treats notes or generated text as evidence", async () => {
  const evidence = await source();
  expect(await validateTopicProposal({ term: definition(), evidence: [{ ...evidence, quote: "没有出现在原文中的说法" }] }, env))
    .toMatchObject({ ok: false, error: "unsupported_topic_evidence" });
  await env.DB.prepare("UPDATE links SET content_revision = 3 WHERE id = ?").bind(evidence.link_id).run();
  expect(await validateTopicProposal({ term: definition(), evidence: [evidence] }, env))
    .toMatchObject({ ok: false, error: "stale_topic_evidence" });
  expect(await validateTopicProposal({ term: definition(), evidence: [] }, env))
    .toMatchObject({ ok: false, error: "topic_evidence_required" });
});

it("requires semantic boundaries and explicit related links without creating a false parent", async () => {
  const evidence = await source();
  expect(await validateTopicProposal({ term: { ...definition(), excludes: [] }, evidence: [evidence] }, env))
    .toMatchObject({ ok: false, error: "invalid_topic_definition" });
  expect(await validateTopicProposal({ term: { ...definition(), relations: [{ id: "image_creation", kind: "broader" }] }, evidence: [evidence] }, env))
    .toMatchObject({ ok: false, error: "invalid_topic_relations" });
  expect(await validateTopicProposal({ term: { ...definition(), relations: [{ id: "absent", kind: "related" }] }, evidence: [evidence] }, env))
    .toMatchObject({ ok: false, error: "invalid_topic_relations" });
});
