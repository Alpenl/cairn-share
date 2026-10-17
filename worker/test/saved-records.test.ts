import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";

const bindings = () => ({ DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
  CAIRN_API_TOKEN: "saved-app", CAIRN_ENRICHER_TOKEN: "saved-internal" });
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(() => vi.restoreAllMocks());
async function request(path: string, method = "GET", token = "saved-app", cap = "1", body?: unknown) {
  return worker.fetch(new Request(`https://test.example${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, "X-Cairn-App-Saved-Records": cap, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }), bindings());
}
async function fixture() {
  const response = await request("/api/links", "POST", "saved-app", "1", { url: "https://example.com/saved-records" });
  expect(response.status).toBe(201);
  const id = (await response.json() as { id: number }).id;
  for (let n = 1; n <= 55; n++) {
    await env.DB.prepare(`INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,truncated,completeness,created_at)
      VALUES (?,?,? ,?,0,'partial','2026-10-17T00:00:00Z')`).bind(id, n, "a".repeat(64),
      JSON.stringify({ blocks: [{ id: "original", text: n === 55 ? "x".repeat(17_000) : "old" }], unknown: null, complete: false })).run();
    await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,source,confirmed,revision,operation_key,created_at)
      VALUES (?,'entities','原名','reject','legacy_unknown',0,?,?,'2026-10-17T00:00:00Z')`).bind(id, n, `legacy-${n}`).run();
    await env.DB.prepare(`INSERT INTO curation_events(link_id,kind,payload,revision,operation_key,created_at)
      VALUES (?,'why','{"why":"原备注","unknown":null}',?,?,'2026-10-17T00:00:00Z')`).bind(id, n, `why-${n}`).run();
  }
  const source = await env.DB.prepare("SELECT id FROM evidence_snapshots WHERE link_id=? AND content_revision=55").bind(id).first<number>("id");
  for (let n = 0; n < 55; n++) await env.DB.prepare(`INSERT INTO entity_operations(operation_key,link_id,request_hash,
    evidence_snapshot_id,content_revision,content_hash,payload,outcome,applied,created_at)
    VALUES (?,?,?, ?,55,?,'{"state":"failed","entities":[],"observations":[],"unknown":null}','ignored_stale',1,'2026-10-17T00:00:00Z')`)
    .bind(`op-${String(n).padStart(3, "0")}`, id, "b".repeat(64), source, "a".repeat(64)).run();
  return id;
}
const prefix = (id: number, kind: string) => `/api/bookmarks/${id}/saved-records/${kind}`;
async function counts() {
  return env.DB.prepare(`SELECT (SELECT COUNT(*) FROM evidence_snapshots) AS sources,
    (SELECT COUNT(*) FROM entity_operations) AS entities,(SELECT COUNT(*) FROM curation_overrides) AS overrides,
    (SELECT COUNT(*) FROM curation_events) AS events,(SELECT COUNT(*) FROM classification_runs) AS runs,
    (SELECT COUNT(*) FROM classification_provider_attempts) AS attempts,(SELECT COUNT(*) FROM budget_ledger) AS budget`).first();
}

