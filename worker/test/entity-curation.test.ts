import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(() => vi.restoreAllMocks());
async function request(path: string, method = "GET", body?: unknown, token = "app") {
  return worker.fetch(new Request("https://test.example" + path, { method,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}
async function create() {
  const response = await request("/api/links", "POST", { url: "https://example.com/entity-curation" });
  expect(response.status).toBe(201);
  return (await response.json() as { id: number }).id;
}
type EntityState = { status: string; automatic: string[]; revision: number;
  values: { term: string; origin: string; confirmed: boolean }[]; empty: { origin: string; confirmed: boolean } | null };
async function read(id: number) {
  const response = await request("/api/bookmarks/" + id + "/v2-selection?include_state=1&include_automatic=1");
  expect(response.status).toBe(200);
  return await response.json() as { revision: number; state: { entities: EntityState } };
}
async function source(id: number, text = "Acme Tool") {
  expect((await request("/api/v2/links/" + id + "/evidence", "POST", { snapshot: {
    blocks: [{ id: "source", role: "primary", text }], retrieval: "manual",
    fetched_at: "2026-10-17T00:00:00Z", truncation: { truncated: false },
  } }, "internal")).status).toBe(200);
  const saved = await request("/api/v2/links/" + id + "/evidence", "GET", undefined, "internal");
  const snapshot = await saved.json() as { id: number; content_revision: number; content_hash: string };
  return { evidence_snapshot_id: snapshot.id, content_revision: snapshot.content_revision, content_hash: snapshot.content_hash };
}
async function edit(id: number, action: string, term: string, key: string) {
  const current = await read(id);
  const response = await request("/api/bookmarks/" + id + "/v2-override", "POST",
    { operation_key: key, expected_revision: current.revision, field: "entities", action, term });
  expect(response.status).toBe(200);
  expect((await response.json() as { revision: number }).revision).toBe(current.revision + 1);
  return await read(id);
}

it("allows every stored-length entity name through the authenticated App path without creating an AI result", async () => {
  const id = await create();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("human curation must stay local"));
  const name = "🙂".repeat(60); // 120 UTF-16 code units, the existing entity-state bound.
  const after = await edit(id, "accept", name, "long-name");
  expect(after.state.entities.status).toBe("not_run");
  expect(after.state.entities.automatic).toEqual([]);
  expect(after.state.entities.values).toEqual([{ term: name, origin: "human", confirmed: true, revision: 1 }]);
  const replay = await request("/api/bookmarks/" + id + "/v2-override", "POST",
    { operation_key: "long-name", expected_revision: 0, field: "entities", action: "accept", term: name });
  expect(replay.status).toBe(200);
  expect((await replay.json() as { replayed: boolean }).replayed).toBe(true);
  expect((await read(id)).revision).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM entity_states").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM classification_provider_attempts").first("n")).toBe(0);
  expect((await request("/api/bookmarks/" + id + "/v2-override", "POST",
    { operation_key: "too-long", expected_revision: 1, field: "entities", action: "accept", term: "x".repeat(121) })).status).toBe(400);
  expect((await request("/api/bookmarks/" + id + "/v2-override", "POST",
    { operation_key: "denied", expected_revision: 1, field: "entities", action: "reject", term: name }, "wrong")).status).toBe(401);
  await edit(id, "reject", name, "remove-long-name");
  expect((await read(id)).state.entities.values).toEqual([]);
  const ascii = await edit(id, "accept", "x".repeat(120), "ascii-long-name");
  expect(ascii.state.entities.values.map(value => value.term)).toEqual(["x".repeat(120)]);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps independent AI status and baseline through manual empty resets and new source revisions", async () => {
  const id = await create();
  const identity = await source(id);
  expect((await request("/api/v2/links/" + id + "/entity-state", "POST", {
    ...identity, operation_key: "synthetic-ai-result", state: "completed_nonempty", entities: ["Acme", "Tool"],
  }, "internal")).status).toBe(200);
  const aiRevision = (await read(id)).state.entities.revision;
  for (const [index, [action, term, names]] of [
    ["accept", "Manual", ["Acme", "Tool", "Manual"]],
    ["reject", "Acme", ["Tool", "Manual"]],
    ["set_empty", "", []],
    ["reset", "Acme", ["Acme"]],
    ["reset", "Manual", ["Acme"]],
    ["reset", "", ["Acme", "Tool"]],
  ].entries()) {
    const result = await edit(id, action as string, term as string, "manual-" + index);
    expect(result.state.entities.values.map(value => value.term).sort()).toEqual([...(names as string[])].sort());
    expect(result.state.entities.status).toBe("completed_nonempty");
    expect(result.state.entities.automatic).toEqual(["Acme", "Tool"]);
    expect(result.state.entities.revision).toBe(aiRevision);
    if (action === "set_empty") expect(result.state.entities.empty).toMatchObject({ origin: "human", confirmed: true });
  }
  const newer = await source(id, "changed source");
  let result = await edit(id, "accept", "Manual", "after-source-change");
  expect(result.state.entities.status).toBe("stale");
  expect(result.state.entities.values.map(value => value.term)).toEqual(["Manual"]);
  expect(result.state.entities.automatic).toEqual([]);
  expect((await request("/api/v2/links/" + id + "/entity-state", "POST", {
    ...newer, operation_key: "synthetic-failure", state: "failed", entities: [],
  }, "internal")).status).toBe(200);
  result = await read(id);
  expect(result.state.entities.status).toBe("failed");
  expect(result.state.entities.values.map(value => value.term)).toEqual(["Manual"]);
  expect(result.state.entities.values[0].origin).toBe("human");
});
