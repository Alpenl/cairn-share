import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { canonicalJSON, semanticSpecHash } from "../src/domain";
import { validCandidateAutomatic } from "../src/candidate-manifest";
import full from "./fixtures/go-current-full-v1.json";
import reuse from "./fixtures/go-current-reuse-v1.json";
import bounded from "./fixtures/go-current-candidate-v2.json";
import { archiveOldRunPayloads } from "../src/run-archive";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const capabilities = { "X-Cairn-Tag-System": "1", "X-Cairn-Topic-Granularity": "1", "X-Cairn-Content-Functions": "1",
  "X-Cairn-Candidate-Manifest": "2", "X-Cairn-Classification-Budget": "1", "X-Cairn-Classification-Gate": "1" };
const settings = () => ({ DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
function call(path: string, body?: unknown, token = "internal", headers: Record<string, string> = capabilities) {
  return worker.fetch(new Request(`https://test/api/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), settings());
}
async function action(id: number, actions: unknown[]) {
  const state = await (await call(`bookmarks/${id}/tags`, undefined, "app")).json() as any;
  const response = await call(`bookmarks/${id}/tags`, { operation_key: crypto.randomUUID(), expected_revision: state.revision,
    expected_decision_id: state.decision_id, expected_content_revision: state.content_revision, actions }, "app");
  expect(response.status, await response.clone().text()).toBe(200);
}
async function seed(fixture: any) {
  const created = await call("links", { url: fixture.input.url, note: "private human note" }, "app");
  const id = (await created.json() as { id: number }).id;
  await env.DB.prepare("UPDATE links SET original_text=?,why='human rationale',curation_status='kept' WHERE id=?")
    .bind(fixture.input.original_text, id).run();
  const response = await call(`v2/links/${id}/evidence`, { snapshot: {
    blocks: [{ id: "primary", role: "primary", text: fixture.input.original_text }], retrieval: "manual",
    fetched_at: "2026-10-02T00:00:00Z", truncation: { truncated: false }
  } });
  expect(response.status, await response.clone().text()).toBe(200);
  return id;
}
async function queued(id: number, spec: any, result: any) {
  expect(await semanticSpecHash(spec)).toBe(result.spec_hash);
  const registered = await call("v2/question-specs", { ...spec, spec_hash: result.spec_hash });
  expect(registered.status, await registered.clone().text()).toBe(200);
  const target = { spec_id: result.spec_id, spec_hash: result.spec_hash, taxonomy_version: result.classification.taxonomy_version,
    policy_version: result.policy_version, requested_model: result.requested_model, protocol: "v2" };
  expect((await call("enrichment/classifications/target", target)).status).toBe(200);
  const handshake = await call("enrichment/classifications/target");
  expect(handshake.headers.get("X-Cairn-Candidate-Manifest")).toBe("2");
  const response = await call("enrichment/classifications/claim", { protocol: "v2", spec_ids: [target.spec_id],
    taxonomy_versions: [target.taxonomy_version], policy_versions: [target.policy_version], models: [target.requested_model] });
  expect(response.status, await response.clone().text()).toBe(200);
  const job = await response.json() as any; expect(job.id).toBe(id);
  return { ...job, operation_key: crypto.randomUUID(), result };
}
async function complete(id: number, body: any) {
  const response = await call(`enrichment/classifications/${id}/complete`, body);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("X-Cairn-Candidate-Manifest")).toBe("2");
  const row = await env.DB.prepare("SELECT * FROM classification_runs WHERE link_id=? ORDER BY id DESC LIMIT 1").bind(id).first<any>();
  expect(JSON.parse(row.raw_judgments)).toEqual(body.result.raw_judgments);
  expect(JSON.parse(row.answers)).toEqual(body.result.answers);
  expect(row.wire_evidence_hash).toBe(body.result.raw_judgments.evidence_hash);
  return row;
}

it("completes a genuine 55-question Go fullspec and preserves material, human facts and exact specific memberships", async () => {
  const id = await seed(full);
  await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,source,confirmed,revision,operation_key,created_at)
    VALUES(?,'topics','life','accept','human',1,1,'historical-human-life','2026-09-30')`).bind(id).run();
  await env.DB.prepare("UPDATE links SET personal_revision=1 WHERE id=?").bind(id).run();
  await action(id, [{ action: "reject", tag_ref: "system/topics/portrait_photography" }]);
  const material = await env.DB.prepare("SELECT original_text,note,why,personal_revision,content_revision FROM links WHERE id=?").bind(id).first();
  const facts = (await env.DB.prepare("SELECT * FROM curation_overrides WHERE link_id=? ORDER BY id").bind(id).all()).results;
  const body = await queued(id, full.spec, full.result);
  expect(full.spec.questions).toHaveLength(55); expect(full.result.raw_judgments.calls).toHaveLength(2);
  await complete(id, body); await complete(id, body);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_runs WHERE link_id=?").bind(id).first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT original_text,note,why,personal_revision,content_revision FROM links WHERE id=?").bind(id).first()).toEqual(material);
  expect((await env.DB.prepare("SELECT * FROM curation_overrides WHERE link_id=? ORDER BY id").bind(id).all()).results).toEqual(facts);
  const state = await (await call(`bookmarks/${id}/tags`, undefined, "app")).json() as any;
  expect(state.selection.topics).not.toContain("portrait_photography"); expect(state.selection.topics).toContain("life");
  const counts = await (await call("tag-counts?topic_refinements=portrait_photography", undefined, "app")).json() as any;
  expect(counts.total).toBe(0);
});

