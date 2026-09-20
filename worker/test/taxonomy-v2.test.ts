import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { applyV1Write, projectV1, proposalImpact, taxonomyV2, validateTaxonomy, validateV2Selection } from "../src/taxonomy-v2";
import { expandSearchText, selectionFilterSQL } from "../src/taxonomy-routes";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function request(path: string, body?: unknown, method = "POST", token = "internal"): Promise<Response> {
  return worker.fetch(new Request(`https://test.example/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}

async function createLink(): Promise<number> {
  const response = await request("links", { url: "https://x.com/a/status/1" }, "POST", "app");
  return (await response.json() as { id: number }).id;
}

// --- Vocabulary validity ----------------------------------------------------

it("the v2 vocabulary has no alias collisions or dangling relations", () => {
  expect(validateTaxonomy()).toEqual([]);
  const vocabulary = taxonomyV2();
  expect(vocabulary.content_functions.length).toBeGreaterThan(0);
  expect(vocabulary.carriers.map((term) => term.id)).toContain("unknown");
});

it("rejects a taxonomy with an alias collision", () => {
  const broken = { ...taxonomyV2(), topics: [...taxonomyV2().topics, { id: "dupe", label: "LLM", active: true, aliases: [], description: "x" }] };
  expect(validateTaxonomy(broken).some((problem) => problem.includes("collides"))).toBe(true);
});

// --- Multidimensional selection ---------------------------------------------

it("stores independent dimensions and keeps a legal v1 projection", async () => {
  const id = await createLink();
  const selection = {
    topics: ["llm", "eng", "eval", "design"],
    content_functions: ["method", "tool", "data"],
    carriers: ["author_continuation"],
    affordances: ["practice", "background"],
    form: "method", use: "try"
  };
  const response = await request(`v2/links/${id}/selection`, selection, "PATCH");
  expect(response.status).toBe(200);
  const body = await response.json() as { v1_projection: { topics: string[] } };
  // Four effective topics are retained underneath; v1 shows the first three.
  expect(body.v1_projection.topics).toEqual(["llm", "eng", "eval"]);
  const read = await (await request(`v2/links/${id}/selection`, undefined, "GET")).json() as { selection: typeof selection };
  expect(read.selection.topics).toHaveLength(4);
  expect(read.selection.content_functions).toEqual(["method", "tool", "data"]);
});

it("expresses tool+method+data and author continuation together", async () => {
  const id = await createLink();
  const response = await request(`v2/links/${id}/selection`, {
    topics: ["llm"], content_functions: ["tool", "method", "data"], carriers: ["author_continuation"], affordances: [], form: "longform", use: ""
  }, "PATCH");
  expect(response.status).toBe(200);
  const read = await (await request(`v2/links/${id}/selection`, undefined, "GET")).json() as { selection: { content_functions: string[]; form: string; use: string } };
  expect(read.selection.content_functions).toEqual(["tool", "method", "data"]);
  expect(read.selection.form).toBe("longform");
  // An explicit empty use is a completed value, not an error.
  expect(read.selection.use).toBe("");
});

it("rejects an unknown or duplicate term", async () => {
  const id = await createLink();
  expect((await request(`v2/links/${id}/selection`, { topics: ["invented"], content_functions: [], carriers: [], affordances: [], form: "", use: "" }, "PATCH")).status).toBe(400);
  expect((await request(`v2/links/${id}/selection`, { topics: ["llm", "llm"], content_functions: [], carriers: [], affordances: [], form: "", use: "" }, "PATCH")).status).toBe(400);
  // Carrier is single-valued.
  expect((await request(`v2/links/${id}/selection`, { topics: [], content_functions: [], carriers: ["single", "unknown"], affordances: [], form: "", use: "" }, "PATCH")).status).toBe(400);
});

// --- v1 write compatibility -------------------------------------------------

it("a v1 write does not clear hidden v2 state", async () => {
  const id = await createLink();
  await request(`v2/links/${id}/selection`, {
    topics: ["llm", "eng"], content_functions: ["method"], carriers: ["single"], affordances: ["practice"], form: "method", use: "try"
  }, "PATCH");
  const response = await request(`v2/links/${id}/selection/v1`, { topics: ["design"], form: "case" }, "PATCH");
  expect(response.status).toBe(200);
  const read = await (await request(`v2/links/${id}/selection`, undefined, "GET")).json() as { selection: { topics: string[]; content_functions: string[]; affordances: string[]; use: string } };
  expect(read.selection.topics).toContain("design");
  expect(read.selection.content_functions).toEqual(["method"]);
  expect(read.selection.affordances).toEqual(["practice"]);
  expect(read.selection.use).toBe("try");
});

it("a v1 write returns an actionable conflict when it cannot express a change", async () => {
  const id = await createLink();
  await request(`v2/links/${id}/selection`, {
    topics: ["llm", "eng", "eval", "design"], content_functions: [], carriers: [], affordances: [], form: "", use: ""
  }, "PATCH");
  const response = await request(`v2/links/${id}/selection/v1`, { topics: [] }, "PATCH");
  expect(response.status).toBe(409);
  const body = await response.json() as { error: string; hidden_topics: string[] };
  expect(body.error).toBe("hidden_value_conflict");
  expect(body.hidden_topics).toEqual(["design"]);
});

it("pure v1 helpers preserve folded topics and hidden dimensions", () => {
  const existing = { topics: ["llm", "eng", "eval", "design"], content_functions: ["method"], carriers: [], affordances: [], form: "", use: "" };
  const { selection, touchesHidden } = applyV1Write(existing, { topics: ["science"] });
  expect(selection.topics).toEqual(["science", "design"]);
  expect(touchesHidden).toBe(true);
  expect(projectV1(selection).topics).toEqual(["science", "design"]);
});

// --- Taxonomy proposals -----------------------------------------------------

it("a proposal never mutates the vocabulary until approved", async () => {
  const created = await request("v2/taxonomy/proposals", { kind: "add_term", dimension: "topics", term_id: "robotics", payload: { label: "机器人" } });
  expect(created.status).toBe(200);
  const body = await created.json() as { id: string; applied: boolean; impact: { requires_definition_version_bump: boolean } };
  expect(body.applied).toBe(false);
  expect(body.impact.requires_definition_version_bump).toBe(true);
  const decision = await request(`v2/taxonomy/proposals/${body.id}/decision`, { decision: "approved", expected_revision: 1 });
  const decided = await decision.json() as { vocabulary_changed: boolean; status: string };
  expect(decided.status).toBe("approved");
  expect(decided.vocabulary_changed).toBe(false);
  // Deciding twice is a conflict, not a silent no-op.
  expect((await request(`v2/taxonomy/proposals/${body.id}/decision`, { decision: "approved" })).status).toBe(409);
});

it("a label rename is display-only and does not require re-evaluation", () => {
  const impact = proposalImpact({ id: "p", kind: "rename_label", dimension: "topics", term_id: "llm", payload: {}, status: "pending", revision: 1, submitted_at: "now" });
  expect(impact.requires_definition_version_bump).toBe(false);
});

// --- Search and filters -----------------------------------------------------

it("search text covers objective and personal fields", () => {
  const text = expandSearchText({ url: "https://x.com/a", note: "备注", original_text: "body", summary: "摘要", ai_title: "标题", why: "原因", entities: ["项目甲"] });
  for (const needle of ["备注", "body", "摘要", "标题", "原因", "项目甲"]) {
    expect(text).toContain(needle);
  }
});

it("selection filters parameterise same-dimension OR and cross-dimension AND", () => {
  const { clause, bindings } = selectionFilterSQL({ topics: ["llm", "eng"], content_functions: ["method"] });
  expect(clause).toContain(" OR ");
  expect(clause).toContain(" AND ");
  expect(bindings).toEqual(["llm", "eng", "method"]);
  // An unknown term is dropped rather than injected into SQL.
  const { bindings: safe } = selectionFilterSQL({ topics: ["invented"] });
  expect(safe).toEqual([]);
});

it("requires the enricher token for the v2 taxonomy API", async () => {
  expect((await request("v2/taxonomy", undefined, "GET", "app")).status).toBe(401);
});

it("cascades v2 selection deletes with the link", async () => {
  const id = await createLink();
  await request(`v2/links/${id}/selection`, { topics: ["llm"], content_functions: [], carriers: [], affordances: [], form: "", use: "" }, "PATCH");
  await env.DB.prepare("DELETE FROM links WHERE id = ?").bind(id).run();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM link_selections_v2 WHERE link_id = ?").bind(id).first<{ n: number }>();
  expect(row!.n).toBe(0);
});

it("validates a partial v2 selection against the vocabulary", () => {
  expect(validateV2Selection({ topics: ["llm"], form: "method", use: "try" })).toBeNull();
  expect(validateV2Selection({ topics: ["llm"], content_functions: ["method"], carriers: [], affordances: ["practice"], form: "method", use: "try" })).not.toBeNull();
});
