import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const bindings = () => ({ ...env, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
function call(path: string, token = "internal", method = "GET", body?: unknown) {
  return worker.fetch(new Request(`https://test/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), bindings());
}

it("checks a visible detail identity without transferring its article body", async () => {
  const created = await call("links", "app", "POST", { url: "https://x.com/u/status/100" });
  const { id } = await created.json() as { id: number };
  const longBody = "private article ".repeat(4000);
  await env.DB.prepare("UPDATE links SET original_text=?,enrichment_status='completed' WHERE id=?")
    .bind(longBody, id).run();
  const path = `enrichment/jobs/${id}/cache-identity`;
  expect((await call(path, "app")).status).toBe(401);
  expect((await call(path, "internal", "POST", {})).status).toBe(405);
  const response = await call(path);
  expect(response.status).toBe(200);
  const wire = await response.text();
  expect(wire).not.toContain("private article");
  expect(wire.length).toBeLessThan(500);
  const identity = JSON.parse(wire) as { cache_identity: Record<string, number>; status: string };
  const detail = await (await call(`enrichment/jobs/${id}?include_cache_identity=1`)).json() as {
    cache_identity: Record<string, number>; original_text: string;
  };
  expect(identity.cache_identity).toEqual(detail.cache_identity);
  expect(detail.original_text).toBe(longBody);
  await env.DB.prepare("UPDATE links SET personal_revision=personal_revision+1,why='changed' WHERE id=?")
    .bind(id).run();
  const changed = await (await call(path)).json() as typeof identity;
  expect(changed.cache_identity.personal_revision).toBeGreaterThan(identity.cache_identity.personal_revision);
  expect((await call("enrichment/jobs/99999/cache-identity")).status).toBe(404);
});