it("completes the current taxonomy by exactly reusing 31 old provider judgments and one 24-question call", async () => {
  const id = await seed(reuse);
  const previous = await complete(id, await queued(id, reuse.previous_spec, reuse.previous_result));
  const result = structuredClone(reuse.result);
  for (const question of result.raw_judgments.reused) (result.raw_judgments.reused_from as Record<string, number>)[question] = previous.id;
  await action(id, [{ action: "accept", tag_ref: "system/topics/portrait_photography" }]);
  const before = await env.DB.prepare("SELECT original_text,note,why,content_revision,personal_revision FROM links WHERE id=?").bind(id).first();
  const row = await complete(id, await queued(id, reuse.spec, result));
  expect(result.raw_judgments.calls).toHaveLength(1); expect(result.raw_judgments.calls[0].question_ids).toHaveLength(24);
  expect(result.raw_judgments.reused).toHaveLength(31);
  for (const question of result.raw_judgments.reused) {
    expect((result.raw_judgments.judgments as any)[question]).toEqual((reuse.previous_result.raw_judgments.judgments as any)[question]);
    expect((result.raw_judgments.question_hashes as any)[question]).toBe((reuse.previous_result.raw_judgments.question_hashes as any)[question]);
  }
  expect(row.target_generation).not.toBe(previous.target_generation);
  expect(await env.DB.prepare("SELECT original_text,note,why,content_revision,personal_revision FROM links WHERE id=?").bind(id).first()).toEqual(before);
});

it("completes honest bounded32 coverage, retains omitted specifics as unknown and preserves human acceptance of an omitted term", async () => {
  const id = await seed(bounded), body = await queued(id, bounded.spec, bounded.result);
  expect(bounded.result.raw_judgments.candidate_manifest.selected_question_ids).toHaveLength(32);
  const omitted = bounded.result.raw_judgments.candidate_manifest.omitted[0].term_id;
  await action(id, [{ action: "accept", tag_ref: `system/topics/${omitted}` }]);
  const withoutCap = { ...capabilities } as Record<string, string>; delete withoutCap["X-Cairn-Candidate-Manifest"];
  expect((await call(`enrichment/classifications/${id}/complete`, body, "internal", withoutCap)).status).toBe(409);
  await complete(id, body);
  const stored = await (await call(`bookmarks/${id}/tags`, undefined, "app")).json() as any;
  expect(stored.automatic.topics).not.toContain(omitted); expect(stored.selection.topics).toContain(omitted);
  const unknown = bounded.result.automatic.assessment.decisions.filter(d => ["not_recalled", "candidate_limit"].includes(d.reason));
  expect(unknown).toHaveLength(23); expect(unknown.every(d => !("probability" in d))).toBe(true);
  const malformed = structuredClone(bounded.result.automatic) as any;
  malformed.topics.push(omitted); expect(validCandidateAutomatic(bounded.result.raw_judgments, malformed)).toBe(false);
});

it("keeps metadata2 unknown constraints and wire identities on controlled policy replay after payload archival", async () => {
  const id = await seed(bounded); const first = await complete(id, await queued(id, bounded.spec, bounded.result));
  expect((await call(`enrichment/classifications/${id}/retry`, {})).status).toBe(200);
  const second = await complete(id, await queued(id, bounded.spec, bounded.result));
  await env.DB.prepare("UPDATE classification_runs SET created_at='2025-01-01' WHERE id=?").bind(first.id).run();
  expect(await archiveOldRunPayloads(settings(), "2026-01-01", "2026-10-02")).toBe(1);
  expect(await env.DB.prepare("SELECT raw_judgments FROM classification_runs WHERE id=?").bind(first.id).first("raw_judgments")).toBeNull();
  expect(await env.DB.prepare("SELECT wire_evidence_hash FROM classification_runs WHERE id=?").bind(first.id).first("wire_evidence_hash")).toBe(bounded.result.raw_judgments.evidence_hash);
  const target = await (await call("enrichment/classifications/target")).json() as any;
  const state = await (await call(`v2/links/${id}/selection`)).json() as any;
  const policy = structuredClone(bounded.result.policy);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(policy)));
  const policy_hash = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const body = { operation_key: "cold-bounded-replay", run_ids: [first.id], policy_version: policy.version, policy, policy_hash,
    automatic: bounded.result.automatic, expected_revision: state.revision, content_revision: first.content_revision,
    expected_target_generation: target.target.generation, spec_id: first.spec_id, spec_hash: first.spec_hash,
    requested_model: first.requested_model, resolved_model: first.resolved_model };
  const omitted = bounded.result.raw_judgments.candidate_manifest.omitted[0].term_id;
  const forged = structuredClone(body) as any; forged.automatic.topics.push(omitted);
  expect((await call(`v2/links/${id}/policy-replays`, forged)).status).toBe(400);
  const replay = await call(`v2/links/${id}/policy-replays`, body);
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect((await replay.json() as any).policy_hash).toBe(policy_hash);
  expect(first.id).not.toBe(second.id);
}, 30_000);
