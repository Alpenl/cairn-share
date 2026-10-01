import { archiveOldRunPayloads } from "./run-archive";
// B03-T13: bound age-based cleanup for live links. Operation receipts and
// source-of-truth rows stay intact until their replay/expiry protocol exists.
// A cursor advances over at most one page per table and wraps at EOF. Each
// delete and cursor update share a D1 transaction, so a failed tick retries the
// same page without losing history or restarting an unbounded scan.
const PAGE_SIZE = 100;
const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

export interface HistoryRetentionEnv { DB: D1Database; HISTORY_RETENTION_DAYS?: string; ENRICHMENT_IMAGES?: R2Bucket }
type Candidate = { id: number; created_at: string };
type Cursor = { created_at: string; id: number };

function retentionDays(value: string | undefined): number {
  const days = Number(value);
  return value !== undefined && Number.isSafeInteger(days) && days >= 30 && days <= 365
    ? days : DEFAULT_RETENTION_DAYS;
}

function readCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const row = value as Record<string, unknown>;
      if (typeof row.created_at === "string" && Number.isSafeInteger(row.id) && Number(row.id) > 0) {
        return { created_at: row.created_at, id: Number(row.id) };
      }
    }
  } catch { /* damaged maintenance cursor restarts the bounded walk */ }
  return null;
}

async function prunePage(env: HistoryRetentionEnv, key: string, table: "curation_events" | "evidence_snapshots",
  cutoff: string, extraGuard: string): Promise<number> {
  const raw = await env.DB.prepare("SELECT cursor FROM privacy_maintenance_state WHERE key=?")
    .bind(key).first<string>("cursor");
  const cursor = readCursor(raw);
  const rows = await env.DB.prepare(`SELECT id,created_at FROM ${table} WHERE created_at<?
      ${cursor ? "AND (created_at>? OR (created_at=? AND id>?))" : ""}
      ORDER BY created_at,id LIMIT ${PAGE_SIZE}`)
    .bind(cutoff, ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []))
    .all<Candidate>();
  if (rows.results.length === 0) {
    if (cursor) await env.DB.prepare("UPDATE privacy_maintenance_state SET cursor='' WHERE key=?")
      .bind(key).run();
    return 0;
  }
  const last = rows.results[rows.results.length - 1];
  const next = rows.results.length < PAGE_SIZE ? "" : JSON.stringify(last);
  const ids = JSON.stringify(rows.results.map((row) => row.id));
  const result = await env.DB.batch([
    env.DB.prepare(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))
      AND created_at<? ${extraGuard} RETURNING id`).bind(ids, cutoff),
    env.DB.prepare(`INSERT INTO privacy_maintenance_state(key,cursor) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET cursor=excluded.cursor`).bind(key, next)
  ]);
  return result[0].results.length;
}

async function backfillRunReuse(env: HistoryRetentionEnv): Promise<boolean> {
  const cursor = await env.DB.prepare("SELECT cursor FROM privacy_maintenance_state WHERE key='run_reuse_backfill'")
    .first<string>("cursor");
  if (cursor === "done") return true;
  if (cursor === null || !/^\d+$/.test(cursor)) return false;
  const rows = await env.DB.prepare(`SELECT id FROM classification_runs WHERE id>? ORDER BY id LIMIT ${PAGE_SIZE}`)
    .bind(Number(cursor)).all<{ id: number }>();
  const next = rows.results.length < PAGE_SIZE ? "done" : String(rows.results[rows.results.length - 1].id);
  const ids = JSON.stringify(rows.results.map((row) => row.id));
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO classification_run_reuse_sources(run_id,source_run_id)
      SELECT DISTINCT r.id,CAST(j.value AS INTEGER)
      FROM classification_runs r, json_each(CASE WHEN json_valid(r.raw_judgments) THEN r.raw_judgments ELSE '{}' END,'$.reused_from') j
      JOIN classification_runs source ON source.id=CAST(j.value AS INTEGER)
      WHERE r.id IN (SELECT value FROM json_each(?)) AND j.type='integer'`).bind(ids),
    env.DB.prepare("UPDATE privacy_maintenance_state SET cursor=? WHERE key='run_reuse_backfill'")
      .bind(next)
  ]);
  return next === "done";
}

