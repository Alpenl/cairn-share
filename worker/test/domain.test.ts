import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { canonicalJSON, contentHash, effectiveView, objectivePayload, type AutomaticView, type EvidenceSnapshot, type Override } from "../src/domain";
import vectors from "./fixtures/override-vectors.json";
import stateFixture from "./fixtures/selection-state-v1.json";
import { rebuildProjection } from "../src/domain-routes";
import { readSelectionSnapshot } from "../src/selection-state";
import type { Env } from "../src/index";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function request(path: string, body?: unknown, method = "POST", token = "internal"): Promise<Response> {
  return worker.fetch(new Request(`https://test.example/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}

async function createLink(): Promise<number> {
  const response = await worker.fetch(new Request("https://test.example/api/links", {
    method: "POST", headers: { Authorization: "Bearer app", "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://x.com/a/status/1" })
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
  return (await response.json() as { id: number }).id;
}

function snapshot(overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    blocks: [{ id: "b1", role: "primary", text: "primary body" }],
    fetched_at: "2026-09-20T00:00:00Z",
    retrieval: "x_search",
    truncation: { truncated: false },
    ...overrides
  };
}

const emptyAutomatic: AutomaticView = {
  topics: [], content_functions: [], carriers: [], affordances: [], form: "", use: "", entities: []
};

it("B07: keeps stored policy outcomes distinct from empty, unknown and human origin", async () => {
  const id = await createLink();
  const read = async () => {
    const response = await request(`bookmarks/${id}/v2-selection?include_automatic=1&include_state=1`, undefined, "GET", "app");
    expect(response.status).toBe(200);
    return response.json() as Promise<Record<string, any>>;
  };
  expect((await read()).state.fields.topics.status).toBe("not_run");
  await env.DB.prepare("INSERT INTO classification_jobs(link_id,status,content_revision) VALUES (?,'failed',1)").bind(id).run();
  expect((await read()).state.fields.topics.status).toBe("failed");
  const runID = await submitRun(id, "display-run");
  expect((await submitDecision(id, runID, { ...emptyAutomatic, topics: ["llm"] }, "old-decision")).status).toBe(200);
  expect((await read()).state.fields.topics.status).toBe("unknown");
  const automatic: AutomaticView = { ...emptyAutomatic, topics: ["llm"], assessment: { version: 1, incomplete: ["affordances"], decisions: [
    { dimension: "topics", term_id: "llm", verdict: "accepted", probability: 0.9, reason: "above bound" },
    { dimension: "topics", term_id: "eval", verdict: "abstained", probability: 0.5, reason: "between bounds" },
    { dimension: "topics", term_id: "design", verdict: "rejected", probability: 0, reason: "below bound" },
    { dimension: "form", candidate: "method", verdict: "abstained", probability: 0.5, reason: "below bound" },
    { dimension: "use", candidate: "none", verdict: "accepted", probability: 0.9, reason: "explicit none" },
  ] } };
  expect((await submitDecision(id, runID, automatic, "display-decision")).status).toBe(200);
  let response = await read();
  expect(response.state.fields).toEqual(stateFixture.state.fields);
  await env.DB.prepare("UPDATE classification_runs SET evidence_coverage='truncated' WHERE id=?").bind(runID).run();
  expect((await read()).state.decision_evidence_partial).toBe(true);
  expect(response.state.fields.topics).toMatchObject({ status: "completed_nonempty", values: [{ term: "llm", origin: "automatic", confirmed: false }] });
  expect(response.state.fields.topics.candidates[2].probability).toBe(0);
  expect(response.state.fields.form).toMatchObject({ status: "abstained", candidates: [{ candidate: "method" }] });
  expect(response.state.fields.use.status).toBe("completed_empty");
  expect(response.state.fields.affordances).toMatchObject({ status: "not_run", incomplete: true });
  expect(response.state.entities.status).toBe("not_run");
  const act = async (action: string, term: string, revision: number) => {
    expect((await request(`bookmarks/${id}/v2-override`, { operation_key: `display-${revision}`, field: "topics", action, term, expected_revision: revision }, "POST", "app")).status).toBe(200);
  };
  await act("accept", "llm", 0);
  expect((await read()).state.fields.topics.values).toEqual([{ term: "llm", origin: "human", confirmed: true, revision: 1 }]);
  await act("reset", "llm", 1);
  expect((await read()).state.fields.topics.values[0].origin).toBe("automatic");
  await act("set_empty", "", 2);
  response = await read();
  expect(response.selection.topics).toEqual([]);
  expect(response.state.fields.topics.empty).toEqual({ origin: "human", confirmed: true, revision: 3 });
  expect(response.state.fields.topics.status).toBe("completed_nonempty"); // automatic state is independent of human empty
  await act("reset", "llm", 3);
  response = await read();
  expect(response.state.fields.topics.values).toEqual([{ term: "llm", origin: "automatic", confirmed: false, revision: null }]);
  expect(response.state.fields.topics.empty).toBeNull();
  expect(response.state.fields.topics.cleared_automatic).toEqual({ origin: "human", confirmed: true, revision: 3 });
  expect((await submitDecision(id, runID, { ...automatic, topics: ["llm", "eng"] }, "after-tag-reset")).status).toBe(200);
  expect((await read()).selection.topics).toEqual(["llm"]); // the other cleared tag stays suppressed
  await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=?").bind(id).run();
  expect((await read()).state.fields.topics.status).toBe("stale");
  const old = await (await request(`bookmarks/${id}/v2-selection`, undefined, "GET", "app")).json() as Record<string, unknown>;
  expect(old).not.toHaveProperty("state");
  expect(old).not.toHaveProperty("automatic");
  // Metadata is in the immutable operation identity, not silently discarded.
  expect((await submitDecision(id, runID, { ...automatic, assessment: { ...automatic.assessment!, incomplete: [] } }, "display-decision")).status).toBe(409);
});

it("B07: a mutation after the snapshot read cannot stamp a new revision onto old values", async () => {
  const id = await createLink();
  let reads = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
    if (key === "first") return async () => {
      reads++;
      const value = await target.first();
      expect((await request(`bookmarks/${id}/v2-override`, { operation_key: "during-read", field: "topics", term: "llm", action: "accept", expected_revision: 0 }, "POST", "app")).status).toBe(200);
      return value;
    };
    return Reflect.get(target, key);
  } });
  const db = new Proxy(env.DB, { get(target, key) {
    return key === "prepare" ? (sql: string) => wrap(target.prepare(sql)) : Reflect.get(target, key);
  } });
  const snapshot = await readSelectionSnapshot({ DB: db } as Env, id);
  expect(reads).toBe(1);
  expect(snapshot?.link.personal_revision).toBe(0);
  expect(snapshot?.view.topics).toEqual([]);
  const fresh = await readSelectionSnapshot({ DB: env.DB } as Env, id);
  expect(fresh?.link.personal_revision).toBe(1);
  expect(fresh?.view.topics).toEqual(["llm"]);
});

it("B07: entity status and baseline use their own snapshot even without classification", async () => {
  const id = await createLink();
  const evidence = await (await request(`v2/links/${id}/evidence`, { snapshot: snapshot() })).json() as { id: number; content_revision: number; content_hash: string };
  await env.DB.prepare(`INSERT INTO entity_states(link_id,state,content_revision,content_hash,evidence_snapshot_id,entities,updated_at)
    VALUES (?,'completed_nonempty',?,?,?,'["Jev"]','now')`).bind(id, evidence.content_revision, evidence.content_hash, await env.DB.prepare("SELECT id FROM evidence_snapshots WHERE link_id=? AND content_revision=?").bind(id, evidence.content_revision).first("id")).run();
  const read = () => readSelectionSnapshot({ DB: env.DB } as Env, id);
  let result = await read();
  expect(result?.state.fields.topics.status).toBe("not_run");
  expect(result?.state.entities).toMatchObject({ status: "completed_nonempty", values: [{ term: "Jev", origin: "automatic", confirmed: false }] });
  await env.DB.prepare("UPDATE entity_states SET state='failed' WHERE link_id=?").bind(id).run();
  expect((await read())?.state.entities).toMatchObject({ status: "failed", automatic: [], values: [] });
  await env.DB.prepare("UPDATE entity_states SET state='completed_empty',entities='[]' WHERE link_id=?").bind(id).run();
  expect((await read())?.state.entities.status).toBe("completed_empty");
  await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=?").bind(id).run();
  result = await read();
  expect(result?.state.entities.status).toBe("stale");
  expect(result?.view.entities).toEqual([]);
});

// --- Cross-language canonicalisation vectors -------------------------------

it("canonical JSON sorts keys and preserves array order", () => {
  const left = { b: 1, a: [{ y: 2, x: 1 }] };
  const right = { a: [{ x: 1, y: 2 }], b: 1 };
  expect(canonicalJSON(left)).toBe(canonicalJSON(right));
  expect(canonicalJSON({ a: [1, 2] })).not.toBe(canonicalJSON({ a: [2, 1] }));
});

it("content hash ignores personal fields and key order", async () => {
  const first = await contentHash(snapshot());
  const reordered: EvidenceSnapshot = {
    truncation: { truncated: false }, retrieval: "x_search", fetched_at: "2026-09-20T00:00:00Z",
    blocks: [{ role: "primary", text: "primary body", id: "b1" }]
  };
  expect(await contentHash(reordered)).toBe(first);
  expect(objectivePayload({ ...snapshot(), ...{ note: "personal" } } as EvidenceSnapshot)).toBe(objectivePayload(snapshot()));
});

// --- Shared human-override vectors (F11) ------------------------------------

it("matches the shared Go/TS override vectors exactly", () => {
  for (const vector of vectors.vectors) {
    const overrides = vector.overrides.map((entry, index) => ({
      field: entry.field, term: entry.term, action: entry.action,
      source: "human" as const, confirmed: true, revision: index + 1
    })) as Override[];
    // The resolver stores canonical field names; normalize legacy aliases the
    // same way the route handler does before they reach storage.
    const canonical = overrides.map((entry) => ({ ...entry, field: normalize(entry.field) }));
    const view = effectiveView(vector.automatic as AutomaticView, canonical);
    expect(pick(view), vector.name).toEqual(vector.expected);
  }
});

function normalize(field: string): Override["field"] {
  const map: Record<string, Override["field"]> = {
    topic: "topics", entity: "entities", content_function: "content_functions",
    carrier: "carriers", affordance: "affordances"
  };
  return (map[field] ?? field) as Override["field"];
}

function pick(view: ReturnType<typeof effectiveView>) {
  return {
    topics: view.topics, content_functions: view.content_functions, carriers: view.carriers,
    affordances: view.affordances, form: view.form, use: view.use, entities: view.entities
  };
}

// --- Internal v2 API --------------------------------------------------------

it.each([
  ["form", "method", "case"],
  ["use", "try", "quote"],
  ["carriers", "single", "external_article"]
])("persists %s choices in action order across independent reads", async (field, first, second) => {
  const id = await createLink();
  const actions = [
    { term: first, action: "accept", expected: first },
    { term: second, action: "accept", expected: second },
    { term: first, action: "accept", expected: first },
    { term: first, action: "reject", expected: "" },
    { term: second, action: "accept", expected: second }
  ];
  for (const [index, entry] of actions.entries()) {
    const response = await request(`v2/links/${id}/overrides`, {
      field, term: entry.term, action: entry.action,
      operation_key: `${field}-${index}`, expected_revision: index
    });
    expect(response.status).toBe(200);
    const effective = await request(`v2/links/${id}/selection`, undefined, "GET");
    const body = await effective.json() as { selection: Record<string, string | string[]> };
    expect(body.selection[field]).toEqual(field === "carriers" ? (entry.expected ? [entry.expected] : []) : entry.expected);
  }
  const stored = await env.DB.prepare("SELECT term, action FROM curation_overrides WHERE link_id = ? ORDER BY id")
    .bind(id).all<{ term: string; action: string }>();
  expect(stored.results).toEqual(actions.map(({ term, action }) => ({ term, action })));
});

it("stores an evidence snapshot and reuses the revision for identical bytes", async () => {
  const id = await createLink();
  const first = await request(`v2/links/${id}/evidence`, { snapshot: snapshot() });
  expect(first.status).toBe(200);
  const firstBody = await first.json() as { content_revision: number; content_hash: string; unchanged: boolean };
  expect(firstBody.unchanged).toBe(false);
  const second = await request(`v2/links/${id}/evidence`, { snapshot: snapshot() });
  const secondBody = await second.json() as { content_revision: number; unchanged: boolean };
  expect(secondBody.unchanged).toBe(true);
  expect(secondBody.content_revision).toBe(firstBody.content_revision);
  const changed = await request(`v2/links/${id}/evidence`, { snapshot: snapshot({ blocks: [{ id: "b1", role: "primary", text: "changed body" }] }) });
  const changedBody = await changed.json() as { content_revision: number; unchanged: boolean };
  expect(changedBody.unchanged).toBe(false);
  expect(changedBody.content_revision).toBeGreaterThan(firstBody.content_revision);
});

it("never rewrites a snapshot identity with different bytes (F08)", async () => {
  const id = await createLink();
  await request(`v2/links/${id}/evidence`, { snapshot: snapshot() });
  const stored = await env.DB.prepare("SELECT content_revision, content_hash, payload FROM evidence_snapshots WHERE link_id = ?")
    .bind(id).first<{ content_revision: number; content_hash: string; payload: string }>();
  // A second writer with different bytes that computes the same revision must
  // conflict instead of overwriting the referenced bytes.
  const revision = stored!.content_revision;
  await env.DB.prepare("UPDATE links SET content_revision = ? WHERE id = ?").bind(revision, id).run();
  const conflicting = { ...snapshot(), blocks: [{ id: "b1", role: "primary", text: "different bytes" }] };
  const second = await request(`v2/links/${id}/evidence`, { snapshot: conflicting });
  // The different bytes get a new revision (append-only), and the old bytes stay.
  expect(second.status).toBe(200);
  const rows = await env.DB.prepare("SELECT content_revision, content_hash, payload FROM evidence_snapshots WHERE link_id = ? ORDER BY content_revision")
    .bind(id).all<{ content_revision: number; content_hash: string; payload: string }>();
  expect(rows.results.length).toBe(2);
  expect(rows.results[0].payload).toBe(stored!.payload);
  expect(rows.results[1].content_revision).toBeGreaterThan(revision);
});

it("rejects a malformed snapshot and a duplicate block id", async () => {
  const id = await createLink();
  expect((await request(`v2/links/${id}/evidence`, { snapshot: { blocks: [] } })).status).toBe(400);
  const duplicate = snapshot({ blocks: [{ id: "b1", role: "primary", text: "a" }, { id: "b1", role: "quoted", text: "b" }] });
  expect((await request(`v2/links/${id}/evidence`, { snapshot: duplicate })).status).toBe(400);
});

it("keeps a question spec immutable per id and verifies the caller hash", async () => {
  const spec = { spec_id: "classify-v1", spec_version: 1, questions: { q: { type: "noul" } }, requested_model: "jev" };
  expect((await request("v2/question-specs", spec)).status).toBe(200);
  const replay = await request("v2/question-specs", spec);
  expect((await replay.json() as { unchanged: boolean }).unchanged).toBe(true);
  const changed = await request("v2/question-specs", { ...spec, questions: { q: { type: "choice" } } });
  expect(changed.status).toBe(409);
  expect((await changed.json() as { error: string }).error).toBe("spec_conflict");
  const badHash = await request("v2/question-specs", { ...spec, questions: { other: 1 }, spec_hash: "deadbeef" });
  expect(badHash.status).toBe(409);
  expect((await badHash.json() as { error: string }).error).toBe("spec_hash_mismatch");
});

async function storedSpecHash(): Promise<string> {
  await request("v2/question-specs", { spec_id: "classify-v1", spec_version: 1, questions: {} });
  return (await (await request("v2/question-specs/classify-v1", undefined, "GET")).json() as { spec_hash: string }).spec_hash;
}

async function submitRun(id: number, operationKey: string, answers: unknown = { topic_llm: { type: "noul", noul: 0.93 } }): Promise<number> {
  const specHash = await storedSpecHash();
  const response = await request(`v2/links/${id}/runs`, {
    operation_key: operationKey, spec_id: "classify-v1", spec_hash: specHash, content_revision: 1,
    target_generation: 0, policy_version: "jev-policy-v2",
    policy: { version: "jev-policy-v2", calibrated: false, topic_accept: 0.8, topic_reject: 0.2, choice_accept: 0.65, choice_margin: 0.15, max_display_topics: 3, max_effective_topics: 64 },
    requested_model: "jev-latest", resolved_model: "jev-1.13.0",
    answers, usage: { input_tokens: 12, output_tokens: 4 }, coverage: "complete"
  });
  const body = await response.json() as { run: { id: number } };
  return body.run.id;
}

it("makes run submission idempotent and returns structured answers and policy (F06)", async () => {
  const id = await createLink();
  const runID = await submitRun(id, "run-1");
  const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM classification_runs WHERE link_id = ?").bind(id).first<{ n: number }>();
  expect(rows!.n).toBe(1);
  const listed = await (await request(`v2/links/${id}/runs`, undefined, "GET")).json() as { runs: Array<Record<string, unknown>> };
  expect(listed.runs[0].id).toBe(runID);
  // answers must be an object, not a quoted JSON string.
  expect((listed.runs[0].answers as Record<string, unknown>).topic_llm).toEqual({ type: "noul", noul: 0.93 });
  expect((listed.runs[0].policy as Record<string, unknown>).version).toBe("jev-policy-v2");
  // A replay of the identical logical payload returns the stored run (R2-12).
  const specHash = await storedSpecHash();
  const runBody = {
    operation_key: "run-1", spec_id: "classify-v1", spec_hash: specHash, content_revision: 1,
    target_generation: 0, policy_version: "jev-policy-v2",
    policy: { version: "jev-policy-v2", calibrated: false, topic_accept: 0.8, topic_reject: 0.2, choice_accept: 0.65, choice_margin: 0.15, max_display_topics: 3, max_effective_topics: 64 },
    requested_model: "jev-latest", resolved_model: "jev-1.13.0",
    answers: { topic_llm: { type: "noul", noul: 0.93 } }, usage: { input_tokens: 12, output_tokens: 4 }, coverage: "complete"
  };
  const replay = await request(`v2/links/${id}/runs`, runBody);
  expect((await replay.json() as { replayed: boolean }).replayed).toBe(true);
  // The same key with a different payload is a conflict, not a silent success.
  const conflicting = await request(`v2/links/${id}/runs`, { ...runBody, answers: { topic_llm: { type: "noul", noul: 0.1 } } });
  expect(conflicting.status).toBe(409);
  expect((await conflicting.json() as { error: string }).error).toBe("operation_conflict");
  // The same key from another bookmark is a conflict too, never a replay of the
  // other link's result.
  const other = await createLink();
  const crossLink = await request(`v2/links/${other}/runs`, runBody);
  expect(crossLink.status).toBe(409);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM classification_runs WHERE link_id = ?").bind(id).first<{ n: number }>();
  expect(count!.n).toBe(1);
});

it("rejects a run whose spec hash does not match the stored spec", async () => {
  const id = await createLink();
  await request("v2/question-specs", { spec_id: "classify-v1", spec_version: 1, questions: {} });
  const bad = await request(`v2/links/${id}/runs`, {
    operation_key: "run-bad", spec_id: "classify-v1", spec_hash: "wrong", content_revision: 1,
    target_generation: 0, policy_version: "p", answers: {}
  });
  expect(bad.status).toBe(409);
});

// --- Decisions and human sovereignty (F04/F07/F11) --------------------------

async function submitDecision(id: number, runID: number, automatic: AutomaticView, key: string): Promise<Response> {
  return request(`v2/links/${id}/decisions`, {
    operation_key: key, run_ids: [runID], policy_version: "jev-policy-v2", spec_id: "classify-v1",
    requested_model: "jev-latest", automatic, content_revision: 1
  });
}

it("R3-03: AI-only four topics never acquire human provenance across rebuilds", async () => {
  const id = await createLink();
  const run = await submitRun(id, "ai-only");
  const automatic = { ...emptyAutomatic, topics: ["llm", "eng", "eval", "design"], form: "method", use: "try" };
  expect((await submitDecision(id, run, automatic, "ai-four")).status).toBe(200);
  for (let pass = 0; pass < 2; pass++) {
    await rebuildProjection({ DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" }, id);
    const body = await (await request(`v2/links/${id}/effective`, undefined, "GET")).json() as { effective: { topics: string[]; reviewed: boolean } };
    expect(body.effective.topics).toEqual(automatic.topics);
    expect(body.effective.reviewed).toBe(false);
    expect(await env.DB.prepare("SELECT curation FROM links WHERE id=?").bind(id).first("curation")).toBeNull();
    for (const table of ["curation_overrides", "curation_events", "legacy_curation_history"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE link_id=?`).bind(id).first("n")).toBe(0);
    }
  }
  expect((await submitDecision(id, run, { ...automatic, topics: ["design"] }, "ai-removed")).status).toBe(200);
  const current = await (await request(`v2/links/${id}/selection`, undefined, "GET")).json() as { selection: { topics: string[] }; provenance: { overrides: boolean } };
  expect(current.selection.topics).toEqual(["design"]);
  expect(current.provenance.overrides).toBe(false);
  const legacy = await (await request(`enrichment/jobs/${id}`, undefined, "GET")).json() as { classification: { topics: string[] }; classification_reviewed: boolean };
  expect(legacy.classification.topics).toEqual(["design"]);
  expect(legacy.classification_reviewed).toBe(false);
  for (const [topic, expected] of [["design", 1], ["llm", 0]] as const) {
    const list = await (await request(`enrichment/jobs?topic=${topic}`, undefined, "GET")).json() as { items: Array<{ id: number }> };
    expect(list.items.filter((item) => item.id === id).length).toBe(expected);
  }
});

