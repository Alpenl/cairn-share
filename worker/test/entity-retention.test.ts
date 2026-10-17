import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { pruneLiveHistory } from "../src/history-retention";

const NOW = Date.parse("2026-10-16T00:00:00.000Z");
const OLD = "2026-01-01T00:00:00.000Z";
const RECENT = "2026-10-01T00:00:00.000Z";
const HASH = "a".repeat(64);

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function request(path: string, body?: unknown, db = env.DB, method = "POST", token = "internal") {
  return worker.fetch(new Request(`https://test.example/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), { DB: db, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
    CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}

async function link(suffix = "entity-retention") {
  const response = await request("links", { url: `https://example.com/${suffix}` }, env.DB, "POST", "app");
  expect(response.status).toBe(201);
  return (await response.json() as { id: number }).id;
}

async function snapshot(id: number, revision = 1, created = OLD) {
  return (await env.DB.prepare(`INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,created_at)
    VALUES (?,?,?,'{"blocks":["private old input"]}',?) RETURNING id`)
    .bind(id, revision, HASH, created).first<number>("id"))!;
}

async function operation(id: number, snapshotID: number, key: string, created = OLD, hash = HASH, applied = 1) {
  await env.DB.prepare(`INSERT INTO entity_operations(operation_key,link_id,request_hash,evidence_snapshot_id,
    content_revision,content_hash,payload,outcome,applied,created_at)
    VALUES (?,?,?,?,1,?,'{"entities":["private old answer"]}','stored',?,?)`)
    .bind(key, id, hash, snapshotID, HASH, applied, created).run();
}

async function count(table: string) {
  return env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n");
}

async function history() {
  const id = await link();
  const evidenceSnapshotID = await snapshot(id);
  const body = { operation_key: "old-result", state: "completed_nonempty", entities: ["OldEntity"],
    evidence_snapshot_id: evidenceSnapshotID, content_revision: 1, content_hash: HASH };
  expect((await request(`v2/links/${id}/entity-state`, body)).status).toBe(200);
  expect((await request(`v2/links/${id}/entity-state`, { ...body, operation_key: "current-result", entities: ["CurrentEntity"] })).status).toBe(200);
  await env.DB.prepare("UPDATE entity_operations SET created_at=?").bind(OLD).run();
  return { id, body, evidenceSnapshotID };
}

function beforeEntityBatch(action: () => Promise<void>) {
  let called = false;
  let entityBatch = false;
  return new Proxy(env.DB, { get(target, property) {
    if (property === "prepare") return (sql: string) => {
      if (/INSERT INTO entity_operation(?:s|_tombstones)\b/.test(sql)) entityBatch = true;
      return target.prepare(sql);
    };
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      if (!called && entityBatch) {
        called = true; await action();
      }
      return target.batch(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

it("expires only superseded entity payloads and returns explicit expiry instead of replaying them", async () => {
  const { id, body } = await history();
  const before = await env.DB.prepare("SELECT * FROM entity_states WHERE link_id=?").bind(id).first();
  const projection = await env.DB.prepare("SELECT * FROM current_projections WHERE link_id=?").bind(id).first();
  await pruneLiveHistory({ DB: env.DB }, NOW);
  expect(await count("entity_operations")).toBe(1);
  const expired = await env.DB.prepare("SELECT * FROM entity_operation_tombstones").first();
  expect(expired).toMatchObject({ operation_key: body.operation_key, link_id: id, content_revision: 1,
    outcome: "stored", created_at: OLD, expired_at: new Date(NOW).toISOString() });
  expect(expired).not.toHaveProperty("payload");
  expect(expired).not.toHaveProperty("evidence_snapshot_id");
  const replay = await request(`v2/links/${id}/entity-state`, body);
  expect(replay.status).toBe(410);
  expect(await replay.json()).toMatchObject({ error: "entity_operation_expired" });
  expect((await request(`v2/links/${id}/entity-state`, { ...body, entities: ["ChangedEntity"] })).status).toBe(409);
  const other = await link("other-owner");
  expect((await request(`v2/links/${other}/entity-state`, body)).status).toBe(409);
  // Expired and conflicting retries must not even rebuild the projection.
  expect(await env.DB.prepare("SELECT * FROM entity_states WHERE link_id=?").bind(id).first()).toEqual(before);
  expect(await env.DB.prepare("SELECT * FROM current_projections WHERE link_id=?").bind(id).first()).toEqual(projection);
  // A still-live receipt retains the existing successful replay contract.
  expect((await request(`v2/links/${id}/entity-state`, { ...body, operation_key: "current-result", entities: ["CurrentEntity"] })).status).toBe(200);
  expect(await env.DB.prepare("SELECT * FROM entity_states WHERE link_id=?").bind(id).first()).toEqual(before);
  expect(await env.DB.prepare("SELECT effective FROM current_projections WHERE link_id=?").bind(id).first("effective"))
    .toBe(projection!.effective);
  expect(await count("entity_operations")).toBe(1);
});

it("checks at most 100 operations per tick, advances past protected rows and wraps its persistent cursor", async () => {
  const id = await link();
  const source = await snapshot(id);
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<101)
    INSERT INTO entity_operations(operation_key,link_id,request_hash,evidence_snapshot_id,content_revision,
      content_hash,payload,outcome,applied,created_at)
    SELECT printf('old-%03d',x),?,?,?,1,?,'{}','stored',CASE WHEN x<=100 THEN 0 ELSE 1 END,? FROM n`)
    .bind(id, HASH, source, HASH, OLD).run();
  await pruneLiveHistory({ DB: env.DB }, NOW);
  expect(await count("entity_operation_tombstones")).toBe(0);
  expect(await env.DB.prepare("SELECT cursor FROM privacy_maintenance_state WHERE key='live_entity_operations'").first("cursor"))
    .toBe(JSON.stringify({ operation_key: "old-100", created_at: OLD }));
  await pruneLiveHistory({ DB: env.DB }, NOW);
  expect(await count("entity_operation_tombstones")).toBe(1);
  await env.DB.prepare("UPDATE entity_operations SET applied=1").run();
  await pruneLiveHistory({ DB: env.DB }, NOW);
  expect(await count("entity_operation_tombstones")).toBe(101);
  expect(await count("entity_operations")).toBe(0);
});

it("caps eligible cleanup at 100 even with a large backlog", async () => {
  const id = await link();
  const source = await snapshot(id);
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<205)
    INSERT INTO entity_operations(operation_key,link_id,request_hash,evidence_snapshot_id,content_revision,
      content_hash,payload,outcome,applied,created_at)
    SELECT printf('eligible-%03d',x),?,?,?,1,?,'{}','stored',1,? FROM n`)
    .bind(id, HASH, source, HASH, OLD).run();
  for (const remaining of [105, 5, 0]) {
    await pruneLiveHistory({ DB: env.DB }, NOW);
    expect(await count("entity_operations")).toBe(remaining);
  }
  expect(await count("entity_operation_tombstones")).toBe(205);
});

it("preserves recent, unapplied, unknown-hash and unknown-outcome historical receipts", async () => {
  const id = await link();
  const source = await snapshot(id);
  await operation(id, source, "recent", RECENT);
  await operation(id, source, "pending", OLD, HASH, 0);
  await operation(id, source, "unknown-hash", OLD, "legacy");
  await operation(id, source, "malformed-hash", OLD, "z".repeat(64));
  await operation(id, source, "unknown-outcome");
  await env.DB.prepare("UPDATE entity_operations SET outcome='legacy' WHERE operation_key='unknown-outcome'").run();
  await pruneLiveHistory({ DB: env.DB }, NOW);
  expect(await count("entity_operations")).toBe(5);
  expect(await count("entity_operation_tombstones")).toBe(0);
});

it("frees unreferenced old source input but keeps the current entity state and manual authority", async () => {
  const { id, evidenceSnapshotID } = await history();
  await env.DB.prepare("UPDATE links SET content_revision=2 WHERE id=?").bind(id).run();
  const newer = await snapshot(id, 2, RECENT);
  expect((await request(`v2/links/${id}/entity-state`, { operation_key: "new-source-result", state: "failed", entities: [],
    evidence_snapshot_id: newer, content_revision: 2, content_hash: HASH })).status).toBe(200);
  expect((await request(`v2/links/${id}/entities`, { operation_key: "manual-accept", action: "accept", term: "HumanEntity" })).status).toBe(200);
  const manual = await env.DB.prepare("SELECT * FROM curation_overrides").all();
  const current = await env.DB.prepare("SELECT * FROM entity_states").all();
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ snapshots: 1 });
  expect(await env.DB.prepare("SELECT id FROM evidence_snapshots WHERE id=?").bind(evidenceSnapshotID).first()).toBeNull();
  expect((await env.DB.prepare("SELECT * FROM entity_states").all()).results).toEqual(current.results);
  expect((await env.DB.prepare("SELECT * FROM curation_overrides").all()).results).toEqual(manual.results);
});

for (const failure of ["tombstone", "delete", "cursor"] as const) {
  it(`rolls back the complete entity retention batch on ${failure} failure`, async () => {
    await history();
    const trigger = failure === "tombstone" ? "BEFORE INSERT ON entity_operation_tombstones"
      : failure === "delete" ? "BEFORE DELETE ON entity_operations"
      : "BEFORE INSERT ON privacy_maintenance_state WHEN NEW.key='live_entity_operations'";
    await env.DB.prepare(`CREATE TRIGGER fail_entity_retention ${trigger}
      BEGIN SELECT RAISE(ABORT,'synthetic entity retention failure'); END`).run();
    await expect(pruneLiveHistory({ DB: env.DB }, NOW)).rejects.toThrow("synthetic entity retention failure");
    expect(await count("entity_operations")).toBe(2);
    expect(await count("entity_operation_tombstones")).toBe(0);
    expect(await env.DB.prepare("SELECT cursor FROM privacy_maintenance_state WHERE key='live_entity_operations'").first("cursor"))
      .toBeNull();
    await env.DB.prepare("DROP TRIGGER fail_entity_retention").run();
    await pruneLiveHistory({ DB: env.DB }, NOW);
    expect(await count("entity_operation_tombstones")).toBe(1);
  });
}

it("prevents a delayed HTTP write and a direct SQL writer from recreating an expired operation", async () => {
  const { id, body } = await history();
  // The paused request has passed its initial missing-receipt check before
  // another invocation commits and expires exactly that operation.
  const late = { ...body, operation_key: "late-operation" };
  const db = beforeEntityBatch(async () => {
    expect((await request(`v2/links/${id}/entity-state`, late)).status).toBe(200);
    expect((await request(`v2/links/${id}/entity-state`, { ...body, operation_key: "latest-result" })).status).toBe(200);
    await env.DB.prepare("UPDATE entity_operations SET created_at=?").bind(OLD).run();
    await pruneLiveHistory({ DB: env.DB }, NOW);
  });
  const response = await request(`v2/links/${id}/entity-state`, late, db);
  expect(response.status).toBe(410);
  expect(await response.json()).toMatchObject({ error: "entity_operation_expired" });
  expect(await env.DB.prepare("SELECT operation_key FROM entity_states WHERE link_id=?").bind(id).first("operation_key"))
    .toBe("latest-result");
  await expect(operation(id, body.evidence_snapshot_id, late.operation_key)).rejects.toThrow("entity_operation_expired");
});

it("rechecks current references in the cleanup transaction after candidate selection", async () => {
  const { id } = await history();
  const db = beforeEntityBatch(async () => {
    await env.DB.prepare("UPDATE entity_states SET operation_key='old-result' WHERE link_id=?").bind(id).run();
  });
  await pruneLiveHistory({ DB: db }, NOW);
  expect(await env.DB.prepare("SELECT operation_key FROM entity_operations WHERE operation_key='old-result'").first("operation_key"))
    .toBe("old-result");
  expect(await env.DB.prepare("SELECT operation_key FROM entity_operation_tombstones WHERE operation_key='old-result'").first())
    .toBeNull();
});

it("deletes compact receipts with their link and leaves no old input or entity payload", async () => {
  const { id } = await history();
  await pruneLiveHistory({ DB: env.DB }, NOW);
  expect(await count("entity_operation_tombstones")).toBe(1);
  expect((await request(`links/${id}`, undefined, env.DB, "DELETE", "app")).status).toBe(204);
  for (const table of ["entity_operations", "entity_operation_tombstones", "entity_states", "evidence_snapshots"]) {
    expect(await count(table)).toBe(0);
  }
});

for (const state of ["not_run", "failed", "completed_empty", "completed_nonempty", "stale"]) {
  it(`keeps the current ${state} state receipt even beyond the retention period`, async () => {
    const { id } = await history();
    await env.DB.prepare("UPDATE entity_states SET state=? WHERE link_id=?").bind(state, id).run();
    const before = await env.DB.prepare("SELECT * FROM entity_states WHERE link_id=?").bind(id).first();
    await pruneLiveHistory({ DB: env.DB }, NOW);
    expect(await env.DB.prepare("SELECT operation_key FROM entity_operations WHERE operation_key='current-result'").first("operation_key"))
      .toBe("current-result");
    expect(await env.DB.prepare("SELECT * FROM entity_states WHERE link_id=?").bind(id).first()).toEqual(before);
    expect(await count("entity_operation_tombstones")).toBe(1);
  });
}

for (const [days, expected] of [["30", 1], ["365", 0], ["29", 0], ["invalid", 0]] as const) {
  it(`uses the shared retention period for entity results (${days})`, async () => {
    const id = await link();
    const source = await snapshot(id);
    await operation(id, source, "configured-age", new Date(NOW - 60 * 86_400_000).toISOString());
    await pruneLiveHistory({ DB: env.DB, HISTORY_RETENTION_DAYS: days }, NOW);
    expect(await count("entity_operation_tombstones")).toBe(expected);
  });
}

it("recovers a damaged entity cursor with a bounded walk", async () => {
  const id = await link();
  await operation(id, await snapshot(id), "damaged-cursor");
  await env.DB.prepare("INSERT INTO privacy_maintenance_state(key,cursor) VALUES ('live_entity_operations','{broken')").run();
  await pruneLiveHistory({ DB: env.DB }, NOW);
  expect(await count("entity_operations")).toBe(0);
  expect(await count("entity_operation_tombstones")).toBe(1);
});

it("upgrades populated 0068 without rewriting history, authority or input", async () => {
  await reset();
  const boundary = env.TEST_MIGRATIONS.findIndex(migration => migration.name.startsWith("0069_"));
  expect(boundary).toBeGreaterThan(0);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, boundary));
  const id = await link();
  const source = await snapshot(id);
  await operation(id, source, "pre-upgrade-current");
  await operation(id, source, "pre-upgrade-history");
  await env.DB.prepare(`INSERT INTO entity_states(link_id,state,content_revision,content_hash,evidence_snapshot_id,
    entities,observations,updated_at,operation_key,revision)
    VALUES (?,'completed_nonempty',1,?,?,'["OriginalEntity"]','[]',?,'pre-upgrade-current',7)`)
    .bind(id, HASH, source, OLD).run();
  await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,revision,source,operation_key,created_at)
    VALUES (?,'entities','HumanEntity','accept',1,'human','pre-upgrade-human',?)`).bind(id, OLD).run();
  const tables = ["links", "entity_operations", "entity_states", "evidence_snapshots", "curation_overrides"];
  const before = await Promise.all(tables.map(async table => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results));
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(boundary));
  const after = await Promise.all(tables.map(async table => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results));
  expect(after).toEqual(before);
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect(await count("entity_operation_tombstones")).toBe(0);
  await pruneLiveHistory({ DB: env.DB }, NOW);
  expect(await count("entity_operations")).toBe(1);
  expect(await count("entity_operation_tombstones")).toBe(1);
  expect((await env.DB.prepare("SELECT * FROM entity_states").all()).results).toEqual(before[2]);
  expect((await env.DB.prepare("SELECT * FROM curation_overrides").all()).results).toEqual(before[4]);
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it("seeks the persisted entity cursor through its index without sorting the remaining backlog", async () => {
  const id = await link();
  const source = await snapshot(id);
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000)
    INSERT INTO entity_operations(operation_key,link_id,request_hash,evidence_snapshot_id,content_revision,
      content_hash,payload,outcome,applied,created_at)
    SELECT printf('backlog-%04d',x),?,?,?,1,?,'{}','stored',0,? FROM n`)
    .bind(id, HASH, source, HASH, OLD).run();
  await env.DB.prepare("INSERT INTO privacy_maintenance_state(key,cursor) VALUES ('live_entity_operations',?)")
    .bind(JSON.stringify({ operation_key: "backlog-1800", created_at: OLD })).run();
  let candidateSQL = "";
  const db = new Proxy(env.DB, { get(target, property) {
    if (property === "prepare") return (sql: string) => {
      if (sql.startsWith("SELECT operation_key,created_at FROM entity_operations")) candidateSQL = sql;
      return target.prepare(sql);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await pruneLiveHistory({ DB: db }, NOW);
  expect(candidateSQL).not.toBe("");
  const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${candidateSQL}`)
    .bind(new Date(NOW - 90 * 86_400_000).toISOString(), OLD, "backlog-1800").all<{ detail: string }>();
  expect(plan.results.some(row => row.detail.includes("entity_operations_age_idx"))).toBe(true);
  expect(plan.results.some(row => row.detail.includes("TEMP B-TREE") || row.detail.includes("SCAN entity_operations"))).toBe(false);
  const cursor = await env.DB.prepare("SELECT cursor FROM privacy_maintenance_state WHERE key='live_entity_operations'").first("cursor");
  expect(cursor).toBe(JSON.stringify({ operation_key: "backlog-1900", created_at: OLD }));
  expect(await count("entity_operations")).toBe(2000);
});

it("expires ignored-stale receipts without turning them into new successful results", async () => {
  const { id, body } = await history();
  const ignored = { ...body, operation_key: "ignored-result", state: "failed", entities: [] };
  const response = await request(`v2/links/${id}/entity-state`, ignored);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "ignored_stale" });
  await env.DB.prepare("UPDATE entity_operations SET created_at=? WHERE operation_key='ignored-result'").bind(OLD).run();
  await pruneLiveHistory({ DB: env.DB }, NOW);
  expect(await env.DB.prepare("SELECT outcome FROM entity_operation_tombstones WHERE operation_key='ignored-result'").first("outcome"))
    .toBe("ignored_stale");
  expect((await request(`v2/links/${id}/entity-state`, ignored)).status).toBe(410);
  expect(await env.DB.prepare("SELECT state FROM entity_states WHERE link_id=?").bind(id).first("state"))
    .toBe("completed_nonempty");
});
