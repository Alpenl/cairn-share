import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { pruneLiveHistory } from "../src/history-retention";

const NOW = Date.parse("2026-09-28T00:00:00.000Z");
const OLD = "2026-01-01T00:00:00.000Z";
const RECENT = "2026-09-01T00:00:00.000Z";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function link(suffix = "history-retention"): Promise<number> {
  const response = await worker.fetch(new Request("https://test.example/api/links", {
    method: "POST", headers: { Authorization: "Bearer app", "Content-Type": "application/json" },
    body: JSON.stringify({ url: `https://example.com/${suffix}` })
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
  expect(response.status).toBe(201);
  return (await response.json() as { id: number }).id;
}

async function internal(path: string, method = "GET", body?: unknown): Promise<Response> {
  return worker.fetch(new Request(`https://test.example/api/${path}`, {
    method, headers: { Authorization: "Bearer internal", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
    CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
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

it("compacts an unreferenced old run, releases its snapshot, and rejects an expired operation retry", async () => {
  const id = await link();
  await env.DB.prepare(`INSERT INTO question_specs(spec_id,spec_hash,spec_version,payload,requested_model,created_at)
    VALUES ('retention-spec','retention-hash',1,'{"questions":[]}','model',?)`).bind(OLD).run();
  const body = { operation_key: "retention-run", content_revision: 1, spec_id: "retention-spec",
    spec_hash: "retention-hash", target_generation: 0, policy_version: "policy", answers: { private: "answer" } };
  const first = await internal(`v2/links/${id}/runs`, "POST", body);
  expect(first.status).toBe(200);
  const runID = (await first.json() as { run: { id: number } }).run.id;
  const snapshot = await env.DB.prepare(`INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,created_at)
    VALUES (? ,1,'old-hash','{"blocks":["private"]}',?) RETURNING id`).bind(id, OLD).first<number>("id");
  await env.DB.prepare("UPDATE classification_runs SET created_at=?,evidence_snapshot_id=?,raw_judgments=? WHERE id=?")
    .bind(OLD, snapshot, '{"wire_state":"private material"}', runID).run();
  await env.DB.prepare("UPDATE links SET content_revision=2 WHERE id=?").bind(id).run();
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ runs: 1, snapshots: 1 });
  expect(await count("classification_runs")).toBe(0);
  const tombstone = await env.DB.prepare(`SELECT run_id,operation_key,expired_at,payload_hash
    FROM classification_run_tombstones WHERE run_id=?`).bind(runID).first<{
      run_id: number; operation_key: string; expired_at: string; payload_hash: string;
    }>();
  expect(tombstone).toMatchObject({ run_id: runID, operation_key: "retention-run" });
  expect(tombstone?.expired_at).toBeTruthy();
  expect(tombstone?.payload_hash).toHaveLength(64);
  expect((await internal(`v2/links/${id}/runs`, "POST", body)).status).toBe(410);
  expect((await internal(`v2/links/${id}/runs`, "POST", { ...body, answers: { private: "changed" } })).status).toBe(409);
  expect(await count("classification_runs")).toBe(0);
  expect(await count("evidence_snapshots")).toBe(0);
  const listed = await (await internal(`v2/links/${id}/runs`)).json() as { runs: Array<{ status: string; raw_judgments: unknown }> };
  expect(listed.runs[0]).toMatchObject({ status: "expired", raw_judgments: null });
  await expect(env.DB.prepare(`INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,
    target_generation,requested_model,policy_version,answers,operation_key,created_at)
    VALUES (?,2,'spec','hash',0,'model','policy','{}','retention-run',?)`)
    .bind(id, RECENT).run()).rejects.toThrow("run_operation_expired");
});

it("backfills reuse references before old runs may expire", async () => {
  const id = await link();
  await env.DB.prepare("UPDATE links SET content_revision=3 WHERE id=?").bind(id).run();
  const source = await env.DB.prepare(`INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,
    target_generation,requested_model,policy_version,answers,operation_key,created_at,payload_hash,raw_judgments)
    VALUES (?,1,'spec','hash',0,'model','policy','{}','reuse-source',?,?,'{"judgments":{}}') RETURNING id`)
    .bind(id, OLD, "a".repeat(64)).first<number>("id");
  const child = await env.DB.prepare(`INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,
    target_generation,requested_model,policy_version,answers,operation_key,created_at,payload_hash,raw_judgments)
    VALUES (?,2,'spec','hash',0,'model','policy','{}','reuse-child',?,?,?) RETURNING id`)
    .bind(id, OLD, "b".repeat(64), JSON.stringify({ reused_from: { question: source } })).first<number>("id");
  await env.DB.prepare(`INSERT INTO classification_decisions(link_id,run_id,content_revision,policy_version,
    policy,automatic,operation_key,created_at) VALUES (?,?,2,'policy','{}','{}','keep-child',?)`)
    .bind(id, child, OLD).run();
  await env.DB.prepare("DELETE FROM classification_run_reuse_sources WHERE run_id=?").bind(child).run();
  await env.DB.prepare("UPDATE privacy_maintenance_state SET cursor='0' WHERE key='run_reuse_backfill'").run();
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ runs: 0 });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM classification_run_reuse_sources WHERE source_run_id=?")
    .bind(source).first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT status FROM classification_runs WHERE id=?").bind(source).first("status"))
    .toBe("succeeded");
  expect(await env.DB.prepare("SELECT status FROM classification_runs WHERE id=?").bind(child).first("status"))
    .toBe("succeeded");
});

it("waits for every 100-row reuse backfill page before compaction starts", async () => {
  const id = await link();
  await env.DB.prepare("UPDATE links SET content_revision=2 WHERE id=?").bind(id).run();
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<101)
    INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,target_generation,
      requested_model,policy_version,answers,operation_key,created_at,payload_hash)
    SELECT ?,1,'spec','hash',0,'model','policy','{}','old-run-'||x,?,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' FROM n`).bind(id, OLD).run();
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ runs: 0 });
  expect(await env.DB.prepare("SELECT cursor FROM privacy_maintenance_state WHERE key='run_reuse_backfill'")
    .first("cursor")).not.toBe("done");
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ runs: 100 });
  expect(await env.DB.prepare("SELECT cursor FROM privacy_maintenance_state WHERE key='run_reuse_backfill'")
    .first("cursor")).toBe("done");
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ runs: 1 });
});