it("R3-03: reject and reset work on captured legacy curation without a v2 decision", async () => {
  const id = await createLink();
  await env.DB.prepare("UPDATE links SET classification=?,curation=? WHERE id=?")
    .bind(JSON.stringify({ topics: ["llm"], form: "method", use: "try" }), JSON.stringify({ topics: ["eng"], form: "case", use: "quote" }), id).run();
  expect((await request(`v2/links/${id}/overrides`, { field: "topics", term: "eng", action: "reject", operation_key: "legacy-reject", expected_revision: 1 })).status).toBe(200);
  let effective = await (await request(`v2/links/${id}/effective`, undefined, "GET")).json() as { effective: AutomaticView };
  expect(effective.effective.topics).toEqual([]);
  expect((await request(`v2/links/${id}/overrides`, { field: "topics", term: "", action: "reset", operation_key: "legacy-reset", expected_revision: 2 })).status).toBe(200);
  effective = await (await request(`v2/links/${id}/effective`, undefined, "GET")).json() as { effective: AutomaticView };
  expect(effective.effective.topics).toEqual(["llm"]);
  expect(effective.effective.form).toBe("case");
  expect(effective.effective.use).toBe("quote");
});

it.each([false, true])("R3-03: captured legacy complete selection (empty=%s) replaces only expressible dimensions", async (empty) => {
  const id = await createLink();
  // Simulate an older application writing the original column. Migration 0018
  // captures this source without treating later compatibility projections as input.
  const manual = { topics: empty ? [] : ["eng"], form: "", use: "" };
  await env.DB.prepare("UPDATE links SET curation=? WHERE id=?").bind(JSON.stringify(manual), id).run();
  const legacyState = await readSelectionSnapshot({ DB: env.DB } as Env, id);
  const provenance = empty ? legacyState?.state.fields.topics.empty : legacyState?.state.fields.topics.values[0];
  expect(provenance).toMatchObject({ origin: "legacy_unknown", confirmed: false });
  const run = await submitRun(id, "legacy-source");
  expect((await submitDecision(id, run, { ...emptyAutomatic, topics: ["llm"], form: "method", use: "try", content_functions: ["data"] }, "legacy-decision")).status).toBe(200);
  const body = await (await request(`v2/links/${id}/effective`, undefined, "GET")).json() as { effective: AutomaticView };
  expect(body.effective.topics).toEqual(manual.topics);
  expect(body.effective.form).toBe("");
  expect(body.effective.use).toBe("");
  expect(body.effective.content_functions).toEqual(["data"]);
  expect(await env.DB.prepare("SELECT provenance FROM legacy_curation_history WHERE link_id=?").bind(id).first("provenance")).toBe("legacy_unknown");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_overrides WHERE link_id=? AND confirmed=1").bind(id).first("n")).toBe(0);
  // An old-client explicit reset is ordered after its selection and restores
  // the automatic values; projection writes do not create more source events.
  await env.DB.prepare("UPDATE links SET curation=NULL WHERE id=?").bind(id).run();
  await rebuildProjection({ DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" }, id);
  const resetView = await (await request(`v2/links/${id}/effective`, undefined, "GET")).json() as { effective: AutomaticView & { reviewed: boolean } };
  expect(resetView.effective.topics).toEqual(["llm"]);
  expect(resetView.effective.form).toBe("method");
  expect(resetView.effective.use).toBe("try");
  expect(resetView.effective.reviewed).toBe(false);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM legacy_curation_history WHERE link_id=?").bind(id).first("n")).toBe(2);
});

it("R3-03: real historical migration preserves original and ambiguous bytes separately", async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((migration) => migration.name < "0018"));
  const manual = JSON.stringify({ topics: ["eng"], form: "", use: "" });
  for (const id of [1, 2]) {
    await env.DB.prepare("INSERT INTO links(id,url,note,created_at,curation,classification) VALUES(?,?,'','2026-09-22',?,?)")
      .bind(id, `https://x.com/synthetic/status/${id}`, manual, JSON.stringify({ topics: ["llm"], form: "method", use: "try" })).run();
  }
  await env.DB.prepare("INSERT INTO current_projections(link_id,content_revision,effective,updated_at) VALUES(2,1,'{}','2026-09-22')").run();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const history = await env.DB.prepare("SELECT link_id,payload,provenance FROM legacy_curation_history ORDER BY link_id").all();
  expect(history.results).toEqual([
    { link_id: 1, payload: manual, provenance: "legacy_unknown" },
    { link_id: 2, payload: manual, provenance: "ambiguous_projection" }
  ]);
  for (const id of [1, 2]) {
    expect(await env.DB.prepare("SELECT curation FROM links WHERE id=?").bind(id).first("curation")).toBe(manual);
  }
  const original = await (await request("v2/links/1/effective", undefined, "GET")).json() as { effective: AutomaticView };
  expect(original.effective.topics).toEqual(["eng"]);
  expect(original.effective.form).toBe("");
  const ambiguous = await (await request("v2/links/2/effective", undefined, "GET")).json() as { effective: AutomaticView & { reviewed: boolean } };
  expect(ambiguous.effective.topics).toEqual(["llm"]);
  expect(ambiguous.effective.reviewed).toBe(false);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_overrides").first("n")).toBe(0);
  // Private legacy snapshots follow bookmark deletion via the real FK.
  await env.DB.prepare("DELETE FROM links WHERE id=1").run();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM legacy_curation_history WHERE link_id=1").first("n")).toBe(0);
});

