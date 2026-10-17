import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import fixture from "./fixtures/entity-source-evidence-v1.json";

const bindings = () => ({ DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
  CAIRN_API_TOKEN: "source-app", CAIRN_ENRICHER_TOKEN: "source-internal" });
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(() => vi.restoreAllMocks());

async function request(path: string, method = "GET", token = "source-app", body?: unknown) {
  return worker.fetch(new Request(`https://test.example${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings());
}

async function snapshot(id: number, text = fixture.before + fixture.quote + fixture.after, truncated = false) {
  const saved = await request(`/api/v2/links/${id}/evidence`, "POST", "source-internal", {
    snapshot: { blocks: [{ id: "a", role: "quoted", text }], retrieval: "manual",
      fetched_at: "2026-10-17T00:00:00Z", truncation: { truncated } },
  });
  expect(saved.status).toBe(200);
  const response = await request(`/api/v2/links/${id}/evidence`, "GET", "source-internal");
  return await response.json() as { id: number; content_revision: number; content_hash: string };
}

async function seed(text?: string, truncated = false) {
  const created = await request("/api/links", "POST", "source-app", { url: "https://example.com/evidence" });
  const { id } = await created.json() as { id: number };
  const material = await snapshot(id, text, truncated);
  const query = new URLSearchParams({ snapshot_id: String(material.id), content_revision: String(material.content_revision),
    block_id: "a", start: "2", end: "6" });
  return { id, material, query, path: `/api/bookmarks/${id}/entity-evidence` };
}

it("reads a Unicode source span through both exact permissions without writes or a model call", async () => {
  const { id, material, query, path } = await seed();
  const counts = async () => env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM evidence_snapshots) AS snapshots,
    (SELECT COUNT(*) FROM classification_runs) AS runs,
    (SELECT COUNT(*) FROM classification_decisions) AS decisions,
    (SELECT COUNT(*) FROM curation_overrides) AS overrides,
    (SELECT COUNT(*) FROM enrichment_provider_attempts) AS reading_attempts,
    (SELECT COUNT(*) FROM classification_provider_attempts) AS classification_attempts,
    (SELECT COUNT(*) FROM budget_ledger) AS budget`).first();
  const before = await counts();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("read must remain local"));
  for (const [route, token] of [[path, "source-app"], [`/api/v2/links/${id}/entity-evidence`, "source-internal"]]) {
    const response = await request(`${route}?${query}`, "GET", token);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Cairn-Entity-Evidence")).toBe("1");
    expect(response.headers.get("Cache-Control")?.split(/,\s*/)).toContain("no-store");
    expect(await response.json()).toEqual({ ...fixture, bookmark_id: id,
      evidence_snapshot_id: material.id, content_revision: material.content_revision, content_hash: material.content_hash });
  }
  expect(await counts()).toEqual(before);
  expect(fetch).not.toHaveBeenCalled();
});

it("does not expose internal APIs or turn the evidence read into a write", async () => {
  const { id, path, query } = await seed();
  expect((await request(`${path}?${query}`, "GET", "wrong")).status).toBe(401);
  expect((await request(`${path}?${query}`, "GET", "")).status).toBe(401);
  expect((await request(`/api/v2/links/${id}/entity-evidence?${query}`)).status).toBe(401);
  expect((await request(`/api/v2/links/${id}/evidence`)).status).toBe(401);
  for (const method of ["POST", "PATCH", "DELETE", "HEAD"]) {
    expect((await request(`${path}?${query}`, method)).status).toBe(405);
  }
});

it("binds ownership and source revision, and never replaces a missing reference with current material", async () => {
  const { id, material, path, query } = await seed();
  const other = await request("/api/links", "POST", "source-app", { url: "https://example.com/other" });
  const otherID = (await other.json() as { id: number }).id;
  expect((await request(`/api/bookmarks/${otherID}/entity-evidence?${query}`)).status).toBe(404);
  const mismatch = new URLSearchParams(query); mismatch.set("content_revision", String(material.content_revision + 1));
  const conflict = await request(`${path}?${mismatch}`);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "evidence_reference_changed" });
  await snapshot(id, "new material must never replace the referenced block");
  const old = await (await request(`${path}?${query}`)).json() as typeof fixture;
  expect(old.quote).toBe("Acme"); expect(old.current).toBe(false);
  expect(old.evidence_snapshot_id).toBe(material.id);
  expect((await request(`/api/links/${id}`, "DELETE")).status).toBe(204);
  expect((await request(`${path}?${query}`)).status).toBe(404);
});

it("bounds context around the actual code-point span and retains snapshot incompleteness", async () => {
  const { path, query } = await seed("前".repeat(700) + "Acme" + "🙂".repeat(900), true);
  query.set("start", "700"); query.set("end", "704");
  const data = await (await request(`${path}?${query}`)).json() as typeof fixture;
  expect(data.before).toBe("前".repeat(480)); expect(data.after).toBe("🙂".repeat(480));
  expect(data.quote).toBe("Acme"); expect(data.context_start).toBe(220);
  expect(data.clipped_before).toBe(true); expect(data.clipped_after).toBe(true);
  expect(data.truncated).toBe(true); expect(data.completeness).toBe("truncated");
});

it("rejects ambiguous, invalid and unbounded query references", async () => {
  const { path, query } = await seed();
  const invalid = [`${query}&start=2`, `${query}&latest=1`, ""];
  for (const [key, value] of [["snapshot_id", "1e0"], ["start", "-1"], ["end", "100001"],
    ["end", "2"], ["block_id", ""], ["snapshot_id", "9007199254740992"]]) {
    const changed = new URLSearchParams(query); changed.set(key, value); invalid.push(changed.toString());
  }
  for (const changed of invalid) expect((await request(`${path}?${changed}`)).status).toBe(400);
  const invalidSpan = new URLSearchParams(query); invalidSpan.set("end", "100");
  expect((await request(`${path}?${invalidSpan}`)).status).toBe(400);
  query.set("block_id", "a' OR 1=1 --");
  const missing = await request(`${path}?${query}`);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("X-Cairn-Entity-Evidence")).toBe("1");
});