it("keeps the latest run for the current content revision and every decision source", async () => {
  const id = await link();
  const latest = await env.DB.prepare(`INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,
    target_generation,requested_model,policy_version,answers,operation_key,created_at,payload_hash)
    VALUES (?,1,'spec','hash',0,'model','policy','{}','current-run',?,?) RETURNING id`)
    .bind(id, OLD, "a".repeat(64)).first<number>("id");
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ runs: 0 });
  await env.DB.prepare("UPDATE links SET content_revision=2 WHERE id=?").bind(id).run();
  await env.DB.prepare(`INSERT INTO classification_decisions(link_id,run_id,content_revision,policy_version,
    policy,automatic,operation_key,created_at) VALUES (?,?,1,'policy','{}','{}','pinned-decision',?)`)
    .bind(id, latest, OLD).run();
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ runs: 0 });
  expect(await count("classification_run_tombstones")).toBe(0);
});

it("rolls back a run tombstone and its cursor when deletion fails", async () => {
  const id = await link();
  await env.DB.prepare("UPDATE links SET content_revision=2 WHERE id=?").bind(id).run();
  await env.DB.prepare(`INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,
    target_generation,requested_model,policy_version,answers,operation_key,created_at,payload_hash)
    VALUES (?,1,'spec','hash',0,'model','policy','{}','failed-prune',?,?)`)
    .bind(id, OLD, "a".repeat(64)).run();
  await env.DB.prepare(`CREATE TRIGGER reject_run_delete BEFORE DELETE ON classification_runs
    BEGIN SELECT RAISE(ABORT,'synthetic run deletion failure'); END`).run();
  await expect(pruneLiveHistory({ DB: env.DB }, NOW)).rejects.toThrow("synthetic run deletion failure");
  expect(await count("classification_runs")).toBe(1);
  expect(await count("classification_run_tombstones")).toBe(0);
  expect(await count("privacy_maintenance_state")).toBeGreaterThan(0);
  expect(await env.DB.prepare("SELECT cursor FROM privacy_maintenance_state WHERE key='live_runs'").first("cursor"))
    .toBeNull();
  await env.DB.prepare("DROP TRIGGER reject_run_delete").run();
  expect(await pruneLiveHistory({ DB: env.DB }, NOW)).toMatchObject({ runs: 1 });
  expect(await count("classification_run_tombstones")).toBe(1);
});