it("derives the effective view from the decision and applies four-dimension overrides (F04/F11)", async () => {
  const id = await createLink();
  const runID = await submitRun(id, "run-1");
  const automatic: AutomaticView = {
    ...emptyAutomatic, topics: ["llm", "eval"], content_functions: ["method"], carriers: ["single_post"],
    form: "method", use: "try"
  };
  expect((await submitDecision(id, runID, automatic, "decision-1")).status).toBe(200);
  let body = await (await request(`v2/links/${id}/effective`, undefined, "GET")).json() as { effective: ReturnType<typeof pick> & { reviewed: boolean } };
  expect(body.effective.topics).toEqual(["llm", "eval"]);
  expect(body.effective.carriers).toEqual(["single_post"]);
  // Single-value accept replaces the automatic form.
  expect((await request(`v2/links/${id}/overrides`, { operation_key: "ov-form", field: "form", action: "accept", term: "case" })).status).toBe(200);
  // Per-tag reset restores the automatic topic.
  expect((await request(`v2/links/${id}/overrides`, { operation_key: "ov-reject", field: "topics", action: "reject", term: "eval" })).status).toBe(200);
  expect((await request(`v2/links/${id}/overrides`, { operation_key: "ov-reset", field: "topics", action: "reset", term: "eval" })).status).toBe(200);
  // Fourth-dimension accept accumulates.
  expect((await request(`v2/links/${id}/overrides`, { operation_key: "ov-data", field: "content_functions", action: "accept", term: "data" })).status).toBe(200);
  body = await (await request(`v2/links/${id}/effective`, undefined, "GET")).json() as { effective: ReturnType<typeof effectiveView> };
  expect(pick(body.effective as unknown as ReturnType<typeof effectiveView>)).toEqual({
    topics: ["llm", "eval"], content_functions: ["method", "data"], carriers: ["single_post"],
    affordances: [], form: "case", use: "try", entities: []
  });
  // The selection read derives from the same effective view, not a parallel row.
  const selection = await (await request(`v2/links/${id}/selection`, undefined, "GET")).json() as { selection: Record<string, unknown> };
  expect(selection.selection.topics).toEqual(["llm", "eval"]);
  expect(selection.selection.content_functions).toEqual(["method", "data"]);
  expect(selection.selection.form).toBe("case");
});