it("pages every saved store without payloads, offsets, current projections, writes or provider calls", async () => {
  const id = await fixture(), before = await counts();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no retrieval or model"));
  for (const kind of ["sources", "entities", "overrides", "events"]) {
    const scope = kind === "entities" ? "source_revision=55&" : "";
    const result = await request(`${prefix(id, kind)}?${scope}`);
    expect(result.status).toBe(200); expect(result.headers.get("X-Cairn-App-Saved-Records")).toBe("1");
    expect(result.headers.get("Cache-Control")).toContain("no-store");
    const first = await result.json() as { records: Record<string, unknown>[]; next_after: string };
    expect(first.records).toHaveLength(50);
    expect(first.records[0].key).toBe(kind === "entities" ? "op-054" : "55");
    for (const row of first.records) for (const key of ["payload", "term", "operation_key", "payload_hash", "request_hash"])
      expect(row).not.toHaveProperty(key);
    const second = await (await request(`${prefix(id, kind)}?${scope}after_key=${encodeURIComponent(first.next_after)}`)).json() as typeof first;
    expect(second.records).toHaveLength(5); expect(second.next_after).toBeNull();
    expect(new Set([...first.records, ...second.records].map(row => row.key)).size).toBe(55);
  }
  expect(await counts()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  // Read by immutable content revision, using the existing source-scoped index.
  const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT operation_key FROM entity_operations
    WHERE evidence_snapshot_id=? AND link_id=? AND operation_key<? ORDER BY operation_key DESC LIMIT 51`).bind(55, id, "op-999").all<{ detail: string }>();
  expect(plan.results.some(row => row.detail.includes("entity_operations_snapshot_idx"))).toBe(true);
});

it("exports complete original source, entity receipts and unconfirmed manual rows without fabricating historical metadata", async () => {
  const id = await fixture();
  const read = async (kind: string, key: string, scope = "") => {
    const result = await request(`${prefix(id, kind)}?${scope}record_key=${encodeURIComponent(key)}`);
    expect(result.status).toBe(200);
    return await result.json() as { record: Record<string, unknown> };
  };
  const source = (await read("sources", "55")).record;
  expect(source).toMatchObject({ key: "55", content_revision: 55, truncated: 0, completeness: "partial" });
  expect(source.payload).toEqual({ blocks: [{ id: "original", text: "x".repeat(17_000) }], unknown: null, complete: false });
  const entity = (await read("entities", "op-054", "source_revision=55&")).record;
  expect(entity).toMatchObject({ state: "failed", outcome: "ignored_stale", applied: 1, request_hash: "b".repeat(64),
    payload: { state: "failed", entities: [], observations: [], unknown: null } });
  expect(entity).not.toHaveProperty("model"); expect(entity).not.toHaveProperty("requested_model");
  expect((await read("overrides", "55")).record).toMatchObject({ field: "entities", term: "原名", action: "reject", source: "legacy_unknown", confirmed: 0 });
  const event = (await read("events", "55")).record;
  expect(event.payload).toEqual({ why: "原备注", unknown: null }); expect(event).not.toHaveProperty("source");
  await env.DB.prepare("UPDATE curation_events SET payload='invalid JSON' WHERE id=55").run();
  expect((await request(`${prefix(id, "events")}?record_key=55`)).status).toBe(503);
  expect((await request(`${prefix(id, "entities")}?source_revision=54&record_key=op-054`)).status).toBe(404);
  expect((await request(`${prefix(id, "sources")}?record_key=999`)).status).toBe(404);
  expect((await request(`/api/links/${id}`, "DELETE")).status).toBe(204);
  for (const base of [`/api/bookmarks/${id}`, `/api/v2/links/${id}`]) for (const kind of ["sources", "overrides", "events", "entities"])
    expect((await request(`${base}/saved-records/${kind}${kind === "entities" ? "?source_revision=55" : ""}`, "GET",
      base.includes("/v2/") ? "saved-internal" : "saved-app")).status).toBe(404);
});

it("rejects foreign credentials, unsupported capabilities, mutations and ambiguous record queries", async () => {
  const id = await fixture(), base = prefix(id, "sources"), before = await counts();
  for (const token of ["", "wrong", "saved-internal"]) expect((await request(base, "GET", token)).status).toBe(401);
  expect((await request(base, "GET", "saved-app", "")).status).toBe(409);
  for (const method of ["POST", "PATCH", "DELETE", "HEAD"]) expect((await request(base, method)).status).toBe(405);
  for (const query of ["after_key=", "after_key=0", "after_key=01", "after_key=1e0", "after_key=9007199254740992",
    "record_key=1&after_key=2", "record_key=1&record_key=2", "source_revision=1", "limit=1000", "url=https://other.example"])
    expect((await request(`${base}?${query}`)).status).toBe(400);
  const entities = prefix(id, "entities");
  for (const query of ["", "source_revision=0", "source_revision=1&after_key=", `source_revision=1&record_key=${"a".repeat(201)}`])
    expect((await request(`${entities}?${query}`)).status).toBe(400);
  expect((await request(`/api/v2/links/${id}/saved-records/sources`)).status).toBe(401);
  expect(await counts()).toEqual(before);
});
