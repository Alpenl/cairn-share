import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { canonicalJSON, semanticSpecHash } from "../src/domain";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
async function call(path: string, body?: unknown, method = "POST", token = "internal") {
  return worker.fetch(new Request(`https://test.example/api/${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }),
    { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function fixture() {
  const response = await call("links", { url: "https://x.com/test/status/42", note: "private note" }, "POST", "app");
  const { id } = await response.json() as { id: number };
  const question = { id: "topic_llm", kind: "noul", dimension: "topic", term_id: "llm", instructions: "About language models?", criteria: { true: "Substantive", false: "Incidental" } };
  const spec = { spec_id: "provenance-test", spec_version: 1, questions: [question] };
  const specHash = await semanticSpecHash(spec);
  expect((await call("v2/question-specs", { ...spec, spec_hash: specHash })).status).toBe(200);
  const link = await env.DB.prepare("SELECT content_revision FROM links WHERE id=?").bind(id).first<{ content_revision: number }>();
  const state = canonicalJSON({ primary: "Synthetic language model text", context: null, coverage: "complete", truncated: false });
  const hash = await digest(state);
  const questionHash = await digest(canonicalJSON({ id: question.id, kind: question.kind, instructions: question.instructions, criteria: question.criteria }));
  const usage = { input_tokens: 10, output_tokens: 1 };
  const raw = {
    metadata_version: 1, spec_id: spec.spec_id, spec_hash: specHash, taxonomy_version: "fixture",
    requested_model: "jev-1.13.0", resolved_model: "jev-1.13.0", alias_drift: false,
    judgments: { topic_llm: { question_id: "topic_llm", kind: "noul", dimension: "topic", term_id: "llm", noul: 0.9 } },
    coverage: "complete", evidence_coverage: "complete", wire_state: state, evidence_hash: hash,
    question_hashes: { topic_llm: questionHash }, batch_semantics: "single-request", usage,
    calls: [{ request_hash: "1".repeat(64), state_hash: hash, question_ids: ["topic_llm"], requested_model: "jev-1.13.0", resolved_model: "jev-1.13.0", usage, usage_missing: false, http_status: 200, latency_ms: 5 }],
    reused: [] as string[], reused_from: {} as Record<string, number>
  };
  const body = { operation_key: "provenance-first", content_revision: link!.content_revision, spec_id: spec.spec_id, spec_hash: specHash,
    target_generation: 1, requested_model: raw.requested_model, resolved_model: raw.resolved_model,
    policy_version: "fixture", policy: {}, answers: { topic_llm: { type: "noul", noul: 0.9 } }, usage, coverage: "complete", raw_judgments: raw };
  return { id, body };
}

it("persists exact wire identity and validates a stored reuse source", async () => {
  const { id, body } = await fixture();
  const first = await call(`v2/links/${id}/runs`, body);
  expect(first.status).toBe(200);
  const changedPolicy = structuredClone(body); changedPolicy.policy = { version: "different" };
  expect((await call(`v2/links/${id}/runs`, changedPolicy)).status).toBe(409);
  const { run } = await first.json() as { run: { id: number } };
  const reused = structuredClone(body); reused.operation_key = "provenance-reused";
  reused.raw_judgments.calls = []; reused.raw_judgments.reused = ["topic_llm"];
  reused.raw_judgments.reused_from = { topic_llm: run.id };
  reused.raw_judgments.usage = { input_tokens: 0, output_tokens: 0 }; reused.usage = reused.raw_judgments.usage;
  expect((await call(`v2/links/${id}/runs`, reused)).status).toBe(200);
  const stored = await (await call(`v2/links/${id}/runs`, undefined, "GET")).json() as { runs: Array<{ raw_judgments: unknown; source_hash: unknown; evidence_snapshot_id: unknown }> };
  expect(stored.runs[0].raw_judgments).toEqual(body.raw_judgments);
  expect(stored.runs[1].raw_judgments).toEqual(reused.raw_judgments);
  expect(stored.runs[0].source_hash).toBeNull();
  expect(stored.runs[0].evidence_snapshot_id).toBeNull();
  // A run belonging to another bookmark cannot certify this one's answer.
  const other = await call("links", { url: "https://x.com/test/status/43" }, "POST", "app");
  const otherId = (await other.json() as { id: number }).id;
  reused.operation_key = "cross-link-reuse";
  expect((await call(`v2/links/${otherId}/runs`, reused)).status).toBe(400);
});

it("rejects state, question, answer, model and call provenance mismatches", async () => {
  const { id, body } = await fixture();
  const mutations = [
    (b: typeof body) => { b.raw_judgments.wire_state += " "; },
    (b: typeof body) => { b.raw_judgments.question_hashes.topic_llm = "0".repeat(64); },
    (b: typeof body) => { b.raw_judgments.judgments.topic_llm.noul = 0.1; },
    (b: typeof body) => { b.raw_judgments.resolved_model = "jev-other"; },
    (b: typeof body) => { b.raw_judgments.calls = []; },
    (b: typeof body) => { b.usage = { input_tokens: 99, output_tokens: 1 }; },
    (b: typeof body) => { b.raw_judgments.calls[0].usage_missing = true; },
    (b: typeof body) => { b.raw_judgments.evidence_coverage = "truncated"; },
    (b: typeof body) => { b.raw_judgments.calls[0].question_ids.push("topic_llm"); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(body); mutate(changed);
    const response = await call(`v2/links/${id}/runs`, changed);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_run_provenance" });
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM classification_runs").first<{ n: number }>();
  expect(count!.n).toBe(0);
});

it("keeps absent legacy provenance unknown instead of backfilling identity", async () => {
  const { id, body } = await fixture();
  const { raw_judgments: _raw, ...legacy } = body;
  expect((await call(`v2/links/${id}/runs`, legacy)).status).toBe(200);
  const stored = await (await call(`v2/links/${id}/runs`, undefined, "GET")).json() as { runs: Array<{ raw_judgments: unknown; source_hash: unknown }> };
  expect(stored.runs[0].raw_judgments).toBeNull(); expect(stored.runs[0].source_hash).toBeNull();
  expect((await call(`v2/links/${id}/runs`, legacy)).status).toBe(200);
});
