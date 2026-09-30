import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { readSelectionSnapshot } from "../src/selection-state";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const bindings = () => ({ ...env, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
function call(path: string, token = "internal", method = "GET", body?: unknown) {
  return worker.fetch(new Request(`https://test/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), bindings());
}

it("exports effective views in one bounded SQL snapshot with per-link semantics", async () => {
  const ids: number[] = [];
  for (const suffix of [201, 202, 203]) {
    const created = await call("links", "app", "POST", { url: `https://x.com/u/status/${suffix}` });
    ids.push((await created.json() as { id: number }).id);
  }
  await env.DB.prepare(`UPDATE links SET classification=?,why='export why',original_text='private article'
    WHERE id=?`).bind(JSON.stringify({ topics: ["llm"], form: "case", use: "learn" }), ids[0]).run();
  expect((await call(`bookmarks/${ids[1]}/v2-override`, "app", "POST", {
    operation_key: "batch-human-topic", field: "topics", action: "accept", term: "design", expected_revision: 0
  })).status).toBe(200);
  const singles = await Promise.all(ids.map(async (id) =>
    await (await call(`v2/links/${id}/effective`)).json() as Record<string, unknown>));
  const response = await call("v2/links/effective-batch", "internal", "POST", { ids: [ids[2], ids[0], 999999, ids[1]] });
  expect(response.status).toBe(200);
  const wire = await response.text();
  expect(Number(response.headers.get("Content-Length"))).toBe(new TextEncoder().encode(wire).length);
  expect(wire).not.toContain("private article");
  const batch = JSON.parse(wire) as { version: number; items: Array<Record<string, unknown>>;
    missing_ids: number[]; d1: { scope: string; sql_count: number; rows_read: number; rows_written: number } };
  expect(batch.version).toBe(1);
  expect(batch.items).toEqual([singles[2], singles[0], singles[1]]);
  expect(batch.missing_ids).toEqual([999999]);
  expect(batch.d1.scope).toBe("effective_view_only");
  expect(batch.d1.sql_count).toBe(1);
  expect(batch.d1.rows_read).toBeGreaterThan(0);
  expect(batch.d1.rows_written).toBe(0);
  expect((await call("v2/links/effective-batch", "app", "POST", { ids })).status).toBe(401);
  for (const bad of [{ ids: [] }, { ids: [ids[0], ids[0]] }, { ids: [0] },
    { ids: Array.from({ length: 51 }, (_, index) => index + 1) }, { ids, extra: true }]) {
    expect((await call("v2/links/effective-batch", "internal", "POST", bad)).status).toBe(400);
  }
  expect((await call("v2/links/effective-batch", "internal", "GET")).status).toBe(405);
});

it("returns article, effective selection and entity state from one reading contract", async () => {
  const created = await call("links", "app", "POST", { url: "https://x.com/u/status/101" });
  const { id } = await created.json() as { id: number };
  const article = "private article ".repeat(4000);
  await env.DB.prepare("UPDATE links SET original_text=?,translated_text='translation',enrichment_status='completed' WHERE id=?")
    .bind(article, id).run();
  const evidence = await (await call(`v2/links/${id}/evidence`, "internal", "POST", {
    snapshot: { blocks: [{ id: "b1", role: "primary", text: "article" }],
      fetched_at: "2026-09-29T00:00:00Z", retrieval: "x_search", truncation: { truncated: false } }
  })).json() as { content_revision: number; content_hash: string };
  const evidenceID = await env.DB.prepare("SELECT id FROM evidence_snapshots WHERE link_id=?").bind(id).first<number>("id");
  await env.DB.prepare(`INSERT INTO entity_states(link_id,state,content_revision,content_hash,evidence_snapshot_id,entities,updated_at,revision)
    VALUES (?,'completed_nonempty',?,?,?,'["Jev"]','now',1)`)
    .bind(id, evidence.content_revision, evidence.content_hash, evidenceID).run();
  expect((await call(`bookmarks/${id}/v2-override`, "app", "POST", {
    operation_key: "reading-topic", field: "topics", action: "accept", term: "llm", expected_revision: 0
  })).status).toBe(200);
  const path = `enrichment/jobs/${id}/reading`;
  expect((await call(path, "app")).status).toBe(401);
  expect((await call(path, "internal", "POST", {})).status).toBe(405);
  const response = await call(path);
  expect(response.status).toBe(200);
  const payload = await response.json() as Record<string, any>;
  expect(payload.version).toBe(1);
  expect(payload.detail.original_text).toBe(article);
  expect(payload.detail.translated_text).toBe("translation");
  expect(payload.detail.cache_identity.personal_revision).toBe(1);
  expect(payload.detail.cache_identity.latest_entity_revision).toBe(1);
  expect(payload.selection).toMatchObject({ available: true, revision: 1, selection: { topics: ["llm"] } });
  expect(payload.selection.state.entities.status).toBe("completed_nonempty");
  expect(payload.entities).toMatchObject({ state: "completed_nonempty", stale: false,
    entities: ["Jev"], automatic: ["Jev"], revision: 1 });
  const oldSelection = await (await call(`v2/links/${id}/selection?include_automatic=1`)).json() as Record<string, any>;
  expect(payload.selection.selection).toEqual(oldSelection.selection);
  expect(payload.selection.revision).toBe(oldSelection.revision);
  const bodyRevision = payload.detail.cache_identity.body_revision;
  const unchangedResponse = await call(`${path}?body_revision=${bodyRevision}`);
  const unchangedWire = await unchangedResponse.text();
  expect(unchangedWire).not.toContain("private article");
  expect(unchangedWire.length).toBeLessThan(article.length / 4);
  const unchanged = JSON.parse(unchangedWire) as Record<string, any>;
  expect(unchanged.body_unchanged).toBe(true);
  expect(unchanged.detail.cache_identity).toEqual(payload.detail.cache_identity);
  expect((await call(`v2/links/${id}/entities`, "internal", "POST", {
    operation_key: "reading-entity-reject", action: "reject", term: "Jev", expected_revision: 1
  })).status).toBe(200);
  const corrected = await (await call(`${path}?body_revision=${bodyRevision}`)).json() as Record<string, any>;
  const separateEntities = await (await call(`v2/links/${id}/entities`)).json() as Record<string, any>;
  expect(corrected.body_unchanged).toBe(true);
  expect(corrected.entities.entities).toEqual(separateEntities.entities);
  expect(corrected.entities.human).toEqual(separateEntities.human);
  expect(corrected.entities.revision).toBe(separateEntities.revision);
  await env.DB.prepare("UPDATE links SET why='changed' WHERE id=?").bind(id).run();
  const personal = await (await call(`${path}?body_revision=${bodyRevision}`)).json() as Record<string, any>;
  expect(personal.body_unchanged).toBe(true);
  expect(personal.selection.why).toBe("changed");
  expect(personal.detail.original_text).toBeNull();
  await env.DB.prepare("UPDATE links SET translated_text='new translation' WHERE id=?").bind(id).run();
  const changed = await (await call(`${path}?body_revision=${bodyRevision}`)).json() as Record<string, any>;
  expect(changed.body_unchanged).toBe(false);
  expect(changed.detail.original_text).toBe(article);
  expect(changed.detail.translated_text).toBe("new translation");
  expect((await call(`${path}?body_revision=-1`)).status).toBe(400);
  expect((await call(`${path}?body_revision=1&body_revision=1`)).status).toBe(400);
  expect((await call("enrichment/jobs/999999/reading")).status).toBe(404);
});

it("pins text and revision to one SQLite read snapshot", async () => {
  const created = await call("links", "app", "POST", { url: "https://x.com/u/status/102" });
  const { id } = await created.json() as { id: number };
  await env.DB.prepare("UPDATE links SET original_text='old' WHERE id=?").bind(id).run();
  const originalRevision = await env.DB.prepare("SELECT content_revision FROM links WHERE id=?").bind(id).first<number>("content_revision");
  let reads = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
    if (key === "first") return async () => {
      reads++;
      const value = await target.first();
      await env.DB.prepare("UPDATE links SET original_text='new' WHERE id=?").bind(id).run();
      return value;
    };
    return Reflect.get(target, key);
  } });
  const db = new Proxy(env.DB, { get(target, key) {
    return key === "prepare" ? (sql: string) => wrap(target.prepare(sql)) : Reflect.get(target, key);
  } });
  const snapshot = await readSelectionSnapshot({ DB: db } as Env, id, true);
  expect(reads).toBe(1);
  expect((snapshot?.link as unknown as { original_text: string }).original_text).toBe("old");
  expect(snapshot?.contentRevision).toBe(originalRevision);
  const fresh = await readSelectionSnapshot({ DB: env.DB } as Env, id, true);
  expect((fresh?.link as unknown as { original_text: string }).original_text).toBe("new");
  expect(fresh?.contentRevision).toBe((originalRevision ?? 0) + 1);
});
