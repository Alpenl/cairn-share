import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { pruneLiveHistory } from "../src/history-retention";

const NOW = Date.parse("2026-09-28T00:00:00.000Z");
const OLD = "2026-01-01T00:00:00.000Z";
const RECENT = "2026-09-01T00:00:00.000Z";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function link(): Promise<number> {
  const response = await worker.fetch(new Request("https://test.example/api/links", {
    method: "POST", headers: { Authorization: "Bearer app", "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/history-retention" })
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
  expect(response.status).toBe(201);
  return (await response.json() as { id: number }).id;
}

async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n")) ?? 0;
}

it("prunes at most 100 old audit events per tick and leaves authority and receipts intact", async () => {
  const id = await link();
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<205)
    INSERT INTO curation_events(link_id,kind,revision,operation_key,created_at)
    SELECT ?,'why',0,'old-event-'||x,? FROM n`).bind(id, OLD).run();
  await env.DB.prepare(`INSERT INTO curation_events(link_id,kind,revision,operation_key,created_at)
    VALUES (?,'why',0,'recent-event',?)`).bind(id, RECENT).run();
  await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,revision,source,operation_key,created_at)
    VALUES (?,'topics','llm','accept',1,'human','retained-action',?)`).bind(id, OLD).run();
  await env.DB.prepare(`INSERT INTO selection_operations(operation_key,link_id,payload_hash,revision,selection,created_at)
    VALUES ('retained-receipt',?,'hash',1,'{}',?)`).bind(id, OLD).run();
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ events: 100 });
  expect(await count("curation_events")).toBe(106);
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ events: 100 });
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ events: 5 });
  expect(await count("curation_events")).toBe(1);
  expect(await count("curation_overrides")).toBe(1);
  expect(await count("selection_operations")).toBe(1);
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ events: 0 });
});

it("only removes old snapshots with no current or historical reference", async () => {
  const id = await link();
  await env.DB.prepare("UPDATE links SET content_revision=8 WHERE id=?").bind(id).run();
  const snapshots: number[] = [];
  for (let revision = 1; revision <= 8; revision++) {
    const result = await env.DB.prepare(`INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,created_at)
      VALUES (?,?,?,'{}',?) RETURNING id`).bind(id, revision, `hash-${revision}`, OLD).first<number>("id");
    snapshots.push(result!);
  }
  await env.DB.prepare(`INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,target_generation,
    requested_model,policy_version,answers,operation_key,created_at,evidence_snapshot_id)
    VALUES (?,1,'spec','hash',0,'model','policy','{}','retained-run',?,?)`)
    .bind(id, OLD, snapshots[0]).run();
  await env.DB.prepare(`INSERT INTO entity_operations(operation_key,link_id,request_hash,evidence_snapshot_id,
    content_revision,content_hash,payload,outcome,created_at)
    VALUES ('retained-entity',?,'hash',?,2,'hash-2','{}','stored',?)`).bind(id, snapshots[1], OLD).run();
  await env.DB.prepare(`INSERT INTO evidence_requests(id,link_id,content_revision,scope,dedupe_key,created_at,evidence_snapshot_id)
    VALUES ('retained-request',?,3,'external','request-key',?,?)`).bind(id, OLD, snapshots[2]).run();
  await env.DB.prepare(`INSERT INTO entity_states(link_id,state,content_revision,entities,updated_at,evidence_snapshot_id,content_hash)
    VALUES (?,'completed_nonempty',4,'[]',?,?, 'hash-4')`).bind(id, OLD, snapshots[3]).run();
  await env.DB.prepare(`INSERT INTO entity_cache(cache_key,link_id,evidence_snapshot_id,content_revision,content_hash,
    source_links,owner_token,status,request_json,candidates,spec_hash,created_at,expires_at)
    VALUES ('retained-cache',?,?,5,'hash-5','[]','owner','pending','{}','[]','spec',?,?)`)
    .bind(id, snapshots[4], NOW, NOW + 86_400_000).run();
  await env.DB.prepare(`INSERT INTO classification_jobs(link_id,status,evidence_snapshot_id)
    VALUES (?,'pending',?)`).bind(id, snapshots[5]).run();
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ snapshots: 1 });
  const rows = await env.DB.prepare("SELECT content_revision FROM evidence_snapshots WHERE link_id=? ORDER BY content_revision")
    .bind(id).all<{ content_revision: number }>();
  expect(rows.results.map((row) => row.content_revision)).toEqual([1, 2, 3, 4, 5, 6, 8]);
  await env.DB.prepare("DELETE FROM classification_jobs WHERE link_id=?").bind(id).run();
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ snapshots: 1 });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM evidence_snapshots WHERE id=?")
    .bind(snapshots[5]).first("n")).toBe(0);
});

it("walks past a full page of protected snapshots before pruning an eligible one", async () => {
  const id = await link();
  await env.DB.prepare("UPDATE links SET content_revision=102 WHERE id=?").bind(id).run();
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<102)
    INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,created_at)
    SELECT ?,x,'hash-'||x,'{}',? FROM n`).bind(id, OLD).run();
  await env.DB.prepare(`INSERT INTO entity_operations(operation_key,link_id,request_hash,evidence_snapshot_id,
    content_revision,content_hash,payload,outcome,created_at)
    SELECT 'pinned-'||content_revision,link_id,'request-'||content_revision,id,
      content_revision,content_hash,'{}','stored',? FROM evidence_snapshots
    WHERE link_id=? AND content_revision<=100`).bind(OLD, id).run();
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ snapshots: 0 });
  expect(await count("evidence_snapshots")).toBe(102);
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ snapshots: 1 });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM evidence_snapshots WHERE link_id=? AND content_revision=101")
    .bind(id).first("n")).toBe(0);
  expect(await count("evidence_snapshots")).toBe(101);
});

it("rolls back both deletion and cursor advancement if a maintenance statement fails", async () => {
  const id = await link();
  await env.DB.prepare(`INSERT INTO curation_events(link_id,kind,revision,operation_key,created_at)
    VALUES (?,'why',0,'failure-event',?)`).bind(id, OLD).run();
  await env.DB.prepare(`CREATE TRIGGER reject_history_cursor BEFORE INSERT ON privacy_maintenance_state
    WHEN NEW.key='live_events' BEGIN SELECT RAISE(ABORT,'synthetic retention failure'); END`).run();
  await expect(pruneLiveHistory({ DB: env.DB }, NOW)).rejects.toThrow("synthetic retention failure");
  expect(await count("curation_events")).toBe(1);
  await env.DB.prepare("DROP TRIGGER reject_history_cursor").run();
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ events: 1 });
  expect(await count("curation_events")).toBe(0);
});

it("runs the bounded live-history cleanup from the scheduled Worker entry point", async () => {
  const id = await link();
  await env.DB.prepare(`INSERT INTO curation_events(link_id,kind,revision,operation_key,created_at)
    VALUES (?,'why',0,'scheduled-old-event',?)`).bind(id, OLD).run();
  const controller = { cron: "*/5 * * * *", scheduledTime: NOW, noRetry() {} } as ScheduledController;
  await worker.scheduled(controller, { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
    CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
  expect(await count("curation_events")).toBe(0);
});
