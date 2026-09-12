import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { taxonomy } from "../src/curation";

const appToken = "app-enrichment-test";
const enricherToken = "enricher-test";
const bindings = () => ({ DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: appToken, CAIRN_ENRICHER_TOKEN: enricherToken });

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

async function request(path: string, method = "GET", body?: unknown, token = appToken): Promise<Response> {
  return worker.fetch(new Request(`https://app.example${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), bindings());
}

async function seed(): Promise<number> {
  const response = await request("/api/links", "POST", { url: "https://x.com/example/status/123", note: "测试收藏" });
  return (await response.json() as { id: number }).id;
}

async function complete(id: number): Promise<void> {
  const claim = await request(`/api/enrichment/jobs/${id}/claim`, "POST", undefined, enricherToken);
  const { lease_token } = await claim.json() as { lease_token: string };
  const response = await request(`/api/enrichment/jobs/${id}/complete`, "POST", {
    lease_token, ai_title: "用于同步验证的中文标题", original_language: "en",
    original_text: "source-only-keyword " + "original ".repeat(6000), translated_text: "译文".repeat(10000),
    summary: "中文摘要", related_links: ["https://example.com/reference"], images: [], model: "fixture",
    classification: { topics: ["llm"], form: "tool", use: "try", why_suggestion: "用于研究", entities: ["项目甲"],
      uncertainty: false, taxonomy_version: taxonomy.version, discarded_tags: [] }
  }, enricherToken);
  expect(response.status).toBe(200);
}

describe("App enrichment integration", () => {
  it("searches literal percent, underscore and backslash characters in both list contracts", async () => {
    const special = await request("/api/links", "POST", { url: "https://example.com/literal", note: "100% a_b c\\d" });
    const id = (await special.json() as { id: number }).id;
    await request("/api/links", "POST", { url: "https://example.com/plain", note: "1000 axb cd" });
    for (const include of ["", "&include=enrichment"]) {
      for (const query of ["100%", "a_b", "c\\d"]) {
        const page = await (await request(`/api/links?q=${encodeURIComponent(query)}${include}`)).json() as any;
        expect(page.items.map((item: any) => item.id)).toEqual([id]);
      }
    }
  });

  it("rejects unsupported image types and cancels oversized streams without trusting headers", async () => {
    const id = await seed();
    const claim = await (await request(`/api/enrichment/jobs/${id}/claim`, "POST", undefined, enricherToken)).json() as any;
    const upload = () => request(`/api/enrichment/jobs/${id}/images`, "POST", {
      lease_token: claim.lease_token, image_urls: ["https://pbs.twimg.com/media/limits.png"]
    }, enricherToken);
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(new Response("<html>not an image</html>", { headers: { "Content-Type": "text/html" } }));
    expect((await upload()).status).toBe(502);
    for (const declared of [undefined, "4"]) {
      let chunks = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunks++ < 20) controller.enqueue(new Uint8Array(1024 * 1024));
          else controller.close();
        },
        cancel() { cancelled = true; }
      });
      const headers: Record<string, string> = { "Content-Type": "image/png" };
      if (declared !== undefined) headers["Content-Length"] = declared;
      fetch.mockResolvedValueOnce(new Response(body, { headers }));
      expect((await upload()).status).toBe(502);
      expect(cancelled).toBe(true);
      expect(chunks).toBeLessThan(20);
    }
    expect((await env.ENRICHMENT_IMAGES.list()).objects).toHaveLength(0);
  });

  it("keeps legacy reads stable and loads full content only in opted-in details", async () => {
    const id = await seed();
    await complete(id);
    const old = await (await request(`/api/links/${id}`)).json() as object;
    expect(Object.keys(old).sort()).toEqual(["created_at", "id", "learned", "learned_at", "note", "url"]);
    const response = await request("/api/links?include=enrichment");
    const text = await response.text();
    const page = JSON.parse(text);
    expect(page.items[0].enrichment).toMatchObject({ ai_title: "用于同步验证的中文标题", status: "completed", content_loaded: false });
    expect(page.items[0].enrichment).not.toHaveProperty("original_text");
    expect(text.length).toBeLessThan(2000);
    const detail = await (await request(`/api/links/${id}?include=enrichment`)).json() as any;
    expect(detail.enrichment.content_loaded).toBe(true);
    expect(detail.enrichment.original_text).toContain("source-only-keyword");
    expect(detail.enrichment.translated_text).toHaveLength(20000);
    expect(detail.enrichment.related_links).toEqual(["https://example.com/reference"]);
    for (const secret of ["lease_token", "enrichment_lease_token", "model", "error"]) {
      expect(detail.enrichment).not.toHaveProperty(secret);
    }
  });

  it("invalidates warmed list and detail caches when an internal job completes", async () => {
    const id = await seed();
    const paths = ["/api/links?include=enrichment", `/api/links/${id}?include=enrichment`];
    for (const path of paths) {
      await request(path);
      expect((await request(path)).headers.get("X-Cairn-Cache")).toBe("HIT");
    }
    await complete(id);
    for (const path of paths) {
      const response = await request(path);
      expect(response.headers.get("X-Cairn-Cache")).toBe("MISS");
      const body = await response.json() as any;
      expect((body.items?.[0] ?? body).enrichment.status).toBe("completed");
    }
  });

  it("returns current enriched content after learning and clears stale bodies after a URL edit", async () => {
    const id = await seed();
    await complete(id);
    const path = `/api/links/${id}?include=enrichment`;
    await request(path);
    const learned = await request(path, "PATCH", { learned: true });
    expect(learned.status).toBe(200);
    const retained = await learned.json() as any;
    expect(retained.learned).toBe(true);
    expect(retained.enrichment.original_text).toContain("source-only-keyword");
    const edited = await request(path, "PATCH", { url: "https://x.com/example/status/456" });
    expect(edited.status).toBe(200);
    const changed = await edited.json() as any;
    expect(changed.enrichment).toMatchObject({ status: "pending", original_text: null, translated_text: null, ai_title: null, content_loaded: true });
    const refreshed = await (await request(path)).json() as any;
    expect(refreshed.enrichment).toEqual(changed.enrichment);
  });

  it("shares human curation and filters across App and dashboard without changing source content", async () => {
    const id = await seed();
    await complete(id);
    await request("/api/links?include=enrichment&curation_status=kept&topic=eng");
    const edit = await request(`/api/links/${id}/curation`, "PATCH", {
      why: "准备在项目里使用", curation_status: "kept", classification: { topics: ["eng"], form: "method", use: "quote" }
    });
    expect(edit.status).toBe(200);
    const changed = await edit.json() as any;
    expect(changed.enrichment).toMatchObject({ status: "completed", why: "准备在项目里使用", classification_reviewed: true, classification: { topics: ["eng"] } });
    const internal = await (await request(`/api/enrichment/jobs/${id}`, "GET", undefined, enricherToken)).json() as any;
    expect(internal.why).toBe("准备在项目里使用");
    const kept = await (await request("/api/links?include=enrichment&curation_status=kept&topic=eng")).json() as any;
    expect(kept.items.map((item: any) => item.id)).toEqual([id]);
    const other = await (await request("/api/links?include=enrichment&topic=llm")).json() as any;
    expect(other.items).toEqual([]);
    const resetResponse = await request(`/api/links/${id}/curation`, "PATCH", { classification: null });
    const restored = await resetResponse.json() as any;
    expect(restored.enrichment.classification.topics).toEqual(["llm"]);
    expect(restored.enrichment.original_text).toContain("source-only-keyword");
  });

  it("searches source content while transferring only a summary and paginates filtered results", async () => {
    const first = await seed();
    const second = await seed();
    await complete(first);
    await complete(second);
    const path = "/api/links?include=enrichment&limit=1&q=source-only-keyword&topic=llm";
    const page = await (await request(path)).json() as any;
    expect(page.items.map((item: any) => item.id)).toEqual([second]);
    expect(page.next_before_id).toBe(second);
    const next = await (await request(`${path}&before_id=${second}`)).json() as any;
    expect(next.items.map((item: any) => item.id)).toEqual([first]);
    expect(next.next_before_id).toBeNull();
    expect((await request("/api/links?include=enrichment&topic=invented")).status).toBe(400);
  });

  it("offers compact internal lists while preserving full legacy responses", async () => {
    const id = await seed();
    await complete(id);
    const full = await (await request("/api/enrichment/jobs", "GET", undefined, enricherToken)).json() as any;
    const compact = await (await request("/api/enrichment/jobs?view=summary", "GET", undefined, enricherToken)).json() as any;
    expect(full.items[0].original_text.length).toBeGreaterThan(40000);
    expect(compact.items[0]).toMatchObject({ original_text: null, translated_text: null, content_loaded: false });
    expect(compact.items[0].ai_title).toBe(full.items[0].ai_title);
    expect(compact.counts).toEqual(full.counts);
  });

  it("requires App authentication for taxonomy, curation and archived images", async () => {
    const id = await seed();
    const key = `enrichment/${id}/${"a".repeat(64)}.png`;
    await env.ENRICHMENT_IMAGES.put(key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/png" } });
    for (const [path, method] of [["/api/taxonomy", "GET"], [`/api/links/${id}/curation`, "PATCH"], [`/api/images/${key}`, "GET"]]) {
      expect((await request(path, method, undefined, "")).status).toBe(401);
      expect((await request(path, method, undefined, enricherToken)).status).toBe(401);
    }
    expect(await (await request("/api/taxonomy")).json()).toEqual(taxonomy);
    const image = await request(`/api/images/${key}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await request(`/api/links/${id}/curation`, "PATCH", { classification: { topics: ["invented"], form: "", use: "" } })).status).toBe(400);
    expect((await request(`/api/enrichment/jobs/${id}/claim`, "POST")).status).toBe(401);
  });
});
