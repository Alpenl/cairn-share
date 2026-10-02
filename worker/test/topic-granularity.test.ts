import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { canonicalJSON, EMPTY_AUTOMATIC, semanticSpecHash, validAssessment, validQuestionSpec } from "../src/domain";
import { classificationTaxonomy, taxonomyV2 } from "../src/taxonomy-v2";
import { validCandidateAutomatic, validateCandidateManifest } from "../src/candidate-manifest";
import { validRunProvenance } from "../src/run-provenance";
import go from "./fixtures/go-candidate-v2.json";
import legacyGo from "./fixtures/tag-system-go-completion.json";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const modern = { "X-Cairn-Tag-System": "1", "X-Cairn-Topic-Granularity": "1", "X-Cairn-Content-Functions": "1" };
function call(path: string, body?: unknown, headers: Record<string, string> = modern, token = "app", DB = env.DB) {
  return worker.fetch(new Request(`https://test/api/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
  { DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}
async function seed(topics: string[] = [], id = 1) {
  await env.DB.prepare("INSERT INTO links(id,url,note,original_text,created_at) VALUES(?,?,'saved note','Synthetic keyword material','2026-10-02T00:00:00Z')")
    .bind(id, `https://example.com/${id}`).run();
  const run = await env.DB.prepare(`INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,target_generation,
    requested_model,policy_version,answers,operation_key,created_at) VALUES(?,1,'s','h',0,'m','p','{}',?,'2026-10-02') RETURNING id`)
    .bind(id, crypto.randomUUID()).first<number>("id");
  await env.DB.prepare(`INSERT INTO classification_decisions(link_id,run_id,content_revision,policy_version,policy,automatic,operation_key,created_at)
    VALUES(?,?,1,'p','{}',?,?,'2026-10-02')`).bind(id, run, JSON.stringify({ ...EMPTY_AUTOMATIC, topics }), crypto.randomUUID()).run();
  return id;
}
async function state(id: number) { return (await (await call(`bookmarks/${id}/tags`)).json()) as any; }
async function act(id: number, actions: unknown[], operation_key = crypto.randomUUID()) {
  const s = await state(id);
  return call(`bookmarks/${id}/tags`, { operation_key, expected_revision: s.revision,
    expected_decision_id: s.decision_id, expected_content_revision: s.content_revision, actions });
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

it("negotiates topic metadata on both catalog routes while keeping historical catalogs and strict old term shapes", async () => {
  for (const [path, token] of [["v2-taxonomy", "app"], ["v2/taxonomy", "internal"]]) {
    const response = await call(path, undefined, modern, token);
    expect(response.headers.get("X-Cairn-Topic-Granularity")).toBe("1");
    expect(response.headers.get("X-Cairn-Tag-System")).toBe("1");
    const catalog = await response.json() as any;
    const active = catalog.topics.filter((term: any) => term.active && !term.deprecated);
    expect(catalog.version).toBe("2026-10-02.1"); expect(active).toHaveLength(37);
    expect(active.filter((term: any) => term.granularity === "specific")).toHaveLength(24);
    expect(active.filter((term: any) => term.navigation)).toHaveLength(13);
    expect(active.find((term: any) => term.id === "portrait_photography")).toMatchObject({ granularity: "specific", navigation: false });
    expect(active.find((term: any) => term.id === "portrait_photography").aliases).not.toContain("AI写真");
    const tagOnly = await (await call(path, undefined, { "X-Cairn-Tag-System": "1" }, token)).json() as any;
    for (const term of tagOnly.topics) for (const key of ["granularity", "navigation", "recall_terms", "relations"]) expect(term).not.toHaveProperty(key);
    const legacy = await (await call(path, undefined, {}, token)).json() as any;
    expect(legacy.version).toBe("2026-09-20.1"); expect(legacy).not.toHaveProperty("resource_kinds");
    expect(legacy.topics.some((term: any) => term.id === "portrait_photography")).toBe(false);
  }
  for (const [version, n] of [["2026-09-30.1", 12], ["2026-09-30.2", 13]] as const) {
    const catalog = classificationTaxonomy(version)!;
    expect(catalog.topics.filter(t => t.active && !t.deprecated)).toHaveLength(n);
    expect(catalog.topics.every(t => t.granularity === undefined)).toBe(true);
  }
});

it("fails closed for unnegotiated refinements and invalid capability combinations", async () => {
  for (const path of ["links", "enrichment/jobs", "tag-counts", "tag-export"]) {
    const token = path.startsWith("enrichment/") ? "internal" : "app";
    expect((await call(`${path}?topic_refinements=portrait_photography`, undefined, { "X-Cairn-Tag-System": "1" }, token)).status).toBe(409);
    for (const value of ["", "image_creation", "not_a_topic", "portrait_photography,", "portrait_photography&topic_refinements=portrait_photography"]) {
      expect((await call(`${path}?topic_refinements=${value}`, undefined, modern, token)).status).toBe(400);
    }
  }
  expect((await call("v2-taxonomy", undefined, { "X-Cairn-Topic-Granularity": "1" })).status).toBe(409);
  expect((await call("v2-taxonomy", undefined, { "X-Cairn-Tag-System": "1", "X-Cairn-Topic-Granularity": "2" })).status).toBe(409);
});

it("keeps (A OR B) AND every refinement exact across cached lists, counts, search and export without relation inheritance", async () => {
  await seed(["image_creation", "portrait_photography", "character_consistency"], 1);
  await seed(["video_creation", "portrait_photography"], 2);
  await seed(["image_creation"], 3);
  await seed(["portrait_photography"], 4);
  await seed(["video_creation", "whiteboard_animation"], 5);
  const base = "curation_status=all&topics=image_creation,video_creation&topic_mode=any";
  for (const [suffix, ids] of [["", [5, 3, 2, 1]], ["&topic_refinements=portrait_photography", [2, 1]],
    ["&topic_refinements=portrait_photography,character_consistency", [1]], ["&topic_mode=all", []]] as const) {
    // A duplicate mode is invalid; the ALL case replaces the original mode.
    const query = suffix === "&topic_mode=all" ? base.replace("=any", "=all") : base + suffix;
    for (const [path, token] of [["links", "app"], ["enrichment/jobs", "internal"]]) {
      const response = await call(`${path}?${query}&q=keyword${path === "links" ? "&include=enrichment" : ""}`, undefined, modern, token);
      expect(response.status).toBe(200); expect(response.headers.get("X-Cairn-Topic-Granularity")).toBe("1");
      expect((await response.json() as any).items.map((row: any) => row.id)).toEqual(ids);
    }
    const counts = await (await call(`tag-counts?${query}&q=keyword`)).json() as any;
    expect(counts.total).toBe(ids.length);
    const exported = await (await call(`tag-export?${query}&q=keyword`)).json() as any;
    expect(exported.links.map((row: any) => row.id)).toEqual(ids); expect(exported.total).toBe(ids.length);
  }
  expect((await (await call("tag-counts?topics=portrait_photography&topic_refinements=character_consistency")).json() as any).total).toBe(1);
  expect((await (await call("tag-counts?topic_refinements=portrait_photography")).json() as any).total).toBe(3);
});

it("preserves exact specific-tag identity, human veto, causal undo and versioned definition history", async () => {
  await seed(["image_creation", "portrait_photography"]);
  expect((await act(1, [{ action: "reject", tag_ref: "system/topics/portrait_photography" }], "veto-specific")).status).toBe(200);
  expect((await state(1)).selection.topics).toEqual(["image_creation"]);
  expect((await (await call("tag-counts?topic_refinements=portrait_photography")).json() as any).total).toBe(0);
  expect((await act(1, [{ action: "accept", tag_ref: "system/topics/character_consistency" }], "add-specific")).status).toBe(200);
  expect((await state(1)).selection.topics).toEqual(["image_creation", "character_consistency"]);
  const history = await (await call("bookmarks/1/tag-history")).json() as any;
  const definitions = history.events.flatMap((event: any) => event.context.tag_definitions ?? []);
  expect(definitions.some((term: any) => term.id === "character_consistency" && term.granularity === "specific" && term.definition_version === 1)).toBe(true);
  const old = await (await call("bookmarks/1/tag-history", undefined, { "X-Cairn-Tag-System": "1" })).json() as any;
  for (const event of old.events) for (const term of event.context.tag_definitions ?? []) expect(term).not.toHaveProperty("granularity");
  expect((await act(1, [{ action: "undo", operation_id: "add-specific" }], "undo-add")).status).toBe(200);
  expect((await state(1)).selection.topics).toEqual(["image_creation"]);
  expect(await env.DB.prepare("SELECT COUNT(*) FROM tag_change_facts WHERE operation_id='veto-specific'").first("COUNT(*)")).toBeGreaterThan(0);
});

it("backfills the indexed read model from 0048 without changing original material, old human tags or causal history", async () => {
  await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter(m => m.name < "0049"));
  await seed(["image_creation"]);
  await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,source,confirmed,revision,operation_key,created_at)
    VALUES(1,'topics','life','accept','human',1,1,'old-life-confirm','2026-09-30')`).run();
  const before = { link: await env.DB.prepare("SELECT * FROM links WHERE id=1").first(),
    overrides: (await env.DB.prepare("SELECT * FROM curation_overrides WHERE link_id=1").all()).results,
    facts: (await env.DB.prepare("SELECT * FROM tag_change_facts WHERE link_id=1").all()).results };
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(await env.DB.prepare("SELECT * FROM links WHERE id=1").first()).toEqual(before.link);
  expect((await env.DB.prepare("SELECT * FROM curation_overrides WHERE link_id=1").all()).results).toEqual(before.overrides);
  expect((await env.DB.prepare("SELECT * FROM tag_change_facts WHERE link_id=1").all()).results).toEqual(before.facts);
  expect((await state(1)).selection.topics).toEqual(["image_creation", "life"]);
  expect((await (await call("tag-counts?topics=life")).json() as any).total).toBe(1);
  expect((await act(1, [{ action: "accept", tag_ref: "system/topics/portrait_photography" }])).status).toBe(200);
  expect((await (await call("tag-counts?topics=life&topic_refinements=portrait_photography")).json() as any).total).toBe(1);
});

const definition = () => ({ id: "food_photography", label: "美食摄影", description: "以食物和菜品为主体的摄影、布光及构图。",
  aliases: ["食物摄影"], includes: ["菜品拍摄与布光"], excludes: ["只有菜谱而未讨论摄影"], recall_terms: ["美食摄影"],
  granularity: "specific", navigation: false, relations: [{ id: "image_creation", kind: "related" }] });
async function proposed() {
  await seed(); await env.DB.prepare("UPDATE links SET original_text='美食摄影中的菜品拍摄与布光' WHERE id=1").run();
  const content_revision = await env.DB.prepare("SELECT content_revision FROM links WHERE id=1").first<number>("content_revision");
  return { kind: "add_term", dimension: "topics", term_id: "food_photography", payload: { term: definition(),
    evidence: [{ link_id: 1, content_revision, quote: "菜品拍摄与布光" }] } };
}
function beforeSQL(needle: string, mutate: () => Promise<void>) {
  let invoked = false;
  return new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(s, k) {
        if (k === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
        if (k === "run") return async () => { if (!invoked && sql.includes(needle)) { invoked = true; await mutate(); } return s.run(); };
        const v = Reflect.get(s, k); return typeof v === "function" ? v.bind(s) : v;
      } }); return wrap(target.prepare(sql));
    };
    const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v;
  } });
}

it("stores one normalized, source-bound rare-topic proposal, prevents duplicate definitions and requires versioned publication", async () => {
  const body = await proposed(), original = JSON.stringify(taxonomyV2());
  const response = await call("v2/taxonomy/proposals", body, modern, "internal");
  expect(response.status).toBe(200); const first = await response.json() as any;
  expect(await (await call("v2/taxonomy/proposals", body, modern, "internal")).json()).toEqual(first);
  expect((await call("v2/taxonomy/proposals", { ...body, term_id: "mismatch" }, modern, "internal")).status).toBe(400);
  const changed = structuredClone(body); changed.payload.term.description += "另一个边界。";
  expect((await call("v2/taxonomy/proposals", changed, modern, "internal")).status).toBe(409);
  const stored = JSON.parse(await env.DB.prepare("SELECT payload FROM taxonomy_proposals WHERE id=?").bind(first.id).first<string>("payload") ?? "null");
  expect(stored.evidence[0].source_hash).toHaveLength(64); expect(stored.fingerprint).toHaveLength(64);
  expect((await call(`v2/taxonomy/proposals/${first.id}/decision`, { decision: "approved", expected_revision: 1 }, modern, "internal")).status).toBe(200);
  expect((await call(`v2/taxonomy/proposals/${first.id}/apply`, {}, modern, "internal")).status).toBe(409);
  expect(JSON.stringify(taxonomyV2())).toBe(original);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM curation_overrides").first("n")).toBe(0);
});

it("fences proposal creation and approval against both content revisions and in-place source changes", async () => {
  const body = await proposed();
  const DB = beforeSQL("INSERT INTO taxonomy_proposals", async () => {
    await env.DB.prepare("UPDATE links SET original_text=original_text||'changed' WHERE id=1").run();
    // Simulate a maintenance write that accidentally preserves the revision:
    // the exact-text fence must still reject this source drift.
    await env.DB.prepare("UPDATE links SET content_revision=? WHERE id=1").bind(body.payload.evidence[0].content_revision).run();
  });
  expect((await call("v2/taxonomy/proposals", body, modern, "internal", DB)).status).toBe(409);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM taxonomy_proposals").first("n")).toBe(0);
  body.payload.evidence[0].content_revision = await env.DB.prepare("SELECT content_revision FROM links WHERE id=1").first<number>("content_revision");
  const response = await call("v2/taxonomy/proposals", body, modern, "internal"); expect(response.status).toBe(200);
  const id = (await response.json() as any).id;
  const approvalDB = beforeSQL("UPDATE taxonomy_proposals SET status", async () => { await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=1").run(); });
  expect((await call(`v2/taxonomy/proposals/${id}/decision`, { decision: "approved" }, modern, "internal", approvalDB)).status).toBe(409);
  expect(await env.DB.prepare("SELECT status FROM taxonomy_proposals WHERE id=?").bind(id).first("status")).toBe("pending");
});

it("normalizes a complete legacy draft on explicit review while preserving its source proof", async () => {
  const body = await proposed();
  const response = await call("v2/taxonomy/proposals", body, {}, "internal"); expect(response.status).toBe(200);
  const id = (await response.json() as any).id;
  expect((await call(`v2/taxonomy/proposals/${id}/decision`, { decision: "approved", expected_revision: 1 }, {}, "internal")).status).toBe(200);
  const payload = JSON.parse(await env.DB.prepare("SELECT payload FROM taxonomy_proposals WHERE id=?").bind(id).first<string>("payload") ?? "null");
  expect(payload.fingerprint).toHaveLength(64); expect(payload.evidence[0].source_hash).toHaveLength(64);
  expect(payload.term.granularity).toBe("specific");
});

it("hashes recall metadata into spec identity without changing provider question semantics or old hashes", async () => {
  expect(await semanticSpecHash(legacyGo.spec)).toBe(legacyGo.result.spec_hash);
  expect(await semanticSpecHash(go.spec)).toBe(go.spec_hash); expect(validQuestionSpec(go.spec)).toBe(true);
  const changed = structuredClone(go.spec); const question = changed.questions.find(q => q.id === "topic_portrait_photography")!;
  const provider = (q: any) => ({ id: q.id, kind: q.kind, instructions: q.instructions, criteria: q.criteria });
  const originalQuestion = structuredClone(question); question.recall_terms!.push("additional controlled clue");
  expect(await semanticSpecHash(changed)).not.toBe(go.spec_hash);
  expect(await digest(canonicalJSON(provider(question)))).toBe(await digest(canonicalJSON(provider(originalQuestion))));
});

it("accepts actual Go metadata2 selected coverage and rejects forged partitions, identities and implied negatives", async () => {
  await seed(); expect((await call("v2/question-specs", { ...go.spec, spec_hash: go.spec_hash }, modern, "internal")).status).toBe(200);
  const expected = { specId: go.result.spec_id, specHash: go.spec_hash, requestedModel: go.result.requested_model,
    resolvedModel: go.result.model, coverage: "complete", answers: go.result.answers, usage: go.result.usage, automatic: go.result.automatic };
  const settings = { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" };
  expect(await validRunProvenance(settings, 1, go.result.raw_judgments, expected)).toBe(true);
  const omitted = go.result.automatic.assessment.decisions.find(d => d.term_id === "whiteboard_animation")!;
  expect(omitted).toMatchObject({ verdict: "abstained", reason: "not_recalled" }); expect(omitted).not.toHaveProperty("probability");
  expect(validAssessment(go.result.automatic.assessment)).toBe(true);
  const questions = new Map(go.spec.questions.map(q => [q.id, q]));
  for (const change of [
    (raw: any) => { raw.candidate_manifest.state_hash = "0".repeat(64); },
    (raw: any) => { raw.candidate_manifest.spec_hash = "0".repeat(64); },
    (raw: any) => { raw.candidate_manifest.selected_question_ids.push("unknown"); },
    (raw: any) => { raw.candidate_manifest.omitted[0].reason = "rejected"; },
    (raw: any) => { raw.candidate_manifest.omitted[0].granularity = "broad"; },
    (raw: any) => { raw.candidate_manifest.max_questions = 1; },
    (raw: any) => { raw.candidate_manifest.selection_hash = "0".repeat(64); }
  ]) {
    const raw = structuredClone(go.result.raw_judgments); change(raw);
    expect(await validateCandidateManifest(raw, questions)).toBeNull();
    expect(await validRunProvenance(settings, 1, raw, expected)).toBe(false);
  }
  const wrong = structuredClone(go.result.automatic) as any; wrong.topics.push("whiteboard_animation");
  expect(validCandidateAutomatic(go.result.raw_judgments, wrong)).toBe(false);
  wrong.topics.pop(); wrong.assessment.decisions.find((d: any) => d.term_id === "whiteboard_animation").probability = 0;
  expect(validCandidateAutomatic(go.result.raw_judgments, wrong)).toBe(false);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_runs").first("n")).toBe(1); // only the synthetic seed baseline
});