it("keeps a rejection across a policy replay that re-proposes the same tag (F07)", async () => {
  const id = await createLink();
  const runID = await submitRun(id, "run-1");
  const automatic: AutomaticView = { ...emptyAutomatic, topics: ["llm", "eval"] };
  await submitDecision(id, runID, automatic, "decision-1");
  expect((await request(`v2/links/${id}/overrides`, { operation_key: "ov-1", field: "topics", action: "reject", term: "llm" })).status).toBe(200);
  // A replay appends a new decision with the same automatic proposal; the human
  // rejection must survive because the server re-applies the override log.
  const replay = await submitDecision(id, runID, automatic, "decision-2");
  expect(replay.status).toBe(200);
  const replayBody = await replay.json() as { effective: { topics: string[] } };
  expect(replayBody.effective.topics).toEqual(["eval"]);
  // A delayed replay against a run that is no longer current must not apply.
  await env.DB.prepare("UPDATE links SET content_revision = content_revision + 1 WHERE id = ?").bind(id).run();
  const stale = await submitDecision(id, runID, automatic, "decision-3");
  expect(stale.status).toBe(409);
  expect((await stale.json() as { error: string }).error).toBe("run_stale");
});

it("rejects a decision that references an unknown, foreign or mismatched run (F07)", async () => {
  const id = await createLink();
  const other = await createLink();
  const otherRun = await submitRun(other, "other-run");
  const foreign = await submitDecision(id, otherRun, emptyAutomatic, "decision-foreign");
  expect(foreign.status).toBe(409);
  expect((await foreign.json() as { error: string }).error).toBe("unknown_run");
  const unknown = await submitDecision(id, 99999, emptyAutomatic, "decision-unknown");
  expect(unknown.status).toBe(409);
  const mine = await submitRun(id, "run-mine");
  const mismatch = await request(`v2/links/${id}/decisions`, {
    operation_key: "decision-model", run_ids: [mine], policy_version: "jev-policy-v2",
    requested_model: "some-other-model", automatic: emptyAutomatic
  });
  expect(mismatch.status).toBe(409);
  expect((await mismatch.json() as { error: string }).error).toBe("run_model_mismatch");
});

