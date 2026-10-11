import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "vitest";
import { SOURCE_CLAIM_CANDIDATE_SQL, sourceClaimCandidateBindings, sourceClaimSQL } from "../src/source-claim";

it("claims in priority order through the D1 index with bounded reads", async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(`WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<2000
  ) INSERT INTO links(url,created_at,original_text) SELECT 'https://x.com/u/status/'||n,'t','captured source' FROM seq`).run();
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const start = `${day}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + 86400000).toISOString();
  const bindings = [5, now, now, now, now, day, 1_000_000, start, end, 1_000_000,
    1, now, now];
  const forcedPlan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${SOURCE_CLAIM_CANDIDATE_SQL}`)
    .bind(...bindings).all<{ detail: string }>();
  const forcedResult = await env.DB.prepare(SOURCE_CLAIM_CANDIDATE_SQL)
    .bind(...bindings).all<{ id: number }>();
  expect(forcedPlan.results.map(row => row.detail).join(" ")).toContain("links_captured_reading_priority_idx");
  expect(forcedPlan.results.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
  expect(forcedResult.results).toEqual([{ id: 1 }]);
  expect(forcedResult.meta.rows_read).toBeLessThan(20);
  await env.DB.prepare("UPDATE links SET enrichment_status='completed'").run();
  const empty = await env.DB.prepare(SOURCE_CLAIM_CANDIDATE_SQL)
    .bind(...bindings).all<{ id: number }>();
  expect(empty.results).toEqual([]);
  expect(empty.meta.rows_read).toBeLessThan(20);
});

it("measures stage-filtered claims in a skewed 2,000-link queue", async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(`WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<2000
  ) INSERT INTO links(url,created_at,original_text) SELECT 'https://x.com/u/status/'||n,'t','captured source' FROM seq`).run();
  const now = new Date();
  await env.DB.prepare("UPDATE links SET original_text=NULL WHERE id<2000").run();
  await env.DB.prepare("UPDATE links SET original_text='stored source' WHERE id=2000").run();
  const readingPlan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sourceClaimSQL("reading")}`)
    .bind(...sourceClaimCandidateBindings(now, true, "reading")).all<{ detail: string }>();
  const reading = await env.DB.prepare(sourceClaimSQL("reading"))
    .bind(...sourceClaimCandidateBindings(now, true, "reading")).all<{ id: number }>();
  expect(reading.results).toEqual([{ id: 2000 }]);
  expect(readingPlan.results.map(row => row.detail).join(" ")).toContain("links_captured_reading_priority_idx");
  expect(readingPlan.results.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
  expect(reading.meta.rows_read).toBeLessThan(20);
  await env.DB.prepare("UPDATE links SET original_text='stored source' WHERE id<2000").run();
  await env.DB.prepare("UPDATE links SET original_text=NULL WHERE id=2000").run();
  const sourcePlan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sourceClaimSQL("source")}`)
    .bind(...sourceClaimCandidateBindings(now, true, "source")).all<{ detail: string }>();
  const source = await env.DB.prepare(sourceClaimSQL("source"))
    .bind(...sourceClaimCandidateBindings(now, true, "source")).all<{ id: number }>();
  expect(source.results).toEqual([]);
  expect(sourcePlan.results.map(row => row.detail).join(" ")).toContain("links_captured_reading_priority_idx");
  expect(sourcePlan.results.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
  expect(source.meta.rows_read).toBeLessThan(20);
  await env.DB.prepare("UPDATE links SET original_text='stored source' WHERE id=2000").run();
  const empty = await env.DB.prepare(sourceClaimSQL("source"))
    .bind(...sourceClaimCandidateBindings(now, true, "source")).all<{ id: number }>();
  expect(empty.results).toEqual([]);
  expect(empty.meta.rows_read).toBeLessThan(20);
  await env.DB.prepare("UPDATE links SET original_text=NULL,manual_priority=1 WHERE id=1999").run();
  const priority = await env.DB.prepare(sourceClaimSQL("source"))
    .bind(...sourceClaimCandidateBindings(now, true, "source")).all<{ id: number }>();
  expect(priority.results).toEqual([]);
  expect(priority.meta.rows_read).toBeLessThan(20);
});
