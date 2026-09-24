import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { canonicalJSON, EMPTY_AUTOMATIC, semanticSpecHash } from "../src/domain";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
async function call(path: string, body?: unknown, db = env.DB, method = "POST", token = "internal") {
  return worker.fetch(new Request(`https://test.example/api/${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }),
    { DB: db, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}
async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function setup() {
  const created = await call("links", { url: "https://x.com/fixture/status/912" }, env.DB, "POST", "app");
  const { id } = await created.json() as { id: number };
  const question = { id: "topic_llm", kind: "noul", dimension: "topic", term_id: "llm", instructions: "About language models?", criteria: { true: "Substantive", false: "Incidental" } };
  const spec = { spec_id: "decision-test", spec_version: 1, questions: [question] };
  const specHash = await semanticSpecHash(spec);
  expect((await call("v2/question-specs", { ...spec, spec_hash: specHash })).status).toBe(200);
  const source = await call(`v2/links/${id}/evidence`, { snapshot: {
    blocks: [{ id: "primary", role: "primary", text: "Synthetic language model text" }], retrieval: "manual",
    fetched_at: "2026-09-22T00:00:00Z", truncation: { truncated: false }
  } });
  expect(source.status).toBe(200);
  const snapshot = await env.DB.prepare("SELECT id,content_hash,content_revision FROM evidence_snapshots WHERE link_id=?").bind(id)
    .first<{ id: number; content_hash: string; content_revision: number }>();
  const state = canonicalJSON({ primary: "Synthetic language model text", context: null, coverage: "complete", truncated: false });
  const hash = await digest(state);
  const questionHash = await digest(canonicalJSON({ id: question.id, kind: question.kind, instructions: question.instructions, criteria: question.criteria }));
  const usage = { input_tokens: 10, output_tokens: 1 };
  const raw = {
    metadata_version: 1, spec_id: spec.spec_id, spec_hash: specHash, taxonomy_version: "fixture",
    requested_model: "jev-latest", resolved_model: "jev-1.13.0", alias_drift: true,
    judgments: { topic_llm: { question_id: "topic_llm", kind: "noul", dimension: "topic", term_id: "llm", noul: 0.9 } },
    coverage: "complete", evidence_coverage: "complete", wire_state: state, evidence_hash: hash,
    question_hashes: { topic_llm: questionHash }, batch_semantics: "single-request", usage,
    calls: [{ request_hash: "1".repeat(64), state_hash: hash, question_ids: ["topic_llm"], requested_model: "jev-latest", resolved_model: "jev-1.13.0", usage, usage_missing: false, http_status: 200, latency_ms: 5 }]
  };
  const runBody = { operation_key: "run-1", content_revision: snapshot!.content_revision, spec_id: spec.spec_id, spec_hash: specHash,
    target_generation: 0, requested_model: raw.requested_model, resolved_model: raw.resolved_model,
    evidence_snapshot_id: snapshot!.id, source_hash: snapshot!.content_hash,
    policy_version: "fixture", policy: {}, answers: { topic_llm: { type: "noul", noul: 0.9 } }, usage, coverage: "complete", raw_judgments: raw };
  const ids: number[] = [];
  for (const key of ["run-1", "run-2"]) {
    const response = await call(`v2/links/${id}/runs`, { ...runBody, operation_key: key });
    expect(response.status).toBe(200);
    ids.push((await response.json() as { run: { id: number } }).run.id);
  }
  const body = { operation_key: "decision-1", run_ids: ids, policy_version: "fixture-replay", policy: { topic_accept: 0.8 },
    spec_id: spec.spec_id, spec_hash: specHash, resolved_model: raw.resolved_model,
    content_revision: snapshot!.content_revision, expected_revision: 0,
    automatic: { ...EMPTY_AUTOMATIC, topics: ["llm"] } };
  return { id, ids, body, runBody };
}

// Only scheduling is injected; every read/write and transaction uses real D1.
function beforeBatch(n: number, action: () => Promise<void>) {
  let calls = 0;
  return new Proxy(env.DB, { get(target, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      if (++calls === n) await action();
      return target.batch(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
async function count(table: string) { return env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n"); }
async function assertProjection(id: number, topics: string[]) {
  const effective = await (await call(`v2/links/${id}/effective`, undefined, env.DB, "GET")).json() as { effective: { topics: string[] } };
  expect(effective.effective.topics).toEqual(topics);
  const projection = await env.DB.prepare("SELECT effective FROM current_projections WHERE link_id=?").bind(id).first<string>("effective");
  expect(JSON.parse(projection!).topics).toEqual(topics);
  expect(JSON.parse((await env.DB.prepare("SELECT topics FROM link_selections_v2 WHERE link_id=?").bind(id).first<string>("topics"))!)).toEqual(topics);
}

it("R3-12: personal CAS applies after the last preflight; no decision or references survive", async () => {
  const { id, body } = await setup();
  const db = beforeBatch(1, async () => {
    expect((await call(`v2/links/${id}/overrides`, { operation_key: "human", field: "topics", action: "reject", term: "llm", expected_revision: 0 })).status).toBe(200);
  });
  const response = await call(`v2/links/${id}/decisions`, body, db);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "revision_conflict", revision: 1 });
  expect(await count("classification_decisions")).toBe(0);
  expect(await count("classification_decision_runs")).toBe(0);
  await assertProjection(id, []);
});

it.each(["content", "target", "secondary-model", "secondary-coverage", "secondary-status", "secondary-source", "secondary-wire", "secondary-spec", "secondary-generation"])(
  "R3-12: %s changes after preflight invalidate every decision write", async (change) => {
    const { id, ids, body } = await setup();
    const db = beforeBatch(1, async () => {
      if (change === "content") await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=?").bind(id).run();
      else if (change === "target") await env.DB.prepare("UPDATE classification_target_state SET generation=generation+1 WHERE id=1").run();
      else {
        const expressions: Record<string, string> = { "secondary-model": "resolved_model='jev-other'", "secondary-coverage": "coverage='partial'",
          "secondary-status": "status='partial'", "secondary-source": "source_hash='wrong'", "secondary-wire": "raw_judgments=json_set(raw_judgments,'$.evidence_hash','wrong')",
          "secondary-spec": "spec_hash='wrong'", "secondary-generation": "target_generation=100" };
        await env.DB.prepare(`UPDATE classification_runs SET ${expressions[change]} WHERE id=?`).bind(ids[1]).run();
      }
    });
    const response = await call(`v2/links/${id}/decisions`, body, db);
    expect(response.status).toBe(409);
    expect(await count("classification_decisions")).toBe(0);
    expect(await count("classification_decision_runs")).toBe(0);
    expect(await count("current_projections")).toBe(0);
  });

it("R3-12: actual model governs mixing; all compatible aliases and references survive storage", async () => {
  const { id, ids: originalIDs, body, runBody } = await setup();
  const variant = async (key: string, requested: string, resolved: string) => {
    const next = structuredClone(runBody);
    next.operation_key = key; next.requested_model = requested; next.resolved_model = resolved;
    next.raw_judgments.requested_model = requested; next.raw_judgments.resolved_model = resolved;
    next.raw_judgments.alias_drift = requested !== resolved;
    next.raw_judgments.calls[0].requested_model = requested; next.raw_judgments.calls[0].resolved_model = resolved;
    const response = await call(`v2/links/${id}/runs`, next);
    expect(response.status).toBe(200);
    return (await response.json() as { run: { id: number } }).run.id;
  };
  const different = await variant("different-model", "jev-latest", "jev-other");
  const { resolved_model: _resolved, ...unpinned } = body;
  const mixed = await call(`v2/links/${id}/decisions`, { ...unpinned, run_ids: [originalIDs[0], different] });
  expect(mixed.status).toBe(409);
  expect(await mixed.json()).toMatchObject({ error: "run_identity_mismatch" });
  const compatible = await variant("different-alias", "jev-preview", "jev-1.13.0");
  const ids = [originalIDs[0], compatible];
  const response = await call(`v2/links/${id}/decisions`, { ...body, run_ids: [...ids].reverse() });
  expect(response.status).toBe(200);
  const accepted = await response.json() as { decision_id: number; run_ids: number[] };
  expect(accepted.run_ids).toEqual(ids);
  const refs = await env.DB.prepare("SELECT run_id FROM classification_decision_runs WHERE decision_id=? ORDER BY ordinal").bind(accepted.decision_id).all();
  expect(refs.results.map(r => r.run_id)).toEqual(ids);
  const latest = await (await call(`v2/links/${id}/decisions`, undefined, env.DB, "GET")).json();
  expect(latest).toMatchObject({ id: accepted.decision_id, run_ids: ids, run_references_complete: true, expected_personal_revision: 0 });
  await assertProjection(id, ["llm"]);
  // Even a secondary reference protects its run from retention deletion.
  await expect(env.DB.prepare("DELETE FROM classification_runs WHERE id=?").bind(ids[1]).run()).rejects.toThrow();
  expect((await call(`links/${id}`, undefined, env.DB, "DELETE", "app")).status).toBe(204);
  for (const table of ["classification_decisions", "classification_decision_runs", "classification_runs", "evidence_snapshots"]) expect(await count(table)).toBe(0);
});

it("R3-12: incomplete and unknown multi-run inputs cannot be certified; legacy singleton stays unknown", async () => {
  const { id, ids, body } = await setup();
  await env.DB.prepare("UPDATE classification_runs SET coverage='partial' WHERE id=?").bind(ids[1]).run();
  const partial = await call(`v2/links/${id}/decisions`, body);
  expect(await partial.json()).toMatchObject({ error: "run_incomplete" });
  await env.DB.prepare("UPDATE classification_runs SET coverage='complete',raw_judgments=NULL,source_hash=NULL,evidence_snapshot_id=NULL").run();
  const unknown = await call(`v2/links/${id}/decisions`, body);
  expect(await unknown.json()).toMatchObject({ error: "run_identity_unknown" });
  expect((await call(`v2/links/${id}/decisions`, { ...body, run_ids: [ids[0]] })).status).toBe(200);
  expect(await env.DB.prepare("SELECT source_hash FROM classification_runs WHERE id=?").bind(ids[0]).first("source_hash")).toBeNull();
});

it("R3-12: exact operation confirms after later human/source/target changes; changed payload conflicts", async () => {
  const { id, body } = await setup();
  const first = await call(`v2/links/${id}/decisions`, body);
  const accepted = await first.json() as { decision_id: number };
  expect(first.status).toBe(200);
  expect((await call(`v2/links/${id}/overrides`, { operation_key: "human", field: "topics", action: "reject", term: "llm", expected_revision: 0 })).status).toBe(200);
  await env.DB.prepare("UPDATE links SET content_revision=content_revision+1 WHERE id=?").bind(id).run();
  await env.DB.prepare("UPDATE classification_target_state SET generation=generation+1 WHERE id=1").run();
  const replay = await call(`v2/links/${id}/decisions`, body);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ decision_id: accepted.decision_id, run_ids: body.run_ids, revision: 0, replayed: true, effective: { topics: [] } });
  for (const changed of [{ expected_revision: 1 }, { content_revision: 2 }, { spec_hash: "changed" }, { resolved_model: "changed" }, { automatic: EMPTY_AUTOMATIC }]) {
    const conflict = await call(`v2/links/${id}/decisions`, { ...body, ...changed });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "operation_conflict" });
  }
  expect(await count("classification_decisions")).toBe(1);
  expect(await count("classification_decision_runs")).toBe(2);
});

it("R3-12: a concurrent exact retry confirms one stored operation", async () => {
  const { id, body } = await setup();
  const db = beforeBatch(1, async () => { expect((await call(`v2/links/${id}/decisions`, body)).status).toBe(200); });
  const response = await call(`v2/links/${id}/decisions`, body, db);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ replayed: true });
  expect(await count("classification_decisions")).toBe(1);
  expect(await count("classification_decision_runs")).toBe(2);
});

it.each(["decision", "human"])("R3-12: projection delayed by a newer %s converges to current effective state", async (change) => {
  const { id, body } = await setup();
  const db = beforeBatch(2, async () => {
    if (change === "decision") {
      expect((await call(`v2/links/${id}/decisions`, { ...body, operation_key: "newer", automatic: { ...EMPTY_AUTOMATIC, topics: ["eval"] } })).status).toBe(200);
    } else expect((await call(`v2/links/${id}/overrides`, { operation_key: "human", field: "topics", action: "reject", term: "llm", expected_revision: 0 })).status).toBe(200);
  });
  expect((await call(`v2/links/${id}/decisions`, body, db)).status).toBe(200);
  await assertProjection(id, change === "decision" ? ["eval"] : []);
  const filtered = await call(`enrichment/jobs?topic=${change === "decision" ? "eval" : "llm"}`, undefined, env.DB, "GET");
  expect(filtered.status).toBe(200);
  const result = await filtered.json() as { items: Array<{ id: number }> };
  expect(result.items.some(link => link.id === id)).toBe(change === "decision");
});

it("R3-12: malformed and unbounded references are rejected before any write", async () => {
  const { id, ids, body } = await setup();
  for (const bad of [{ run_ids: [] }, { run_ids: [ids[0], ids[0]] }, { run_ids: [0] }, { run_ids: [1.1] },
    { run_ids: Array.from({ length: 65 }, (_, i) => i + 1) }, { expected_revision: "0" }, { content_revision: -1 }]) {
    expect((await call(`v2/links/${id}/decisions`, { ...body, ...bad })).status).toBe(400);
  }
  expect(await count("classification_decisions")).toBe(0);
});


it("R3-12: migration preserves known legacy references without inventing a complete set", async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, env.TEST_MIGRATIONS.findIndex(m => m.name.startsWith("0021_"))));
  const { id, ids, body } = await setup();
  const legacyHash = await digest(canonicalJSON({ link_id: id, run_ids: ids, policy_version: body.policy_version,
    policy: body.policy, automatic: body.automatic, spec_id: body.spec_id, requested_model: null }));
  await env.DB.prepare(`INSERT INTO classification_decisions(link_id,run_id,content_revision,policy_version,policy,automatic,operation_key,created_at,payload_hash)
    VALUES (?,?,?,?,?,?,?,?,?)`).bind(id, ids[0], body.content_revision, body.policy_version, JSON.stringify(body.policy), JSON.stringify(body.automatic), body.operation_key, "2026-09-22", legacyHash).run();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const latest = await (await call(`v2/links/${id}/decisions`, undefined, env.DB, "GET")).json();
  expect(latest).toMatchObject({ run_ids: [ids[0]], run_references_complete: false, expected_personal_revision: null });
  const replay = await call(`v2/links/${id}/decisions`, body);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ run_ids: [ids[0]], run_references_complete: false, revision: null, replayed: true });
  // An old executable can continue writing its known singleton after migration.
  await env.DB.prepare(`INSERT INTO classification_decisions(link_id,run_id,content_revision,policy_version,policy,automatic,operation_key,created_at,payload_hash)
    VALUES (?,?,?,?,?,?,?,?,?)`).bind(id, ids[1], body.content_revision, body.policy_version, "{}", JSON.stringify(body.automatic), "old-writer", "2026-09-22", "").run();
  const refs = await env.DB.prepare("SELECT run_id FROM classification_decision_runs ORDER BY decision_id").all();
  expect(refs.results.map(row => row.run_id)).toEqual(ids);
});

it.each(["value","assessment"])("objective replay rejects personal opposition in %s before writing",async(where)=>{
 const {id,body}=await setup();
 const automatic=where==="value"?{...body.automatic,use:"contra"}:{...body.automatic,assessment:{version:1,decisions:[{dimension:"use",value:"contra",candidate:"contra",verdict:"accepted",probability:.99,reason:"unsafe old objective decision"}],incomplete:[]}};
 expect((await call(`v2/links/${id}/decisions`,{...body,automatic})).status).toBe(400);
 expect(await count("classification_decisions")).toBe(0);expect(await count("classification_decision_runs")).toBe(0);
 expect(await count("current_projections")).toBe(0);
 expect((await call(`v2/links/${id}/decisions`,body)).status).toBe(200);
});