it("makes the override CAS atomic and rejects a stale expected revision (F08)", async () => {
  const id = await createLink();
  const [a, b] = await Promise.all([
    request(`v2/links/${id}/overrides`, { operation_key: "ov-a", field: "topics", action: "accept", term: "llm", expected_revision: 0 }),
    request(`v2/links/${id}/overrides`, { operation_key: "ov-b", field: "topics", action: "accept", term: "eval", expected_revision: 0 })
  ]);
  const statuses = [a.status, b.status].sort();
  expect(statuses).toEqual([200, 409]);
  const revision = await env.DB.prepare("SELECT personal_revision FROM links WHERE id = ?").bind(id).first<{ personal_revision: number }>();
  expect(revision!.personal_revision).toBe(1);
  const overrides = await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_overrides WHERE link_id = ?").bind(id).first<{ n: number }>();
  const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_events WHERE link_id = ?").bind(id).first<{ n: number }>();
  expect(overrides!.n).toBe(1);
  expect(events!.n).toBe(1);
  const conflict = a.status === 409 ? a : b;
  expect((await conflict.json() as { error: string }).error).toBe("revision_conflict");
});

it("does not create an override for an invalid action and keeps why/status clean", async () => {
  const id = await createLink();
  const response = await request(`v2/links/${id}/overrides`, { operation_key: "ov-empty", field: "topics", action: "accept", term: "" });
  expect(response.status).toBe(400);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_overrides WHERE link_id = ?").bind(id).first<{ n: number }>();
  expect(count!.n).toBe(0);
});

it("accepts the legacy singular field name and stores the canonical one", async () => {
  const id = await createLink();
  expect((await request(`v2/links/${id}/overrides`, { operation_key: "ov-topic", field: "topic", action: "accept", term: "llm" })).status).toBe(200);
  const row = await env.DB.prepare("SELECT field FROM curation_overrides WHERE operation_key = ?").bind("ov-topic").first<{ field: string }>();
  expect(row!.field).toBe("topics");
});

it("completes a v2 classification into runs, decision and the unified selection read (F05)", async () => {
  const id = await createLink();
  const { default: taxonomy } = await import("../src/taxonomy.json");
  await env.DB.prepare("UPDATE links SET original_text = 'A guide to evaluating LLMs' WHERE id = ?").bind(id).run();
  await request(`v2/links/${id}/evidence`, { snapshot: snapshot({ blocks: [{ id: "b1", role: "primary", text: "A guide to evaluating LLMs" }] }) });
  // Activate an authoritative v2 target for this consumer.
  const target = await request("enrichment/classifications/target", {
    spec_id: "classify-v1", spec_hash: await storedSpecHash(), taxonomy_version: taxonomy.version,
    policy_version: "jev-policy-v2", requested_model: "jev-latest", protocol: "v2"
  });
  expect(target.status).toBe(200);
  const caps = {
    protocol: "v2", spec_ids: ["classify-v1"], taxonomy_versions: [taxonomy.version],
    policy_versions: ["jev-policy-v2"], models: ["jev-latest"]
  };
  const claimed = await request("enrichment/classifications/claim", caps);
  expect(claimed.status).toBe(200);
  const job = await claimed.json() as { id: number; lease_token: string; revision: number; target_generation: number };
  const completionBody = {
    ...job, operation_key: `v2-complete-${id}`,
    result: {
      model: "jev-1.13.0", requested_model: "jev-latest", policy_version: "jev-policy-v2",
      policy: { version: "jev-policy-v2", calibrated: false },
      spec_id: "classify-v1", spec_hash: await storedSpecHash(),
      answers: { topic_llm: { type: "noul", noul: 0.93 }, form: { type: "choice", choice: "method", probabilities: { method: 0.9, case: 0.1 } } },
      usage: { input_tokens: 42, output_tokens: 7 }, coverage: "complete", evidence_coverage: "complete",
      automatic: { topics: ["llm"], content_functions: ["method"], carriers: [], affordances: [], form: "method", use: "", entities: [],
        assessment: { version: 1, incomplete: [], decisions: [{ dimension: "topics", term_id: "llm", verdict: "accepted", probability: 0.93, reason: "above bound" }] } },
      classification: { topics: ["llm"], form: "method", use: "try", uncertainty: false,
        taxonomy_version: taxonomy.version, why_suggestion: "", entities: [], discarded_tags: [] }
    }
  };
  const complete = await request(`enrichment/classifications/${id}/complete`, completionBody);
  expect(complete.status).toBe(200);
  const runs = await (await request(`v2/links/${id}/runs`, undefined, "GET")).json() as { runs: Array<Record<string, unknown>> };
  expect(runs.runs.length).toBe(1);
  expect(runs.runs[0].policy_version).toBe("jev-policy-v2");
  expect((runs.runs[0].usage as Record<string, unknown>).input_tokens).toBe(42);
  const decision = await (await request(`v2/links/${id}/decisions`, undefined, "GET")).json() as { automatic: AutomaticView; policy: Record<string, unknown> };
  expect(decision.automatic.topics).toEqual(["llm"]);
  expect(decision.automatic.assessment).toEqual(completionBody.result.automatic.assessment);
  expect(decision.policy.version).toBe("jev-policy-v2");
  const effective = await (await request(`v2/links/${id}/effective`, undefined, "GET")).json() as { effective: ReturnType<typeof effectiveView>; projected: boolean };
  expect(effective.projected).toBe(true);
  expect(effective.effective.topics).toEqual(["llm"]);
  // The legacy selection read derives from the same decision: no second truth.
  const selection = await (await request(`v2/links/${id}/selection`, undefined, "GET")).json() as { selection: Record<string, unknown>; v1_projection: { topics: string[] } };
  expect(selection.selection.topics).toEqual(["llm"]);
  expect(selection.v1_projection.topics).toEqual(["llm"]);
  // A human reject then a new decision keeps the rejection.
  await request(`v2/links/${id}/overrides`, { operation_key: "ov-llm", field: "topics", action: "reject", term: "llm" });
  const after = await (await request(`v2/links/${id}/selection`, undefined, "GET")).json() as { selection: Record<string, unknown> };
  expect(after.selection.topics).toEqual([]);
  // Idempotent replay of the identical completion does not create a second run.
  const replay = await request(`enrichment/classifications/${id}/complete`, completionBody);
  expect(replay.status).toBe(200);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM classification_runs WHERE link_id = ?").bind(id).first<{ n: number }>();
  expect(count!.n).toBe(1);
  // The same key with a different payload is a hard conflict, not a silent
  // second write.
  const conflicting = await request(`enrichment/classifications/${id}/complete`, {
    ...completionBody, result: { ...completionBody.result, model: "different-model" }
  });
  expect(conflicting.status).toBe(409);
  expect((await conflicting.json() as { error: string }).error).toBe("operation_conflict");
});

