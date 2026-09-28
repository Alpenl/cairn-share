import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { readSelectionSnapshots } from "../src/selection-state";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

// This is a repeatable local workload for S3. Timings are reported as evidence,
// never asserted as a CI threshold because shared runner load varies.
it("keeps a 50-link export bounded as each link's history grows", async () => {
  const ids: number[] = [];
  for (let index = 0; index < 50; index++) {
    const result = await env.DB.prepare("INSERT INTO links(url,created_at) VALUES (?,?)")
      .bind(`https://x.com/perf/status/${index + 1}`, "2026-09-29T00:00:00Z").run();
    ids.push(result.meta.last_row_id);
  }
  const metrics: Array<{ history: number; batch_ms: number; single_ms: number;
    batch_rows_read: number; single_rows_read: number; response_bytes: number }> = [];
  let previous = 0;
  for (const history of [1, 20, 100]) {
    const statement = `INSERT INTO curation_overrides
      (link_id,field,term,action,source,confirmed,revision,operation_key,created_at)
      WITH RECURSIVE seq(n) AS (SELECT ? UNION ALL SELECT n+1 FROM seq WHERE n<?)
      SELECT l.id,'topics','','reset','human',1,seq.n,
        printf('s3-%d-%d',l.id,seq.n),'2026-09-29T00:00:00Z'
      FROM links l CROSS JOIN seq WHERE l.id IN (${ids.map(() => "?").join(",")})`;
    await env.DB.prepare(statement).bind(previous + 1, history, ...ids).run();
    previous = history;

    const batchStarted = performance.now();
    const batch = await readSelectionSnapshots(env, ids);
    const batchMS = performance.now() - batchStarted;
    expect(batch.snapshots.size).toBe(50);
    let singleRowsRead = 0;
    const singleStarted = performance.now();
    for (let start = 0; start < ids.length; start += 4) {
      const singles = await Promise.all(ids.slice(start, start + 4)
        .map((id) => readSelectionSnapshots(env, [id])));
      singles.forEach((single, index) => {
        const id = ids[start + index];
        singleRowsRead += single.meta.rows_read;
        expect(single.snapshots.get(id)?.view).toEqual(batch.snapshots.get(id)?.view);
      });
    }
    const singleMS = performance.now() - singleStarted;
    const response = await worker.fetch(new Request("https://test/api/v2/links/effective-batch", {
      method: "POST", headers: { Authorization: "Bearer internal", "Content-Type": "application/json" },
      body: JSON.stringify({ ids })
    }), { ...env, CAIRN_ENRICHER_TOKEN: "internal", CAIRN_API_TOKEN: "app" });
    expect(response.status).toBe(200);
    const responseBytes = new TextEncoder().encode(await response.text()).length;
    metrics.push({ history, batch_ms: Math.round(batchMS * 100) / 100,
      single_ms: Math.round(singleMS * 100) / 100,
      batch_rows_read: batch.meta.rows_read, single_rows_read: singleRowsRead, response_bytes: responseBytes });
  }
  // Revision and D1 counters can grow a few digits; history rows must not be
  // serialized into the export response.
  expect(metrics[2].response_bytes - metrics[0].response_bytes).toBeLessThan(1024);
  console.log("S3 effective batch local workload", JSON.stringify(metrics));
});
