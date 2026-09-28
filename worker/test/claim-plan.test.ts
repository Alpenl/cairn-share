import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "vitest";

it("claims in priority order through the D1 index with bounded reads", async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(`WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<2000
  ) INSERT INTO links(url,created_at) SELECT 'https://x.com/u/status/'||n,'t' FROM seq`).run();
  const now = new Date().toISOString();
  const query = `SELECT id FROM links WHERE (
    lower(url) LIKE 'https://x.com/%' OR lower(url) LIKE 'http://x.com/%'
    OR lower(url) LIKE 'https://www.x.com/%' OR lower(url) LIKE 'http://www.x.com/%'
    OR lower(url) LIKE 'https://twitter.com/%' OR lower(url) LIKE 'http://twitter.com/%'
    OR lower(url) LIKE 'https://www.twitter.com/%' OR lower(url) LIKE 'http://www.twitter.com/%'
  ) AND curation_status <> 'drop'
    AND enrichment_status IN ('pending','failed','processing')
    AND enrichment_attempts < ?
    AND (enrichment_status='pending'
      OR (enrichment_status='failed' AND (enrichment_next_retry_at IS NULL OR enrichment_next_retry_at <= ?))
      OR (enrichment_status='processing' AND (enrichment_lease_until IS NULL OR enrichment_lease_until <= ?)))
    ORDER BY manual_source_priority DESC, id ASC LIMIT 1`;
  const forced = query.replace("FROM links", "FROM links INDEXED BY links_manual_source_priority_idx");
  const forcedPlan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${forced}`).bind(5, now, now).all<{ detail: string }>();
  const forcedResult = await env.DB.prepare(forced).bind(5, now, now).all<{ id: number }>();
  expect(forcedPlan.results.map(row => row.detail).join(" ")).toContain("links_manual_source_priority_idx");
  expect(forcedPlan.results.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
  expect(forcedResult.results).toEqual([{ id: 1 }]);
  expect(forcedResult.meta.rows_read).toBeLessThan(20);
  await env.DB.prepare("UPDATE links SET enrichment_status='completed'").run();
  const empty = await env.DB.prepare(forced).bind(5, now, now).all<{ id: number }>();
  expect(empty.results).toEqual([]);
  expect(empty.meta.rows_read).toBeLessThan(20);
});