it("requires the enricher token for the v2 API", async () => {
  const id = await createLink();
  expect((await request(`v2/links/${id}/effective`, undefined, "GET", "app")).status).toBe(401);
});

it("cascades deletes across the domain tables", async () => {
  const id = await createLink();
  await request(`v2/links/${id}/evidence`, { snapshot: snapshot() });
  await request(`v2/links/${id}/overrides`, { operation_key: "ov-1", field: "topics", action: "accept", term: "llm" });
  await env.DB.prepare("DELETE FROM links WHERE id = ?").bind(id).run();
  for (const table of ["evidence_snapshots", "curation_overrides", "curation_events", "current_projections", "classification_runs", "classification_decisions"]) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE link_id = ?`).bind(id).first<{ n: number }>();
    expect(row!.n, `${table} should cascade`).toBe(0);
  }
});

async function entityIdentity(id: number) {
  expect((await request(`v2/links/${id}/evidence`, { snapshot: snapshot() })).status).toBe(200);
  const stored = await (await request(`v2/links/${id}/evidence`, undefined, "GET")).json() as {
    id: number; content_revision: number; content_hash: string;
  };
  return { evidence_snapshot_id: stored.id, content_revision: stored.content_revision, content_hash: stored.content_hash };
}

// --- Entity lifecycle, evidence requests and proposal application (B05/B09) --

it("keeps entity lifecycle states distinct and protects a newer success (B09-T04)", async () => {
  const id = await createLink();
  const identity = await entityIdentity(id);
  const first = await request(`v2/links/${id}/entity-state`, {
    ...identity, operation_key: "entity-1", state: "completed_nonempty", entities: ["acme", "widget"]
  });
  expect(first.status).toBe(200);
  // A later failed run must not clear the completed value.
  const failed = await request(`v2/links/${id}/entity-state`, {
    ...identity, operation_key: "entity-2", state: "failed", entities: []
  });
  expect(failed.status).toBe(200);
  expect((await failed.json() as { status: string }).status).toBe("ignored_stale");
  const view = await (await request(`v2/links/${id}/entities`, undefined, "GET")).json() as {
    state: string; automatic: string[]; entities: string[];
  };
  expect(view.state).toBe("completed_nonempty");
  expect(view.automatic).toEqual(["acme", "widget"]);
  // A stale content revision is refused.
  await env.DB.prepare("UPDATE links SET content_revision = content_revision + 1 WHERE id = ?").bind(id).run();
  const stale = await request(`v2/links/${id}/entity-state`, {
    ...identity, operation_key: "entity-3", state: "completed_empty", entities: []
  });
  expect(stale.status).toBe(409);
  expect((await stale.json() as { error: string }).error).toBe("run_stale");
});

it("lets a human correct entities through the same override log (B05-T10)", async () => {
  const id = await createLink();
  const identity = await entityIdentity(id);
  await request(`v2/links/${id}/entity-state`, {
    ...identity, operation_key: "entity-1", state: "completed_nonempty", entities: ["acme"]
  });
  const accepted = await request(`v2/links/${id}/entities`, {
    operation_key: "entity-human-1", action: "accept", term: "widget", expected_revision: 0
  });
  expect(accepted.status).toBe(200);
  const rejected = await request(`v2/links/${id}/entities`, {
    operation_key: "entity-human-2", action: "reject", term: "acme", expected_revision: 1
  });
  expect(rejected.status).toBe(200);
  const view = await (await request(`v2/links/${id}/entities`, undefined, "GET")).json() as { entities: string[]; human: string[] };
  expect(view.entities).toEqual(["widget"]);
  expect(view.human).toEqual(["widget"]);
});

it("de-duplicates evidence requests and records the bounded outcome (B09-T05)", async () => {
  const id = await createLink();
  const first = await request(`v2/links/${id}/evidence-requests`, {
    scope: "external_link", dedupe_key: `evidence-${id}-1`, budget: { max_bytes: 100000 }
  });
  expect(first.status).toBe(200);
  const replay = await request(`v2/links/${id}/evidence-requests`, {
    scope: "external_link", dedupe_key: `evidence-${id}-1`, budget: { max_bytes: 100000 }
  });
  expect((await replay.json() as { replayed: boolean }).replayed).toBe(true);
  const requestID = (await first.json() as { id: string }).id;
  const decided = await request(`v2/evidence-requests/${requestID}`, { status: "completed", result: { blocks: 1 } });
  expect(decided.status).toBe(200);
  const twice = await request(`v2/evidence-requests/${requestID}`, { status: "completed" });
  expect(twice.status).toBe(409);
  const list = await (await request(`v2/links/${id}/evidence-requests`, undefined, "GET")).json() as { requests: Array<{ status: string }> };
  expect(list.requests[0].status).toBe("completed");
});

it("applies an approved display-only rename without changing semantics (B05-T11)", async () => {
  const created = await request("v2/taxonomy/proposals", {
    kind: "rename_label", dimension: "topics", term_id: "llm", payload: { label: "大语言模型" }
  });
  expect(created.status).toBe(200);
  const proposalID = (await created.json() as { id: string }).id;
  const premature = await request(`v2/taxonomy/proposals/${proposalID}/apply`, {});
  expect(premature.status).toBe(409);
  expect((await premature.json() as { error: string }).error).toBe("not_approved");
  await request(`v2/taxonomy/proposals/${proposalID}/decision`, { decision: "approved" });
  const applied = await request(`v2/taxonomy/proposals/${proposalID}/apply`, {});
  expect(applied.status).toBe(200);
  expect((await applied.json() as { display_only: boolean }).display_only).toBe(true);
  const vocabulary = await (await request("v2/taxonomy", undefined, "GET")).json() as {
    topics: Array<{ id: string; label: string; display_overridden?: boolean }>;
  };
  const llm = vocabulary.topics.find((term) => term.id === "llm");
  expect(llm?.label).toBe("大语言模型");
  expect(llm?.display_overridden).toBe(true);
  // A semantic proposal is refused in place.
  const semantic = await request("v2/taxonomy/proposals", {
    kind: "add_term", dimension: "topics", term_id: "new_topic", payload: { label: "新主题" }
  });
  const semanticID = (await semantic.json() as { id: string }).id;
  await request(`v2/taxonomy/proposals/${semanticID}/decision`, { decision: "approved" });
  const refused = await request(`v2/taxonomy/proposals/${semanticID}/apply`, {});
  expect(refused.status).toBe(409);
  expect((await refused.json() as { error: string }).error).toBe("requires_new_version");
});

it("generates a proposal only from repeated human corrections and never applies it (B09-T11)", async () => {
  const id = await createLink();
  // Two corrections are not enough evidence.
  for (const index of [1, 2]) {
    await request(`v2/links/${id}/entities`, { operation_key: `entity-gen-${index}`, action: "accept", term: "widget" });
  }
  const early = await request("v2/taxonomy/proposals/generate", {});
  expect((await early.json() as { created: unknown[] }).created.length).toBe(0);
  await request(`v2/links/${id}/entities`, { operation_key: "entity-gen-3", action: "accept", term: "widget" });
  const generated = await request("v2/taxonomy/proposals/generate", {});
  const created = (await generated.json() as { created: Array<{ id: string; term: string }>; applied: boolean }).created;
  expect(created.length).toBe(1);
  expect(created[0].term).toBe("widget");
  // Re-running is idempotent while the proposal is pending.
  const again = await request("v2/taxonomy/proposals/generate", {});
  expect((await again.json() as { created: unknown[] }).created.length).toBe(0);
  // Approval still cannot apply a semantic change in place.
  await request(`v2/taxonomy/proposals/${created[0].id}/decision`, { decision: "approved" });
  const applied = await request(`v2/taxonomy/proposals/${created[0].id}/apply`, {});
  expect(applied.status).toBe(409);
  expect((await applied.json() as { error: string }).error).toBe("requires_new_version");
});

// --- R2-01/R2-02/R2-12: transaction guard and write identity ----------------

it("R2-01: a failed completion guard leaves no success run, decision or operation", async () => {
  const id = await createLink();
  const { default: taxonomy } = await import("../src/taxonomy.json");
  await env.DB.prepare("UPDATE links SET original_text = 'source body' WHERE id = ?").bind(id).run();
  await request(`v2/links/${id}/evidence`, { snapshot: snapshot({ blocks: [{ id: "b1", role: "primary", text: "source body" }] }) });
  await request("enrichment/classifications/target", {
    spec_id: "classify-v1", spec_hash: await storedSpecHash(), taxonomy_version: taxonomy.version,
    policy_version: "jev-policy-v2", requested_model: "jev-latest", protocol: "v2"
  });
  const caps = { protocol: "v2", spec_ids: ["classify-v1"], taxonomy_versions: [taxonomy.version], policy_versions: ["jev-policy-v2"], models: ["jev-latest"] };
  const job = await (await request("enrichment/classifications/claim", caps)).json() as Record<string, unknown>;
  // The source changes after the lease: the bound input identity no longer
  // matches the link. The completion body deliberately omits input_revision and
  // content_revision so the preflight passes and the in-transaction guard is
  // what rejects it.
  await env.DB.prepare("UPDATE links SET original_text = 'changed source body' WHERE id = ?").bind(id).run();
  const completionBody = {
    ...job, operation_key: `r2-01-${id}`,
    result: {
      model: "jev-1.13.0", requested_model: "jev-latest", policy_version: "jev-policy-v2",
      spec_id: "classify-v1", spec_hash: await storedSpecHash(),
      answers: { topic_llm: { type: "noul", noul: 0.9 } }, coverage: "complete",
      automatic: { topics: ["llm"], content_functions: [], carriers: [], affordances: [], form: "", use: "", entities: [] },
      classification: { topics: ["llm"], form: "method", use: "try", uncertainty: false,
        taxonomy_version: taxonomy.version, why_suggestion: "", entities: [], discarded_tags: [] }
    }
  };
  const first = await request(`enrichment/classifications/${id}/complete`, completionBody);
  expect(first.status).toBe(409);
  const replay = await request(`enrichment/classifications/${id}/complete`, completionBody);
  expect(replay.status).toBe(409);
  // No success history and no operation record exist.
  for (const table of ["classification_runs", "classification_decisions", "classification_operations"]) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE link_id = ?`).bind(id).first<{ n: number }>();
    expect(row!.n, `${table} must stay empty`).toBe(0);
  }
  const link = await env.DB.prepare("SELECT classification FROM links WHERE id = ?").bind(id).first<{ classification: string | null }>();
  expect(link!.classification).toBeNull();
  // The input change re-arms the job instead of completing it; it is not a
  // success and it holds no lease.
  const jobRow = await env.DB.prepare("SELECT status, lease_token FROM classification_jobs WHERE link_id = ?").bind(id)
    .first<{ status: string; lease_token: string | null }>();
  expect(jobRow!.status).toBe("pending");
  expect(jobRow!.lease_token).toBeNull();
});

