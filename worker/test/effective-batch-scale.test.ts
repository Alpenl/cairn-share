import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { resetObservabilityCacheForTest } from "../src/observability";

beforeEach(async () => {
  resetObservabilityCacheForTest();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// A large-library workload for the 500-item export limit. Report timings as
// local evidence only; shared CI runners cannot enforce latency thresholds.
it("keeps 500 exported views bounded in 2,000 and 10,000-link libraries", async () => {
  const measurements: Array<Record<string, number>> = [];
  for (const size of [2_000, 10_000]) {
    const previous = size === 2_000 ? 0 : 2_000;
    for (let first = previous + 1; first <= size; first += 500) {
      const last = Math.min(first + 499, size);
      await env.DB.prepare(`INSERT INTO links(url,created_at)
        WITH RECURSIVE seq(n) AS (SELECT ? UNION ALL SELECT n+1 FROM seq WHERE n<?)
        SELECT printf('https://x.com/scale/status/%d',n),'2026-09-29T00:00:00Z' FROM seq`)
        .bind(first, last).run();
    }
    for (const history of [0, 20]) {
      if (history > 0) {
        await env.DB.prepare(`UPDATE links
          SET original_text=replace(hex(zeroblob(8192)),'00','x')
          WHERE id BETWEEN ? AND ?`).bind(size - 499, size).run();
        await env.DB.prepare(`INSERT INTO curation_overrides
          (link_id,field,term,action,source,confirmed,revision,operation_key,created_at)
          WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<20)
          SELECT l.id,'topics','','reset','human',1,seq.n,
            printf('scale-%d-%d',l.id,seq.n),'2026-09-29T00:00:00Z'
          FROM links l CROSS JOIN seq WHERE l.id BETWEEN ? AND ?`)
          .bind(size - 499, size).run();
      }
      resetObservabilityCacheForTest();
      let effectivePrepares = 0;
      let policyPrepares = 0;
      let otherPrepares = 0;
      const countedDB = new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare") return (sql: string) => {
            if (sql.includes("FROM observability_policy")) policyPrepares++;
            else if (sql.includes("FROM links l WHERE")) effectivePrepares++;
            else otherPrepares++;
            return target.prepare(sql);
          };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as D1Database;
      let bytes = 0;
      let rowsRead = 0;
      const durations: number[] = [];
      const seen = new Set<number>();
      for (let first = size - 499; first <= size; first += 50) {
        const ids = Array.from({ length: 50 }, (_, offset) => first + offset);
        const started = performance.now();
        const response = await worker.fetch(new Request("https://test/api/v2/links/effective-batch", {
          method: "POST", headers: { Authorization: "Bearer internal", "Content-Type": "application/json" },
          body: JSON.stringify({ ids })
        }), { ...env, DB: countedDB, CAIRN_ENRICHER_TOKEN: "internal", CAIRN_API_TOKEN: "app" } satisfies Env);
        durations.push(performance.now() - started);
        expect(response.status).toBe(200);
        const wire = await response.text();
        expect(wire).not.toContain("x".repeat(100)); // stored article bodies stay private
        bytes += new TextEncoder().encode(wire).length;
        const body = JSON.parse(wire) as {
          items: Array<{ id: number }>;
          missing_ids: number[];
          d1: { scope: string; sql_count: number; rows_read: number; rows_written: number };
        };
        expect(body.items.map((item) => item.id)).toEqual(ids);
        expect(body.missing_ids).toEqual([]);
        expect(body.d1).toMatchObject({ scope: "effective_view_only", sql_count: 1, rows_written: 0 });
        rowsRead += body.d1.rows_read;
        body.items.forEach((item) => seen.add(item.id));
      }
      expect(seen.size).toBe(500);
      expect(bytes).toBeLessThan(250_000);
      // Ten effective queries plus one first-request policy read, with no
      // hidden query on the export route in this fixture.
      expect({ effectivePrepares, policyPrepares, otherPrepares }).toEqual({
        effectivePrepares: 10, policyPrepares: 1, otherPrepares: 0
      });
      measurements.push({ library_size: size, history_per_exported_link: history,
        body_bytes_per_exported_link: history > 0 ? 8192 : 0,
        export_items: seen.size, request_count: durations.length,
        effective_sql: effectivePrepares, policy_sql: policyPrepares,
        effective_rows_read: rowsRead, response_bytes: bytes,
        total_ms: Math.round(durations.reduce((sum, value) => sum + value, 0) * 100) / 100,
        max_batch_ms: Math.round(Math.max(...durations) * 100) / 100 });
    }
  }
  const policySQL = "SELECT version, logs, fallback_logs, diagnostic_until FROM observability_policy WHERE singleton = 1";
  const policyPlan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${policySQL}`).all<{ detail: string }>();
  expect(policyPlan.results.map((row) => row.detail).join(" ")).toMatch(/SEARCH observability_policy USING INTEGER PRIMARY KEY/);
  const policyResult = await env.DB.prepare(policySQL).all();
  expect(policyResult.results).toHaveLength(1);
  expect(policyResult.meta.rows_read).toBe(1);
  console.log("S3 scale workload", JSON.stringify(measurements));
}, 120_000);