async function pruneOldRuns(env: HistoryRetentionEnv, cutoff: string, now: string): Promise<number> {
  const raw = await env.DB.prepare("SELECT cursor FROM privacy_maintenance_state WHERE key='live_runs'")
    .first<string>("cursor");
  const cursor = readCursor(raw);
  const rows = await env.DB.prepare(`SELECT id,created_at FROM classification_runs
      WHERE created_at<?
      ${cursor ? "AND (created_at>? OR (created_at=? AND id>?))" : ""}
      ORDER BY created_at,id LIMIT ${PAGE_SIZE}`)
    .bind(cutoff, ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []))
    .all<Candidate>();
  if (rows.results.length === 0) {
    if (cursor) await env.DB.prepare("UPDATE privacy_maintenance_state SET cursor='' WHERE key='live_runs'").run();
    return 0;
  }
  const last = rows.results[rows.results.length - 1];
  const next = rows.results.length < PAGE_SIZE ? "" : JSON.stringify(last);
  const ids = JSON.stringify(rows.results.map((row) => row.id));
  const eligible = `id IN (SELECT value FROM json_each(?)) AND created_at<?
    AND archive_key IS NULL AND status IN ('succeeded','partial') AND length(payload_hash)=64
    AND NOT EXISTS (SELECT 1 FROM classification_decisions WHERE run_id=classification_runs.id)
    AND NOT EXISTS (SELECT 1 FROM classification_decision_runs WHERE run_id=classification_runs.id)
    AND NOT EXISTS (SELECT 1 FROM classification_run_reuse_sources WHERE source_run_id=classification_runs.id)
    AND NOT EXISTS (SELECT 1 FROM links WHERE id=classification_runs.link_id
      AND content_revision=classification_runs.content_revision
      AND classification_runs.id=(SELECT MAX(id) FROM classification_runs latest
        WHERE latest.link_id=classification_runs.link_id AND latest.content_revision=classification_runs.content_revision))`;
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO classification_run_tombstones(operation_key,link_id,run_id,payload_hash,
      content_revision,spec_id,spec_hash,target_generation,requested_model,resolved_model,policy_version,
      coverage,evidence_coverage,alias_drift,attempt,source_hash,created_at,expired_at)
      SELECT operation_key,link_id,id,payload_hash,content_revision,spec_id,spec_hash,target_generation,
        requested_model,resolved_model,policy_version,coverage,evidence_coverage,alias_drift,attempt,
        source_hash,created_at,? FROM classification_runs WHERE ${eligible}`)
      .bind(now, ids, cutoff),
    env.DB.prepare(`DELETE FROM classification_runs WHERE ${eligible}
      AND EXISTS (SELECT 1 FROM classification_run_tombstones WHERE run_id=classification_runs.id)
      RETURNING id`).bind(ids, cutoff),
    env.DB.prepare(`INSERT INTO privacy_maintenance_state(key,cursor) VALUES ('live_runs',?)
      ON CONFLICT(key) DO UPDATE SET cursor=excluded.cursor`).bind(next)
  ]);
  return result[1].results.length;
}

export async function pruneLiveHistory(env: HistoryRetentionEnv, now = Date.now()): Promise<{ events: number; snapshots: number; runs: number }> {
  const cutoff = new Date(now - retentionDays(env.HISTORY_RETENTION_DAYS) * DAY_MS).toISOString();
  const events = await prunePage(env, "live_events", "curation_events", cutoff, "");
  const reuseBackfilled = await backfillRunReuse(env);
  if (reuseBackfilled) await archiveOldRunPayloads(env, cutoff, new Date(now).toISOString());
  const runs = reuseBackfilled ? await pruneOldRuns(env, cutoff, new Date(now).toISOString()) : 0;
  const snapshots = await prunePage(env, "live_snapshots", "evidence_snapshots", cutoff, `
    AND content_revision<>(SELECT content_revision FROM links WHERE id=evidence_snapshots.link_id)
    AND NOT EXISTS (SELECT 1 FROM classification_runs WHERE evidence_snapshot_id=evidence_snapshots.id)
    AND NOT EXISTS (SELECT 1 FROM entity_operations WHERE evidence_snapshot_id=evidence_snapshots.id)
    AND NOT EXISTS (SELECT 1 FROM evidence_requests WHERE evidence_snapshot_id=evidence_snapshots.id)
    AND NOT EXISTS (SELECT 1 FROM entity_states WHERE evidence_snapshot_id=evidence_snapshots.id)
    AND NOT EXISTS (SELECT 1 FROM entity_cache WHERE evidence_snapshot_id=evidence_snapshots.id)
    AND NOT EXISTS (SELECT 1 FROM classification_jobs WHERE evidence_snapshot_id=evidence_snapshots.id)`);
  return { events, snapshots, runs };
}