it("R2-02: the claim binds the evidence identity and the run records it", async () => {
  const id = await createLink();
  const { default: taxonomy } = await import("../src/taxonomy.json");
  await env.DB.prepare("UPDATE links SET original_text = 'source body' WHERE id = ?").bind(id).run();
  const evidence = snapshot({ blocks: [{ id: "b1", role: "primary", text: "source body" }] });
  await request(`v2/links/${id}/evidence`, { snapshot: evidence });
  await request("enrichment/classifications/target", {
    spec_id: "classify-v1", spec_hash: await storedSpecHash(), taxonomy_version: taxonomy.version,
    policy_version: "jev-policy-v2", requested_model: "jev-latest", protocol: "v2"
  });
  const caps = { protocol: "v2", spec_ids: ["classify-v1"], taxonomy_versions: [taxonomy.version], policy_versions: ["jev-policy-v2"], models: ["jev-latest"] };
  const job = await (await request("enrichment/classifications/claim", caps)).json() as {
    content_revision: number; evidence_hash: string; evidence_snapshot_id: number | null; lease_token: string; revision: number;
  };
  expect(job.content_revision).toBe(2); // create (1) + source update (2)
  expect(job.evidence_hash).toBe(await contentHash(evidence));
  expect(job.evidence_snapshot_id).toBeGreaterThan(0);
  const link = await env.DB.prepare("SELECT content_revision FROM links WHERE id = ?").bind(id).first<{ content_revision: number }>();
  expect(job.content_revision).toBe(link!.content_revision);
  // A completion that echoes a different content revision is rejected as input
  // changed before it can be stored.
  const completion = {
    ...job, operation_key: `r2-02-${id}`, content_revision: 1,
    result: {
      model: "jev-1.13.0", requested_model: "jev-latest", policy_version: "jev-policy-v2",
      spec_id: "classify-v1", spec_hash: await storedSpecHash(),
      answers: { topic_llm: { type: "noul", noul: 0.9 } }, coverage: "complete",
      automatic: { topics: ["llm"], content_functions: [], carriers: [], affordances: [], form: "", use: "", entities: [] },
      classification: { topics: ["llm"], form: "method", use: "try", uncertainty: false,
        taxonomy_version: taxonomy.version, why_suggestion: "", entities: [], discarded_tags: [] }
    }
  };
  const rejected = await request(`enrichment/classifications/${id}/complete`, completion);
  expect(rejected.status).toBe(409);
  expect((await rejected.json() as { error: string }).error).toBe("input_changed");
  // The valid completion records the bound revision, not a newer one.
  const accepted = await request(`enrichment/classifications/${id}/complete`, { ...completion, content_revision: job.content_revision });
  expect(accepted.status).toBe(200);
  const run = await env.DB.prepare("SELECT content_revision FROM classification_runs WHERE link_id = ?").bind(id).first<{ content_revision: number }>();
  expect(run!.content_revision).toBe(job.content_revision);
});

