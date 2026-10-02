import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { applyV1Write, projectV1, proposalImpact, taxonomyV2, validateTaxonomy, validateV2Selection } from "../src/taxonomy-v2";
import { expandSearchText } from "../src/taxonomy-routes";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function request(path: string, body?: unknown, method = "POST", token = "internal"): Promise<Response> {
  return worker.fetch(new Request(`https://test.example/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}

async function createLink(suffix = "1"): Promise<number> {
  const response = await request("links", { url: `https://x.com/a/status/${suffix}` }, "POST", "app");
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

it("commits a whole-selection projection atomically with bounded SQL statements", async () => {
  const id = await createLink();
  const selection = { topics: ["llm", "eng", "eval", "design"], content_functions: ["method", "tool", "data"],
    carriers: ["author_continuation"], affordances: ["practice", "background"], form: "method", use: "try" };
  const generation = await env.DB.prepare("SELECT value FROM cache_metadata WHERE key='links_generation'").first<number>("value");
  await env.DB.prepare(`CREATE TRIGGER reject_selection_projection BEFORE INSERT ON current_projections
    BEGIN SELECT RAISE(ABORT, 'synthetic selection projection failure'); END`).run();
  await expect(request(`v2/links/${id}/selection`, selection, "PATCH")).rejects.toThrow("synthetic selection projection failure");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_overrides WHERE link_id=?").bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_events WHERE link_id=?").bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT personal_revision FROM links WHERE id=?").bind(id).first("personal_revision")).toBe(0);
  expect(await env.DB.prepare("SELECT value FROM cache_metadata WHERE key='links_generation'").first<number>("value")).toBe(generation);
  await env.DB.prepare("DROP TRIGGER reject_selection_projection").run();
  let batchSize = 0;
  const db = new Proxy(env.DB, { get(target, property) {
    if (property === "batch") return (statements: D1PreparedStatement[]) => {
      batchSize = statements.length;
      return target.batch(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const response = await worker.fetch(new Request(`https://test.example/api/v2/links/${id}/selection`, {
    method: "PATCH", headers: { Authorization: "Bearer internal", "Content-Type": "application/json" }, body: JSON.stringify(selection)
  }), { DB: db, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
  expect(response.status).toBe(200);
  expect(batchSize).toBeLessThanOrEqual(7);
  const projected = await env.DB.prepare("SELECT effective FROM current_projections WHERE link_id=?").bind(id).first<string>("effective");
  expect(JSON.parse(projected!).topics).toEqual(selection.topics);
  expect((await (await request(`v2/links/${id}/selection`, undefined, "GET")).json() as {selection:{topics:string[]}}).selection.topics)
    .toEqual(selection.topics);
});

it("replays a whole-selection receipt after response loss and later edits without appending actions", async () => {
  const id = await createLink();
  const body = { operation_key: "selection-original", expected_revision: 0, topics: ["llm", "eng"],
    content_functions: ["method"], carriers: [], affordances: [], form: "", use: "" };
  const first = await request(`v2/links/${id}/selection`, body, "PATCH");
  expect(first.status).toBe(200);
  const confirmation = await first.json() as { revision: number; selection: { topics: string[] } };
  expect(confirmation.revision).toBe(1);
  expect(confirmation.selection.topics).toEqual(["llm", "eng"]);
  expect((await request(`v2/links/${id}/selection`, { topics: ["design"] }, "PATCH")).status).toBe(200);
  await env.DB.prepare(`UPDATE current_projections SET effective='{"topics":["corrupt"]}' WHERE link_id=?`).bind(id).run();
  const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_overrides WHERE link_id=?").bind(id).first<number>("n");
  const replay = await request(`v2/links/${id}/selection`, body, "PATCH");
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(confirmation);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_overrides WHERE link_id=?").bind(id).first("n")).toBe(before);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM selection_operations WHERE link_id=?").bind(id).first("n")).toBe(1);
  const repaired = await env.DB.prepare("SELECT effective FROM current_projections WHERE link_id=?").bind(id).first<string>("effective");
  expect(JSON.parse(repaired!).topics).toEqual(["design"]);
  expect((await request(`v2/links/${id}/selection`, { ...body, topics: ["eval"] }, "PATCH")).status).toBe(409);
  const other = await createLink("2");
  expect((await request(`v2/links/${other}/selection`, body, "PATCH")).status).toBe(409);
});

it("records a no-action selection and replays the original empty view after another write", async () => {
  const id = await createLink();
  const body = { operation_key: "selection-noop" };
  const first = await request(`v2/links/${id}/selection`, body, "PATCH");
  expect(first.status).toBe(200);
  const confirmation = await first.json() as { revision: number; selection: { topics: string[] } };
  expect(confirmation.revision).toBe(0);
  expect(confirmation.selection.topics).toEqual([]);
  expect((await request(`v2/links/${id}/selection`, { topics: ["llm"] }, "PATCH")).status).toBe(200);
  expect(await (await request(`v2/links/${id}/selection`, body, "PATCH")).json()).toEqual(confirmation);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM selection_operations WHERE link_id=?").bind(id).first("n")).toBe(1);
});

it("returns the committed receipt when the same operation wins between snapshot read and batch", async () => {
  const id = await createLink();
  const body = { operation_key: "selection-race", expected_revision: 0, topics: ["llm"] };
  let winner: unknown;
  let winnerEventCount = 0;
  const db = new Proxy(env.DB, { get(target, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      const response = await request(`v2/links/${id}/selection`, body, "PATCH");
      expect(response.status).toBe(200);
      winner = await response.json();
      winnerEventCount = (await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_events WHERE link_id=?")
        .bind(id).first<number>("n")) ?? 0;
      return target.batch(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const response = await worker.fetch(new Request(`https://test.example/api/v2/links/${id}/selection`, {
    method: "PATCH", headers: { Authorization: "Bearer internal", "Content-Type": "application/json" }, body: JSON.stringify(body)
  }), { DB: db, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(winner);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM selection_operations WHERE link_id=?").bind(id).first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_events WHERE link_id=?").bind(id).first("n"))
    .toBe(winnerEventCount);
});

it("rolls back selection actions and projection if the operation receipt cannot be inserted", async () => {
  const id = await createLink();
  await env.DB.prepare(`CREATE TRIGGER reject_selection_receipt BEFORE INSERT ON selection_operations
    BEGIN SELECT RAISE(ABORT, 'synthetic selection receipt failure'); END`).run();
  await expect(request(`v2/links/${id}/selection`, { operation_key: "receipt-fails", topics: ["llm"] }, "PATCH"))
    .rejects.toThrow("synthetic selection receipt failure");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_overrides WHERE link_id=?").bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM current_projections WHERE link_id=?").bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT personal_revision FROM links WHERE id=?").bind(id).first("personal_revision")).toBe(0);
});

it("rolls back a selection receipt with its actions when the projection fails", async () => {
  const id = await createLink();
  const generation = await env.DB.prepare("SELECT value FROM cache_metadata WHERE key='links_generation'").first<number>("value");
  await env.DB.prepare(`CREATE TRIGGER reject_receipt_projection BEFORE INSERT ON current_projections
    BEGIN SELECT RAISE(ABORT, 'synthetic receipt projection failure'); END`).run();
  const body = { operation_key: "selection-rollback", topics: ["llm"] };
  await expect(request(`v2/links/${id}/selection`, body, "PATCH")).rejects.toThrow("synthetic receipt projection failure");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM selection_operations WHERE link_id=?").bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_overrides WHERE link_id=?").bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT value FROM cache_metadata WHERE key='links_generation'").first("value")).toBe(generation);
  await env.DB.prepare("DROP TRIGGER reject_receipt_projection").run();
  expect((await request(`v2/links/${id}/selection`, body, "PATCH")).status).toBe(200);
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

it("replays a v1 selection receipt before newer hidden state can change validation", async () => {
  const id = await createLink();
  const body = { operation_key: "v1-original", topics: ["llm"], form: "method" };
  const first = await request(`v2/links/${id}/selection/v1`, body, "PATCH");
  expect(first.status).toBe(200);
  const confirmation = await first.json();
  expect((await request(`v2/links/${id}/selection`, { topics: ["llm", "eng", "eval", "design"] }, "PATCH")).status).toBe(200);
  const replay = await request(`v2/links/${id}/selection/v1`, body, "PATCH");
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(confirmation);
  expect((await request(`v2/links/${id}/selection/v1`, { ...body, topics: ["eng"] }, "PATCH")).status).toBe(409);
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

it("an incomplete legacy topic proposal stays pending until its definition and evidence can be validated", async () => {
  const created = await request("v2/taxonomy/proposals", { kind: "add_term", dimension: "topics", term_id: "robotics", payload: { label: "机器人" } });
  expect(created.status).toBe(200);
  const body = await created.json() as { id: string; applied: boolean; impact: { requires_definition_version_bump: boolean } };
  expect(body.applied).toBe(false);
  expect(body.impact.requires_definition_version_bump).toBe(true);
  const decision = await request(`v2/taxonomy/proposals/${body.id}/decision`, { decision: "approved", expected_revision: 1 });
  expect(decision.status).toBe(409);
  expect(await decision.json()).toMatchObject({ error: "topic_definition_required" });
  expect(await env.DB.prepare("SELECT status FROM taxonomy_proposals WHERE id=?").bind(body.id).first("status")).toBe("pending");
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

// --- B05-T01 mapping --------------------------------------------------------

it("maps every legacy term explicitly without inventing v2 equivalents", async () => {
  const { V1_V2_MAPPING, validateMapping } = await import("../src/taxonomy-mapping");
  expect(validateMapping()).toEqual([]);
  const uncertain = V1_V2_MAPPING.filter((entry) => entry.status === "uncertain");
  expect(uncertain.map((entry) => `${entry.legacy.dimension}:${entry.legacy.id}`).sort())
    .toEqual(["forms:longform", "uses:contra"]);
  // Every legacy dimension term is covered exactly once.
  const covered = new Set(V1_V2_MAPPING.map((entry) => `${entry.legacy.dimension}:${entry.legacy.id}`));
  expect(covered.size).toBe(V1_V2_MAPPING.length);
  const response = await request("v2/taxonomy/mapping", undefined, "GET");
  expect(response.status).toBe(200);
  const payload = await response.json() as { entries: unknown[]; problems: string[] };
  expect(payload.problems).toEqual([]);
  expect(payload.entries.length).toBe(V1_V2_MAPPING.length);
});
