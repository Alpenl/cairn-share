import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { archiveOldRunPayloads } from "../src/run-archive";

const bindings = () => ({ DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
  CAIRN_API_TOKEN: "history-app", CAIRN_ENRICHER_TOKEN: "history-internal" });
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(() => vi.restoreAllMocks());

async function request(path: string, method = "GET", token = "history-app", capability = "1", body?: unknown) {
  return worker.fetch(new Request(`https://test.example${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      "X-Cairn-App-Run-History": capability }, body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings());
}
async function link(suffix: string) {
  const response = await request("/api/links", "POST", "history-app", "1", { url: `https://example.com/${suffix}` });
  expect(response.status).toBe(201);
  return (await response.json() as { id: number }).id;
}
async function run(id: number, operation: string, created = "2026-10-17T00:00:00Z", revision = 1) {
  return (await env.DB.prepare(`INSERT INTO classification_runs(link_id,content_revision,spec_id,spec_hash,
    target_generation,requested_model,resolved_model,policy_version,policy,answers,usage,raw_judgments,
    operation_key,payload_hash,status,coverage,evidence_coverage,created_at)
    VALUES (?,?,'recorded-spec','recorded-hash',0,'recorded-request','','recorded-policy',
    '{"recorded":true}','{"topic":false}','{"input_tokens":17}',
    '{"metadata_version":1,"source":{"partial":true}}',?,?,'partial','partial','partial',?) RETURNING id`)
    .bind(id, revision, operation, "a".repeat(64), created).first<number>("id"))!;
}
async function counts() {
  return env.DB.prepare(`SELECT (SELECT COUNT(*) FROM classification_runs) AS runs,
    (SELECT COUNT(*) FROM classification_decisions) AS decisions,
    (SELECT COUNT(*) FROM curation_overrides) AS overrides,
    (SELECT COUNT(*) FROM classification_provider_attempts) AS attempts,
    (SELECT COUNT(*) FROM budget_ledger) AS budget`).first();
}

it("reads bounded newest-first summaries with stable cursors and no raw payloads, writes or provider calls", async () => {
  const id = await link("history-pages"), path = `/api/bookmarks/${id}/run-history`;
  const ids: number[] = [];
  for (let n = 0; n < 55; n++) ids.push(await run(id, `page-${n}`));
  const before = await counts();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("history must stay local"));
  const first = await request(path);
  expect(first.status).toBe(200);
  expect(first.headers.get("X-Cairn-App-Run-History")).toBe("1");
  expect(first.headers.get("Cache-Control")?.split(/,\s*/)).toContain("no-store");
  const a = await first.json() as { version: number; bookmark_id: number; runs: Record<string, unknown>[]; next_after_id: number };
  expect(a.version).toBe(1); expect(a.bookmark_id).toBe(id);
  expect(a.runs.map(row => row.id)).toEqual(ids.slice().reverse().slice(0, 50));
  for (const row of a.runs) {
    expect(row.resolved_model).toBe(""); expect(row.status).toBe("partial");
    for (const key of ["policy", "answers", "usage", "raw_judgments", "operation_key"]) expect(row).not.toHaveProperty(key);
  }
  expect(a.next_after_id).toBe(ids[5]);
  expect(await counts()).toEqual(before);
  const inserted = await run(id, "concurrent-insert");
  const second = await request(`${path}?after_id=${a.next_after_id}`);
  const b = await second.json() as typeof a;
  expect(b.runs.map(row => row.id)).toEqual(ids.slice(0, 5).reverse());
  expect(b.next_after_id).toBeNull(); expect(b.runs.some(row => row.id === inserted)).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it("loads one verified R2 record, retains unknown historical metadata and reports unavailable archives explicitly", async () => {
  const id = await link("history-archive"), other = await link("history-other");
  const old = await run(id, "old", "2026-01-01T00:00:00Z");
  await run(id, "current", "2026-10-17T00:00:00Z", 2);
  await env.DB.prepare("UPDATE links SET content_revision=2 WHERE id=?").bind(id).run();
  expect(await archiveOldRunPayloads(bindings(), "2026-09-01T00:00:00Z", "2026-10-17T00:00:00Z")).toBe(1);
  const row = await env.DB.prepare("SELECT answers,archive_key FROM classification_runs WHERE id=?").bind(old)
    .first<{ answers: string; archive_key: string }>();
  expect(row?.answers).toBe("{}"); expect(row?.archive_key).toBeTruthy();
  const before = await counts();
  const result = await request(`/api/bookmarks/${id}/run-history/${old}`);
  expect(result.status).toBe(200);
  const data = await result.json() as { version: number; bookmark_id: number; run: Record<string, unknown> };
  expect(data.version).toBe(1); expect(data.bookmark_id).toBe(id);
  expect(data.run).toMatchObject({ id: old, archived: true, status: "partial", resolved_model: "",
    requested_model: "recorded-request", policy: { recorded: true }, answers: { topic: false },
    usage: { input_tokens: 17 }, raw_judgments: { metadata_version: 1, source: { partial: true } } });
  expect(await counts()).toEqual(before);
  const mismatched = await request(`/api/bookmarks/${other}/run-history/${old}`);
  expect(mismatched.status).toBe(404); expect(mismatched.headers.get("X-Cairn-App-Run-History")).toBe("1");
  await env.ENRICHMENT_IMAGES.delete(row!.archive_key);
  const missing = await request(`/api/bookmarks/${id}/run-history/${old}`);
  expect(missing.status).toBe(503); expect(missing.headers.get("X-Cairn-App-Run-History")).toBe("1");
  expect(await missing.json()).toMatchObject({ error: "run_archive_unavailable" });
  expect((await request(`/api/links/${id}`, "DELETE")).status).toBe(204);
  expect((await request(`/api/bookmarks/${id}/run-history`)).status).toBe(404);
  expect((await request(`/api/bookmarks/${id}/run-history/${old}`)).status).toBe(404);
});

it("keeps authentication, method and query allowlists exact without exposing internal run writes", async () => {
  const id = await link("history-permissions"), runID = await run(id, "permissions"), path = `/api/bookmarks/${id}/run-history`;
  const before = await counts();
  for (const token of ["", "wrong", "history-internal"]) expect((await request(path, "GET", token)).status).toBe(401);
  expect((await request(path, "GET", "history-app", "")).status).toBe(409);
  for (const method of ["POST", "PATCH", "DELETE", "HEAD"]) {
    expect((await request(path, method)).status).toBe(405);
    expect((await request(`${path}/${runID}`, method)).status).toBe(405);
  }
  for (const query of ["after_id=0", "after_id=-1", "after_id=01", "after_id=1e0", "after_id=9007199254740992",
    "after_id=1&after_id=2", "limit=1000", "view=full", "url=https://other.example"]) {
    expect((await request(`${path}?${query}`)).status).toBe(400);
  }
  expect((await request(`${path}/${runID}?after_id=1`)).status).toBe(400);
  for (const internal of ["runs", `runs/${runID}`, "run-history", "question-specs", "policy-replays"]) {
    expect((await request(`/api/v2/links/${id}/${internal}`)).status).toBe(401);
  }
  expect(await counts()).toEqual(before);
});