it("R2-12: the same operation key with a different payload or link conflicts", async () => {
  const id = await createLink();
  const other = await createLink();
  const first = await request(`v2/links/${id}/overrides`, {
    operation_key: "r2-12-override", field: "topics", term: "llm", action: "accept"
  });
  expect(first.status).toBe(200);
  // Same key, different action on the same link.
  const differentAction = await request(`v2/links/${id}/overrides`, {
    operation_key: "r2-12-override", field: "topics", term: "llm", action: "reject"
  });
  expect(differentAction.status).toBe(409);
  expect((await differentAction.json() as { error: string }).error).toBe("operation_conflict");
  // Same key from another bookmark.
  const crossLink = await request(`v2/links/${other}/overrides`, {
    operation_key: "r2-12-override", field: "topics", term: "llm", action: "accept"
  });
  expect(crossLink.status).toBe(409);
  const overrides = await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_overrides").first<{ n: number }>();
  expect(overrides!.n).toBe(1);
});

it("R2-08: the entity success baseline appears in the effective view", async () => {
  const id = await createLink();
  const identity = await entityIdentity(id);
  await request(`v2/links/${id}/entity-state`, {
    ...identity, operation_key: `r2-08-${id}`, state: "completed_nonempty", entities: ["acme"]
  });
  const view = await (await request(`v2/links/${id}/effective`, undefined, "GET")).json() as {
    effective: { entities: string[] }; projected: boolean;
  };
  expect(view.effective.entities).toEqual(["acme"]);
  // A human reject removes it; a reset restores the entity baseline.
  await request(`v2/links/${id}/entities`, { operation_key: `r2-08-r-${id}`, action: "reject", term: "acme" });
  const rejected = await (await request(`v2/links/${id}/effective`, undefined, "GET")).json() as { effective: { entities: string[] } };
  expect(rejected.effective.entities).toEqual([]);
  await request(`v2/links/${id}/entities`, { operation_key: `r2-08-x-${id}`, action: "reset", term: "acme" });
  const restored = await (await request(`v2/links/${id}/effective`, undefined, "GET")).json() as { effective: { entities: string[] } };
  expect(restored.effective.entities).toEqual(["acme"]);
});


it("confirms identical concurrent and lost-response curation with the same operation receipt", async () => {
  const id = await createLink();
  const body = { field: "topics", term: "llm", action: "accept", operation_key: "android-first", expected_revision: 0 };
  const responses = await Promise.all(Array.from({ length: 4 }, () => request(`v2/links/${id}/overrides`, body)));
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, field: body.field, term: body.term, action: body.action, operation_key: body.operation_key, revision: 1 });
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_events WHERE link_id=?").bind(id).first("n")).toBe(1);
  expect((await request(`v2/links/${id}/overrides`, { ...body, term: "eng", operation_key: "web-second", expected_revision: 1 })).status).toBe(200);
  const replay = await request(`v2/links/${id}/overrides`, body);
  expect(await replay.json()).toMatchObject({ id, operation_key: "android-first", revision: 1, replayed: true });
  // Own predecessor acknowledgement only advances to 1; the Web edit at 2
  // remains a real conflict for the next offline action.
  const next = await request(`v2/links/${id}/overrides`, { ...body, action: "reject", operation_key: "android-next", expected_revision: 1 });
  expect(next.status).toBe(409);
  expect(await next.json()).toMatchObject({ error: "revision_conflict", revision: 2 });
  expect(await env.DB.prepare("SELECT personal_revision FROM links WHERE id=?").bind(id).first("personal_revision")).toBe(2);
});


it("allows only authenticated App curation reads and actions on the Android paths", async () => {
  const id = await createLink();
  for (const path of ["v2-taxonomy", `bookmarks/${id}/v2-selection`]) {
    expect((await request(path, undefined, "GET", "app")).status).toBe(200);
    expect((await request(path, undefined, "GET", "wrong")).status).toBe(401);
    expect((await request(path, {}, "POST", "app")).status).toBe(405);
  }
  const body = { field: "topics", term: "llm", action: "accept", operation_key: "app-owned", expected_revision: 0 };
  for (const expected_revision of [undefined, null, "0", -1, 0.5]) {
    expect((await request(`bookmarks/${id}/v2-override`, { ...body, expected_revision }, "POST", "app")).status).toBe(400);
  }
  expect((await request(`bookmarks/${id}/v2-override`, body, "POST", "wrong")).status).toBe(401);
  const first = await request(`bookmarks/${id}/v2-override`, body, "POST", "app");
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ operation_key: "app-owned", revision: 1, replayed: false });
  expect(await (await request(`bookmarks/${id}/v2-override`, body, "POST", "app")).json()).toMatchObject({ operation_key: "app-owned", revision: 1, replayed: true });
  expect((await request(`bookmarks/${id}/v2-selection`, {}, "PATCH", "app")).status).toBe(405);
  for (const path of ["v2/question-specs", `v2/links/${id}/runs`, `v2/links/${id}/evidence-requests`, "v2/taxonomy/proposals"]) {
    expect((await request(path, {}, "POST", "app")).status).toBe(401);
  }
  expect((await request(`bookmarks/${id}/v2-override`, { ...body, field: "why", operation_key: "invalid" }, "POST", "app")).status).toBe(400);
  const view = await (await request(`bookmarks/${id}/v2-selection`, undefined, "GET", "app")).json() as { revision: number; selection: { topics: string[] } };
  expect(view.revision).toBe(1);
  expect(view.selection.topics).toEqual(["llm"]);
});


it("returns the independent automatic baseline with the effective App selection", async () => {
  const id = await createLink();
  await env.DB.prepare("UPDATE links SET classification=? WHERE id=?")
    .bind(JSON.stringify({ topics: ["llm"], form: "method", use: "try", uncertainty: false }), id).run();
  const post = (field: string, term: string, action: string, revision: number) => request(`bookmarks/${id}/v2-override`,
    { field, term, action, operation_key: `baseline-${revision}`, expected_revision: revision }, "POST", "app");
  expect((await post("topics", "", "set_empty", 0)).status).toBe(200);
  expect((await post("topics", "eng", "accept", 1)).status).toBe(200);
  const read = async () => (await request(`bookmarks/${id}/v2-selection?include_automatic=1`, undefined, "GET", "app")).json() as Promise<{
    revision: number; selection: { topics: string[] }; automatic: { topics: string[]; form: string }
  }>;
  const before = await read();
  // Strict old readers never opted in to the new response field.
  for (const path of [`bookmarks/${id}/v2-selection`, `v2/links/${id}/selection`]) {
    const old = await (await request(path, undefined, "GET", path.startsWith("v2/") ? "internal" : "app")).json() as Record<string, unknown>;
    expect(old).not.toHaveProperty("automatic");
    expect(old.selection).toEqual(before.selection);
  }
  expect(before.selection.topics).toEqual(["eng"]);
  expect(before.automatic).toEqual({ topics: ["llm"], content_functions: [], carriers: [], affordances: [], form: "method", use: "try" });
  expect((await post("topics", "", "reset", 2)).status).toBe(200);
  const after = await read();
  expect(after.selection.topics).toEqual(["llm"]);
  expect(after.automatic).toEqual(before.automatic);
  expect(after.revision).toBe(3);
});
