import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { canonicalJSON, contentHash, effectiveView, objectivePayload, resolveField, type EvidenceSnapshot, type Override } from "../src/domain";

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
  // Adding note-like data must not change the objective hash.
  expect(objectivePayload({ ...snapshot(), ...{ note: "personal" } } as EvidenceSnapshot)).toBe(objectivePayload(snapshot()));
});

// --- Override resolution (pure) --------------------------------------------

it("distinguishes reject, set-empty and reset", () => {
  const automatic = ["llm", "eval"];
  const base: Override = { field: "topic", term: "", action: "reset", source: "human", confirmed: true, revision: 1 };
  expect(resolveField(automatic, [{ ...base, action: "reject", term: "llm" }]).value).toEqual(["eval"]);
  // A policy replay re-introducing llm must not revive a rejected tag.
  const rejected = resolveField(["llm", "eval"], [{ ...base, action: "reject", term: "llm" }]);
  expect(rejected.value).toEqual(["eval"]);
  expect(resolveField(automatic, [{ ...base, action: "set_empty" }])).toEqual({ value: [], empty: true });
  expect(resolveField(automatic, [{ ...base, action: "reset" }])).toEqual({ value: automatic, empty: false });
});

it("marks a legacy override group as reviewed but not confirmed", () => {
  const view = effectiveView({ topics: [], form: "", use: "", entities: [] }, [
    { field: "topic", term: "eng", action: "accept", source: "legacy_unknown", confirmed: false, revision: 1 }
  ]);
  expect(view.reviewed).toBe(true);
  expect(view.topics).toEqual(["eng"]);
});

// --- Internal v2 API --------------------------------------------------------

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
  // A changed body advances the revision.
  const changed = await request(`v2/links/${id}/evidence`, { snapshot: snapshot({ blocks: [{ id: "b1", role: "primary", text: "changed body" }] }) });
  const changedBody = await changed.json() as { content_revision: number; unchanged: boolean };
  expect(changedBody.unchanged).toBe(false);
  expect(changedBody.content_revision).toBeGreaterThan(firstBody.content_revision);
});

it("rejects a malformed snapshot and a duplicate block id", async () => {
  const id = await createLink();
  expect((await request(`v2/links/${id}/evidence`, { snapshot: { blocks: [] } })).status).toBe(400);
  const duplicate = snapshot({ blocks: [{ id: "b1", role: "primary", text: "a" }, { id: "b1", role: "quoted", text: "b" }] });
  expect((await request(`v2/links/${id}/evidence`, { snapshot: duplicate })).status).toBe(400);
});

it("keeps a question spec immutable per id", async () => {
  const spec = { spec_id: "classify-v1", spec_version: 1, questions: { topics: true }, requested_model: "jev" };
  expect((await request("v2/question-specs", spec)).status).toBe(200);
  const replay = await request("v2/question-specs", spec);
  expect((await replay.json() as { unchanged: boolean }).unchanged).toBe(true);
  const changed = await request("v2/question-specs", { ...spec, questions: { topics: false } });
  expect(changed.status).toBe(409);
  expect((await changed.json() as { error: string }).error).toBe("spec_conflict");
});

it("makes run submission idempotent by operation key", async () => {
  const id = await createLink();
  await request("v2/question-specs", { spec_id: "classify-v1", spec_version: 1, questions: {} });
  const spec = await (await request("v2/question-specs/classify-v1", undefined, "GET")).json() as { spec_hash: string };
  const run = {
    operation_key: "run-1", spec_id: "classify-v1", spec_hash: spec.spec_hash, content_revision: 1,
    target_generation: 0, policy_version: "jev-tags-v1", answers: { topics: ["llm"], form: "method", use: "try" }
  };
  const first = await request(`v2/links/${id}/runs`, run);
  expect(first.status).toBe(200);
  const firstBody = await first.json() as { replayed: boolean; run: { id: number } };
  expect(firstBody.replayed).toBe(false);
  const replay = await request(`v2/links/${id}/runs`, run);
  const replayBody = await replay.json() as { replayed: boolean; run: { id: number } };
  expect(replayBody.replayed).toBe(true);
  expect(replayBody.run.id).toBe(firstBody.run.id);
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

it("applies overrides with CAS and keeps reject across a policy replay", async () => {
  const id = await createLink();
  await request("v2/question-specs", { spec_id: "classify-v1", spec_version: 1, questions: {} });
  const spec = await (await request("v2/question-specs/classify-v1", undefined, "GET")).json() as { spec_hash: string };
  await request(`v2/links/${id}/runs`, {
    operation_key: "run-1", spec_id: "classify-v1", spec_hash: spec.spec_hash, content_revision: 1,
    target_generation: 0, policy_version: "p", answers: { topics: ["llm", "eval"], form: "method", use: "try" }
  });
  const reject = await request(`v2/links/${id}/overrides`, { operation_key: "ov-1", field: "topic", action: "reject", term: "llm" });
  expect(reject.status).toBe(200);
  const conflict = await request(`v2/links/${id}/overrides`, { operation_key: "ov-2", field: "topic", action: "accept", term: "eng", expected_revision: 0 });
  expect(conflict.status).toBe(409);
  expect((await conflict.json() as { error: string }).error).toBe("revision_conflict");
  // Replay with the same signals: reject must persist.
  const effective = await request(`v2/links/${id}/effective`, undefined, "GET");
  const body = await effective.json() as { effective: { topics: string[] } };
  expect(body.effective.topics).toEqual(["eval"]);
  // Idempotent replay of the same override.
  const replay = await request(`v2/links/${id}/overrides`, { operation_key: "ov-1", field: "topic", action: "reject", term: "llm" });
  expect((await replay.json() as { replayed: boolean }).replayed).toBe(true);
});

it("does not create an override for a why/status edit", async () => {
  const id = await createLink();
  const response = await request(`v2/links/${id}/overrides`, { operation_key: "ov-empty", field: "topic", action: "accept", term: "" });
  expect(response.status).toBe(400);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM curation_overrides WHERE link_id = ?").bind(id).first<{ n: number }>();
  expect(count!.n).toBe(0);
});

it("requires the enricher token for the v2 API", async () => {
  const id = await createLink();
  expect((await request(`v2/links/${id}/effective`, undefined, "GET", "app")).status).toBe(401);
});

it("cascades deletes across the domain tables", async () => {
  const id = await createLink();
  await request(`v2/links/${id}/evidence`, { snapshot: snapshot() });
  await request(`v2/links/${id}/overrides`, { operation_key: "ov-1", field: "topic", action: "accept", term: "llm" });
  await env.DB.prepare("DELETE FROM links WHERE id = ?").bind(id).run();
  for (const table of ["evidence_snapshots", "curation_overrides", "curation_events", "current_projections", "classification_runs"]) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE link_id = ?`).bind(id).first<{ n: number }>();
    expect(row!.n, `${table} should cascade`).toBe(0);
  }
});
