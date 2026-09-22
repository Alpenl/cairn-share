import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const key = (n: number) => n.toString(16).padStart(64, "0");
const limits = { max_calls_total: 20, max_calls_per_item: 2, max_tokens: 20 * 65536, max_tokens_per_item: 2 * 65536 };
async function seed(n = 1) {
  for (let id = 1; id <= n; id++) await env.DB.prepare("INSERT INTO links(id,url,note,created_at) VALUES (?,?,'','2026-01-01')").bind(id, `https://example.com/${id}`).run();
}
async function reserve(n: number, items = [1], extra = {}, token = "internal") {
  return worker.fetch(new Request("https://test/api/v2/extension-budget/reserve", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operation_key: key(n), kind: "entity", item_ids: items, tokens: 65536, limits, ...extra })
  }), { ...env, CAIRN_ENRICHER_TOKEN: "internal", CAIRN_API_TOKEN: "app" });
}

it("charges a durable per-item budget across independent requests; duplicate never re-grants", async () => {
  await seed();
  expect(await (await reserve(1)).json()).toMatchObject({ granted: true });
  expect(await (await reserve(1)).json()).toMatchObject({ granted: false, reason: "already_reserved" });
  expect(await (await reserve(2)).json()).toMatchObject({ granted: true });
  expect(await (await reserve(3)).json()).toMatchObject({ granted: false, reason: "budget_exhausted" });
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE scope='extension_global'").first("n")).toBe(2);
});

it("serializes concurrent global reservations and counts all extension kinds together", async () => {
  await seed(4);
  const responses = await Promise.all([1, 2, 3, 4].map(n => reserve(n, [n], { kind: n % 2 ? "rerank" : "evidence", tokens: n % 2 ? 65536 : 0, limits: { ...limits, max_calls_total: 1 } })));
  const bodies = await Promise.all(responses.map(r => r.json() as Promise<{ granted: boolean }>));
  expect(bodies.filter(b => b.granted)).toHaveLength(1);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE scope='extension_global'").first("n")).toBe(1);
});

it("counts full reservation against each candidate and both token limits", async () => {
  await seed(3);
  const global = { ...limits, max_tokens: 2 * 65536 };
  expect(await (await reserve(1, [1, 2], { limits: global })).json()).toMatchObject({ granted: true });
  expect(await (await reserve(2, [1], { limits: { ...global, max_tokens_per_item: 65536 } })).json()).toMatchObject({ granted: false });
  expect(await (await reserve(3, [3], { limits: global })).json()).toMatchObject({ granted: true });
  expect(await (await reserve(4, [2], { limits: global })).json()).toMatchObject({ granted: false });
});

it("a lost grant response and changed payload cannot authorize a second call", async () => {
  await seed(2);
  await reserve(1); // Deliberately discard the committed response.
  expect(await (await reserve(1)).json()).toMatchObject({ granted: false, reason: "already_reserved" });
  expect((await reserve(1, [2])).status).toBe(409);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE scope='extension_item'").first("n")).toBe(1);
});

it("deletion removes link reservations without refunding the global budget", async () => {
  await seed(2);
  const tight = { ...limits, max_calls_total: 1 };
  await reserve(1, [1], { limits: tight });
  await env.DB.prepare("DELETE FROM links WHERE id=1").run();
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE link_id=1").first("n")).toBe(0);
  expect(await (await reserve(2, [2], { limits: tight })).json()).toMatchObject({ granted: false });
  expect((await reserve(3, [1])).status).toBe(404);
});

it("only the current UTC day consumes the daily cap; callers cannot choose a day", async () => {
  await seed();
  await reserve(1);
  await env.DB.prepare("UPDATE budget_ledger SET created_at='2000-01-01T00:00:00.000Z'").run();
  expect(await (await reserve(2, [1], { limits: { ...limits, max_calls_total: 1 } })).json()).toMatchObject({ granted: true });
  expect((await reserve(3, [1], { day: "2000-01-01" })).status).toBe(400);
});

it("rejects App access, widened/invalid limits, bad units and unbounded candidate sets", async () => {
  await seed();
  expect((await reserve(1, [1], {}, "app")).status).toBe(401);
  for (const extra of [{ tokens: -1 }, { tokens: 0 }, { tokens: 1.5 }, { tokens: 4001 }, { kind: "unknown" },
    { limits: { ...limits, max_calls_total: 21 } }, { limits: { ...limits, max_calls_per_item: 3 } },
    { limits: { ...limits, max_tokens: 20 * 65536 + 1 } }, { limits: { ...limits, max_tokens_per_item: 0 } }]) {
    expect((await reserve(2, [1], extra)).status).toBe(400);
  }
  for (const items of [[], [1, 1], Array.from({ length: 21 }, (_, i) => i + 1), [-1]]) expect((await reserve(3, items)).status).toBe(400);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger").first("n")).toBe(0);
});
