import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const TEST_TOKEN = "cairn_test_token_123456789";
const TEST_ENRICHER_TOKEN = "cairn_enricher_test_token_123456789";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cairn-share worker", () => {
  it("applies schema migrations for pagination, cache generation and idempotent uploads", async () => {
    const index = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?"
    )
      .bind("links_learned_id_idx")
      .first<{ sql: string }>();
    expect(index?.sql).toContain("learned");
    expect(index?.sql).toContain("id DESC");

    const generation = await env.DB.prepare(
      "SELECT value FROM cache_metadata WHERE key = ?"
    )
      .bind("links_generation")
      .first<{ value: number }>();
    expect(generation?.value).toBe(1);

    const clientIdIndex = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?"
    )
      .bind("links_client_id_idx")
      .first<{ sql: string }>();
    expect(clientIdIndex?.sql).toContain("UNIQUE");
    expect(clientIdIndex?.sql).toContain("client_id");

    const columns = await env.DB.prepare("PRAGMA table_info(links)").all<{ name: string }>();
    expect(columns.results?.map((column) => column.name)).toEqual(expect.arrayContaining([
      "enrichment_status",
      "enrichment_attempts",
      "enrichment_lease_token",
      "ai_title",
      "original_language",
      "original_text",
      "translated_text",
      "summary",
      "related_links",
      "images",
      "enriched_at"
    ]));

    const enrichmentIndex = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?"
    )
      .bind("links_enrichment_queue_idx")
      .first<{ sql: string }>();
    expect(enrichmentIndex?.sql).toContain("enrichment_status");
    expect(enrichmentIndex?.sql).toContain("enrichment_next_retry_at");
  });

  it("serves an API debugging interface at the root path", async () => {
    const response = await dispatch("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toContain("total;dur=");
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("API 调试台");
    expect(body).toContain("POST /api/links");
    expect(body).toContain("PATCH /api/links/:id");
    expect(body).toContain("DELETE /api/links/:id");
    expect(body).toContain("访问 Token");
  });

  it("requires a bearer token for link API requests", async () => {
    const missing = await dispatch("/api/links", undefined, null);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    await expect(missing.json()).resolves.toEqual({ error: "missing_auth" });

    const invalid = await dispatch("/api/links", undefined, "wrong-token");
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toBe("Bearer");
    await expect(invalid.json()).resolves.toEqual({ error: "invalid_token" });

    const unconfigured = await dispatch("/api/links", undefined, TEST_TOKEN, "");
    expect(unconfigured.status).toBe(500);
    await expect(unconfigured.json()).resolves.toEqual({ error: "auth_not_configured" });

    const health = await dispatch("/health", undefined, null, "");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true });
  });

  it("protects enrichment jobs with a separate bearer token", async () => {
    const missing = await dispatchEnrichment("/api/enrichment/jobs/claim", { method: "POST" }, null);
    await expectError(Promise.resolve(missing), 401, "missing_auth");

    const appToken = await dispatch("/api/enrichment/jobs/claim", { method: "POST" });
    await expectError(Promise.resolve(appToken), 401, "invalid_token");

    const listMissing = await dispatchEnrichment("/api/enrichment/jobs", { method: "GET" }, null);
    await expectError(Promise.resolve(listMissing), 401, "missing_auth");

    const unconfigured = await dispatchEnrichment(
      "/api/enrichment/jobs/claim",
      { method: "POST" },
      TEST_ENRICHER_TOKEN,
      ""
    );
    await expectError(Promise.resolve(unconfigured), 500, "auth_not_configured");
  });

  it("atomically claims only X links in FIFO order", async () => {
    await create("https://example.com/not-an-x-link");
    const first = await create("https://x.com/example/status/100", "first note");
    const second = await create("https://Twitter.com/example/status/101", "second note");

    const firstClaim = await claimEnrichment();
    expect(firstClaim.status).toBe(200);
    const firstJob = await json(firstClaim);
    expect(firstJob).toMatchObject({ id: first.id, url: first.url, note: "first note", attempt: 1 });
    expect(firstJob.lease_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstJob.lease_until).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const secondClaim = await claimEnrichment();
    expect(secondClaim.status).toBe(200);
    await expect(secondClaim.json()).resolves.toMatchObject({ id: second.id, attempt: 1 });

    const empty = await claimEnrichment();
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");

    const claimed = await env.DB.prepare(
      "SELECT enrichment_status, enrichment_attempts FROM links WHERE id = ?"
    )
      .bind(first.id)
      .first<{ enrichment_status: string; enrichment_attempts: number }>();
    expect(claimed).toEqual({ enrichment_status: "processing", enrichment_attempts: 1 });
  });

  it("stores completed enrichment without changing the public link contract", async () => {
    const created = await create("https://x.com/example/status/200");
    const job = await json(await claimEnrichment());

    await expectError(
      completeEnrichment(created.id, {
        lease_token: "stale-token",
        original_text: "原文",
        summary: "简介",
        related_links: [],
        model: "grok-test"
      }),
      409,
      "lease_conflict"
    );

    const completed = await completeEnrichment(created.id, {
      lease_token: job.lease_token,
      ai_title: "一条由人工智能生成的中文测试标题",
      original_language: "en",
      original_text: "  完整原文  ",
      translated_text: "完整简体中文译文",
      summary: "  简短总结  ",
      related_links: ["https://example.com/source", "https://example.com/source"],
      images: [],
      model: "grok-test"
    });
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ id: created.id, status: "completed" });

    const stored = await env.DB.prepare(
      `SELECT enrichment_status, ai_title, original_language, original_text, translated_text,
              summary, related_links, images, enrichment_model, enrichment_lease_token, enriched_at
       FROM links WHERE id = ?`
    )
      .bind(created.id)
      .first<{
        enrichment_status: string;
        ai_title: string;
        original_language: string;
        original_text: string;
        translated_text: string;
        summary: string;
        related_links: string;
        images: string;
        enrichment_model: string;
        enrichment_lease_token: string | null;
        enriched_at: string;
      }>();
    expect(stored).toMatchObject({
      enrichment_status: "completed",
      ai_title: "一条由人工智能生成的中文测试标题",
      original_language: "en",
      original_text: "完整原文",
      translated_text: "完整简体中文译文",
      summary: "简短总结",
      related_links: JSON.stringify(["https://example.com/source"]),
      images: "[]",
      enrichment_model: "grok-test",
      enrichment_lease_token: null
    });
    expect(stored?.enriched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const publicLink = await json(await dispatch(`/api/links/${created.id}`));
    expect(publicLink).toMatchObject(created);
    expect(publicLink).not.toHaveProperty("summary");
    expect((await claimEnrichment()).status).toBe(204);
  });

  it("copies allow-listed X images to R2 and serves only stored object keys", async () => {
    const created = await create("https://x.com/example/status/205");
    const job = await json(await claimEnrichment());
    const imageUrl = "https://pbs.twimg.com/media/example-image?format=jpg&name=large";
    const imageBody = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(imageBody, {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Content-Length": String(imageBody.byteLength) }
    }));

    const uploaded = await storeImages(created.id, {
      lease_token: job.lease_token,
      image_urls: [imageUrl, imageUrl]
    });
    expect(uploaded.status).toBe(200);
    const uploadedBody = await json(uploaded);
    expect(uploadedBody.images).toHaveLength(1);
    expect(uploadedBody.images[0]).toMatchObject({ content_type: "image/jpeg" });
    expect(uploadedBody.images[0].key).toMatch(
      new RegExp(`^enrichment/${created.id}/[0-9a-f]{64}\\.jpg$`)
    );

    const object = await env.ENRICHMENT_IMAGES.head(uploadedBody.images[0].key);
    expect(object?.httpMetadata?.contentType).toBe("image/jpeg");

    const completed = await completeEnrichment(created.id, {
      lease_token: job.lease_token,
      ai_title: "图片内容的人工智能中文标题",
      original_language: "en",
      original_text: "original image post",
      translated_text: "图片帖子的简体中文译文",
      summary: "图片帖子摘要",
      related_links: [],
      images: uploadedBody.images,
      model: "grok-test"
    });
    expect(completed.status).toBe(200);

    const keyPath = uploadedBody.images[0].key.split("/").map(encodeURIComponent).join("/");
    const image = await dispatchEnrichment(`/api/enrichment/images/${keyPath}`, { method: "GET" });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(imageBody);

    const missingAuth = await dispatchEnrichment(
      `/api/enrichment/images/${keyPath}`,
      { method: "GET" },
      null
    );
    await expectError(Promise.resolve(missingAuth), 401, "missing_auth");
    await expectError(
      dispatchEnrichment("/api/enrichment/images/%E0%A4%A", { method: "GET" }),
      404,
      "not_found"
    );
  });

  it("rejects unsafe image sources and image uploads with a stale lease", async () => {
    const created = await create("https://x.com/example/status/206");
    const job = await json(await claimEnrichment());

    await expectError(
      storeImages(created.id, {
        lease_token: job.lease_token,
        image_urls: ["https://example.com/tracker.jpg"]
      }),
      400,
      "invalid_images"
    );
    await expectError(
      storeImages(created.id, {
        lease_token: "stale-token",
        image_urls: []
      }),
      409,
      "lease_conflict"
    );
  });

  it("lists X bookmarks, returns details and manually reclaims a selected item", async () => {
    const unsupported = await create("https://example.com/not-an-x-link", "其他收藏");
    const completed = await create("https://x.com/example/status/210", "已完成收藏");
    const claimed = await json(await claimEnrichment());
    await completeEnrichment(completed.id, {
      lease_token: claimed.lease_token,
      original_text: "完整帖子原文",
      summary: "可搜索的测试总结",
      related_links: ["https://example.com/relevant"],
      model: "grok-test"
    });
    const pending = await create("https://twitter.com/example/status/211", "待处理收藏");

    const firstPage = await dispatchEnrichment("/api/enrichment/jobs?limit=1", { method: "GET" });
    expect(firstPage.status).toBe(200);
    const firstPageBody = await json(firstPage);
    expect(firstPageBody.items).toHaveLength(1);
    expect(firstPageBody.items[0]).toMatchObject({
      id: pending.id,
      status: "pending",
      attempts: 0,
      related_links: []
    });
    expect(firstPageBody.items[0]).toMatchObject({ original_text: null, processable: true });
    expect(firstPageBody.items[0]).not.toHaveProperty("lease_token");
    expect(firstPageBody.next_before_id).toBe(pending.id);
    expect(firstPageBody.counts).toEqual({
      total: 3,
      pending: 1,
      processing: 0,
      completed: 1,
      failed: 0,
      exhausted: 0,
      unsupported: 1
    });

    const filtered = await dispatchEnrichment(
      `/api/enrichment/jobs?status=completed&q=${encodeURIComponent("测试总结")}`,
      { method: "GET" }
    );
    const filteredBody = await json(filtered);
    expect(filteredBody.items).toHaveLength(1);
    expect(filteredBody.items[0]).toMatchObject({
      id: completed.id,
      status: "completed",
      processable: true,
      original_text: "完整帖子原文",
      summary: "可搜索的测试总结",
      related_links: ["https://example.com/relevant"]
    });

    const unsupportedResponse = await dispatchEnrichment(
      "/api/enrichment/jobs?status=unsupported",
      { method: "GET" }
    );
    expect(unsupportedResponse.status).toBe(200);
    const unsupportedBody = await json(unsupportedResponse);
    expect(unsupportedBody.items).toEqual([
      expect.objectContaining({
        id: unsupported.id,
        status: "unsupported",
        processable: false,
        original_text: null
      })
    ]);

    const detail = await dispatchEnrichment(`/api/enrichment/jobs/${completed.id}`, { method: "GET" });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      id: completed.id,
      processable: true,
      original_text: "完整帖子原文"
    });

    const manual = await claimEnrichmentByID(completed.id);
    expect(manual.status).toBe(200);
    await expect(manual.json()).resolves.toMatchObject({ id: completed.id, attempt: 1 });
    await expectError(claimEnrichmentByID(completed.id), 409, "job_busy");
    await expectError(claimEnrichmentByID(999), 404, "not_found");
  });

  it("backs off failed jobs, recovers expired work and exhausts bounded retries", async () => {
    const created = await create("https://x.com/example/status/300");
    const firstJob = await json(await claimEnrichment());

    const failed = await failEnrichment(created.id, {
      lease_token: firstJob.lease_token,
      error: "temporary upstream failure"
    });
    expect(failed.status).toBe(200);
    const failureBody = await json(failed);
    expect(failureBody).toMatchObject({ id: created.id, status: "failed" });
    expect(failureBody.next_retry_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await claimEnrichment()).status).toBe(204);

    await env.DB.prepare(
      "UPDATE links SET enrichment_next_retry_at = ? WHERE id = ?"
    )
      .bind("2000-01-01T00:00:00.000Z", created.id)
      .run();
    const retryJob = await json(await claimEnrichment());
    expect(retryJob).toMatchObject({ id: created.id, attempt: 2 });

    await env.DB.prepare(
      "UPDATE links SET enrichment_attempts = ? WHERE id = ?"
    )
      .bind(5, created.id)
      .run();
    const exhausted = await failEnrichment(created.id, {
      lease_token: retryJob.lease_token,
      error: "permanent failure"
    });
    await expect(exhausted.json()).resolves.toEqual({
      id: created.id,
      status: "exhausted",
      next_retry_at: null
    });
    expect((await claimEnrichment()).status).toBe(204);
  });

  it("returns expired leases to the queue and resets enrichment after content edits", async () => {
    const created = await create("https://x.com/example/status/400", "old note");
    const firstJob = await json(await claimEnrichment());
    await env.DB.prepare(
      "UPDATE links SET enrichment_lease_until = ? WHERE id = ?"
    )
      .bind("2000-01-01T00:00:00.000Z", created.id)
      .run();

    const recovered = await json(await claimEnrichment());
    expect(recovered).toMatchObject({ id: created.id, attempt: 2 });
    expect(recovered.lease_token).not.toBe(firstJob.lease_token);
    await expectError(
      completeEnrichment(created.id, {
        lease_token: firstJob.lease_token,
        original_text: "stale",
        summary: "stale",
        related_links: [],
        model: "grok-test"
      }),
      409,
      "lease_conflict"
    );

    const completed = await completeEnrichment(created.id, {
      lease_token: recovered.lease_token,
      original_text: "fresh text",
      summary: "fresh summary",
      related_links: [],
      model: "grok-test"
    });
    expect(completed.status).toBe(200);

    await patchJson(created.id, { note: "new note" });
    const resetRow = await env.DB.prepare(
      `SELECT enrichment_status, enrichment_attempts, original_text, summary, enriched_at
       FROM links WHERE id = ?`
    )
      .bind(created.id)
      .first<{
        enrichment_status: string;
        enrichment_attempts: number;
        original_text: string | null;
        summary: string | null;
        enriched_at: string | null;
      }>();
    expect(resetRow).toEqual({
      enrichment_status: "pending",
      enrichment_attempts: 0,
      original_text: null,
      summary: null,
      enriched_at: null
    });
  });

  it("validates enrichment result shapes and methods", async () => {
    const created = await create("https://x.com/example/status/500");
    const job = await json(await claimEnrichment());

    await expectError(
      completeEnrichment(created.id, {
        lease_token: job.lease_token,
        original_text: "text",
        summary: "summary",
        related_links: ["javascript:alert(1)"],
        model: "grok-test"
      }),
      400,
      "invalid_enrichment"
    );
    await expectError(
      completeEnrichment(created.id, {
        lease_token: job.lease_token,
        ai_title: "人工智能生成的测试中文标题",
        original_language: "en",
        original_text: "text",
        translated_text: "译文",
        summary: "summary",
        related_links: [],
        images: [{
          key: `enrichment/${created.id}/${"a".repeat(64)}.jpg`,
          content_type: "image/jpeg"
        }],
        model: "grok-test"
      }),
      400,
      "invalid_enrichment"
    );
    await expectError(
      dispatchEnrichment(`/api/enrichment/jobs/${created.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}"
      }),
      400,
      "invalid_content_type"
    );

    const method = await dispatchEnrichment("/api/enrichment/jobs/claim", { method: "GET" });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST, OPTIONS");

    await expectError(
      dispatchEnrichment("/api/enrichment/jobs?status=unknown", { method: "GET" }),
      400,
      "invalid_status"
    );
  });

  it("saves a link with a valid bearer token and preserves the exact URL and note", async () => {
    const url = "HTTPS://Example.com/Article/Keep%2FCase?source=share#Section";
    const response = await dispatch("/api/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `  ${url}  `, note: "line one\n稍后阅读" })
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expect(response.json()).resolves.toMatchObject({
      id: 1,
      url,
      note: "line one\n稍后阅读",
      learned: false,
      learned_at: null
    });
  });

  it("defaults a missing note to an empty string and allows SQL text as data", async () => {
    const injected = "https://example.com/a?x=';DROP TABLE links;--#frag";
    const created = await create(injected);

    expect(created.note).toBe("");
    expect(created.url).toBe(injected);

    const listed = await json(await dispatch("/api/links"));
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].url).toBe(injected);
  });

  it("returns the original link when a queued upload retries with the same client id", async () => {
    const clientId = "3f55e9e8-4d52-4f45-a33d-89be8ef7ab45";
    const first = await postJson({
      url: "https://example.com/idempotent",
      note: "first attempt",
      client_id: clientId
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as LinkRecord;

    const retry = await postJson({
      url: "https://example.com/changed-on-retry",
      note: "retry payload",
      client_id: clientId
    });
    expect(retry.status).toBe(201);
    await expect(retry.json()).resolves.toMatchObject(created);

    const listed = await json(await dispatch("/api/links"));
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject(created);
  });

  it("rejects invalid bodies and unsupported URL shapes with stable errors", async () => {
    await expectError(postRaw("{"), 400, "invalid_json");
    await expectError(postJson({ url: "ftp://example.com/file" }), 400, "invalid_url");
    await expectError(postJson({ url: "javascript:alert(1)" }), 400, "invalid_url");
    await expectError(postJson({ url: "http:///missing-host" }), 400, "invalid_url");
    await expectError(postJson({ url: "https://user:secret@example.com/a" }), 400, "invalid_url");
    await expectError(postJson({ url: "" }), 400, "invalid_url");
    await expectError(postJson({ url: "https://example.com", note: 1 }), 400, "invalid_note");
    await expectError(postJson({ url: "https://example.com", client_id: "not-a-uuid" }), 400, "invalid_client_id");
    await expectError(postJson({ url: "https://example.com/" + "a".repeat(8190) }), 400, "invalid_url");
    await expectError(postJson({ url: "https://example.com", note: "n".repeat(2001) }), 400, "invalid_note");
  });

  it("requires JSON content for writes", async () => {
    const response = await dispatch("/api/links", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "https://example.com"
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_content_type" });
  });

  it("lists newest records first and paginates with before_id", async () => {
    const first = await create("https://example.com/1");
    const second = await create("https://example.com/2");
    const third = await create("https://example.com/3");

    const pageOne = await json(await dispatch("/api/links?limit=2"));
    expect(pageOne.items.map((item: LinkRecord) => item.id)).toEqual([third.id, second.id]);
    expect(pageOne.next_before_id).toBe(second.id);

    const pageTwo = await json(await dispatch(`/api/links?limit=2&before_id=${pageOne.next_before_id}`));
    expect(pageTwo.items.map((item: LinkRecord) => item.id)).toEqual([first.id]);
    expect(pageTwo.next_before_id).toBeNull();
  });

  it("filters records by learned state", async () => {
    const first = await create("https://example.com/unlearned-1");
    const second = await create("https://example.com/learned");
    const third = await create("https://example.com/unlearned-2");

    await patchLearned(second.id, true);

    const unlearned = await json(await dispatch("/api/links?learned=false"));
    expect(unlearned.items.map((item: LinkRecord) => item.id)).toEqual([third.id, first.id]);

    const learned = await json(await dispatch("/api/links?learned=true"));
    expect(learned.items.map((item: LinkRecord) => item.id)).toEqual([second.id]);

    const all = await json(await dispatch("/api/links?learned=all"));
    expect(all.items.map((item: LinkRecord) => item.id)).toEqual([third.id, second.id, first.id]);
  });

  it("searches URL and note while preserving learned filters", async () => {
    const docs = await create("https://example.com/docs/cairn", "项目文档");
    const recipe = await create("https://food.example/recipe", "Cairn 晚餐资料");
    const other = await create("https://example.com/other", "无关");

    await patchJson(recipe.id, { learned: true });

    const allMatches = await json(await dispatch("/api/links?q=cairn"));
    expect(allMatches.items.map((item: LinkRecord) => item.id)).toEqual([recipe.id, docs.id]);

    const learnedMatches = await json(await dispatch("/api/links?q=Cairn&learned=true"));
    expect(learnedMatches.items.map((item: LinkRecord) => item.id)).toEqual([recipe.id]);

    const noMatches = await json(await dispatch(`/api/links?q=${encodeURIComponent("not " + other.id)}`));
    expect(noMatches.items).toEqual([]);
  });

  it("caches equivalent list reads and advances generation after writes", async () => {
    const first = await create("https://example.com/cache-list-1", "cache");

    const firstRead = await dispatch("/api/links?q=cache&limit=20&learned=all");
    expect(firstRead.headers.get("x-cairn-cache")).toBe("MISS");
    expect(firstRead.headers.get("cache-control")).toContain("max-age=15");
    expect(firstRead.headers.get("server-timing")).toContain('cache-state;desc="MISS"');
    expect(firstRead.headers.get("server-timing")).toContain("generation;dur=");
    expect(firstRead.headers.get("server-timing")).toContain("db;dur=");
    expect((await json(firstRead)).items.map((item: LinkRecord) => item.id)).toEqual([first.id]);

    const reorderedRead = await dispatch("/api/links?learned=all&limit=20&q=cache");
    expect(reorderedRead.headers.get("x-cairn-cache")).toBe("HIT");
    expect(reorderedRead.headers.get("cache-control")).toContain("max-age=15");
    expect(reorderedRead.headers.get("server-timing")).toContain('cache-state;desc="HIT"');
    expect((await json(reorderedRead)).items.map((item: LinkRecord) => item.id)).toEqual([first.id]);

    const second = await create("https://example.com/cache-list-2", "cache");

    const afterWrite = await dispatch("/api/links?q=cache&limit=20&learned=all");
    expect(afterWrite.headers.get("x-cairn-cache")).toBe("MISS");
    expect(afterWrite.headers.get("server-timing")).toContain('cache-state;desc="MISS"');
    expect((await json(afterWrite)).items.map((item: LinkRecord) => item.id)).toEqual([second.id, first.id]);
  });

  it("caches detail reads and advances generation after update and delete", async () => {
    const created = await create("https://example.com/cache-detail", "old");

    const firstRead = await dispatch(`/api/links/${created.id}`);
    expect(firstRead.headers.get("x-cairn-cache")).toBe("MISS");
    expect(firstRead.headers.get("cache-control")).toContain("max-age=15");
    expect(firstRead.headers.get("server-timing")).toContain('cache-state;desc="MISS"');
    await expect(firstRead.json()).resolves.toMatchObject({ id: created.id, note: "old" });

    const cachedRead = await dispatch(`/api/links/${created.id}`);
    expect(cachedRead.headers.get("x-cairn-cache")).toBe("HIT");
    expect(cachedRead.headers.get("cache-control")).toContain("max-age=15");
    expect(cachedRead.headers.get("server-timing")).toContain('cache-state;desc="HIT"');
    await expect(cachedRead.json()).resolves.toMatchObject({ id: created.id, note: "old" });

    await patchJson(created.id, { note: "new" });

    const afterPatch = await dispatch(`/api/links/${created.id}`);
    expect(afterPatch.headers.get("x-cairn-cache")).toBe("MISS");
    expect(afterPatch.headers.get("server-timing")).toContain('cache-state;desc="MISS"');
    await expect(afterPatch.json()).resolves.toMatchObject({ id: created.id, note: "new" });

    const deleted = await dispatch(`/api/links/${created.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    await expectError(dispatch(`/api/links/${created.id}`), 404, "not_found");
  });

  it("bypasses shared read cache when a request carries cookie headers", async () => {
    const created = await create("https://example.com/private-cache", "private");

    const cached = await dispatch(`/api/links/${created.id}`);
    expect(cached.headers.get("x-cairn-cache")).toBe("MISS");

    const privateRead = await dispatch(`/api/links/${created.id}`, {
      headers: { Cookie: "session=private" }
    });
    expect(privateRead.headers.get("x-cairn-cache")).toBe("BYPASS");
    expect(privateRead.headers.get("server-timing")).toContain('cache-state;desc="BYPASS"');
    await expect(privateRead.json()).resolves.toMatchObject({ id: created.id, note: "private" });
  });

  it("validates list query parameters", async () => {
    await expectError(dispatch("/api/links?limit=0"), 400, "invalid_limit");
    await expectError(dispatch("/api/links?limit=101"), 400, "invalid_limit");
    await expectError(dispatch("/api/links?limit=abc"), 400, "invalid_limit");
    await expectError(dispatch("/api/links?before_id=0"), 400, "invalid_before_id");
    await expectError(dispatch("/api/links?before_id=abc"), 400, "invalid_before_id");
    await expectError(dispatch("/api/links?learned=maybe"), 400, "invalid_learned");
    await expectError(dispatch(`/api/links?q=${"q".repeat(201)}`), 400, "invalid_query");
  });

  it("reads individual records and hides missing rows behind JSON 404", async () => {
    const created = await create("https://example.com/read?x=1#frag", "unicode 备注");

    const response = await dispatch(`/api/links/${created.id}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject(created);

    await expectError(dispatch("/api/links/999"), 404, "not_found");
  });

  it("marks a link learned and can move it back to unlearned", async () => {
    const created = await create("https://example.com/state");

    const learned = await patchLearned(created.id, true);
    expect(learned.learned).toBe(true);
    expect(learned.learned_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const unlearned = await patchLearned(created.id, false);
    expect(unlearned.learned).toBe(false);
    expect(unlearned.learned_at).toBeNull();

    const readBack = await json(await dispatch(`/api/links/${created.id}`));
    expect(readBack).toMatchObject(unlearned);
  });

  it("updates URL, note and learned state in one PATCH", async () => {
    const created = await create("https://example.com/original", "old");

    const updated = await json(await patchJson(created.id, {
      url: "  https://example.com/updated?x=1#frag  ",
      note: "新的备注",
      learned: true
    }));

    expect(updated).toMatchObject({
      id: created.id,
      url: "https://example.com/updated?x=1#frag",
      note: "新的备注",
      learned: true
    });
    expect(updated.learned_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const readBack = await json(await dispatch(`/api/links/${created.id}`));
    expect(readBack).toMatchObject(updated);
  });

  it("deletes links and keeps missing deletes JSON shaped", async () => {
    const created = await create("https://example.com/delete-me");

    const deleted = await dispatch(`/api/links/${created.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");

    await expectError(dispatch(`/api/links/${created.id}`), 404, "not_found");
    await expectError(dispatch(`/api/links/${created.id}`, { method: "DELETE" }), 404, "not_found");
  });

  it("validates learned state writes", async () => {
    const created = await create("https://example.com/state-errors");

    await expectError(patchRaw(created.id, "{"), 400, "invalid_json");
    await expectError(patchJson(created.id, { learned: "true" }), 400, "invalid_learned");
    await expectError(patchJson(created.id, {}), 400, "invalid_update");
    await expectError(patchJson(created.id, { url: "ftp://example.com/file" }), 400, "invalid_url");
    await expectError(patchJson(created.id, { note: 1 }), 400, "invalid_note");
    await expectError(patchJson(created.id, { note: "n".repeat(2001) }), 400, "invalid_note");
    await expectError(patchJson(999, { learned: true }), 404, "not_found");

    const response = await dispatch(`/api/links/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ learned: true })
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_content_type" });
  });

  it("returns health, CORS preflight, 404 and 405 without leaking internals", async () => {
    await expect(json(await dispatch("/health"))).resolves.toEqual({ ok: true });

    const options = await dispatch("/api/links", { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe("*");
    expect(options.headers.get("access-control-allow-credentials")).toBeNull();

    await expectError(dispatch("/missing"), 404, "not_found");

    const deleted = await dispatch("/api/links", { method: "DELETE" });
    expect(deleted.status).toBe(405);
    expect(deleted.headers.get("allow")).toBe("GET, POST, OPTIONS");
    await expect(deleted.json()).resolves.toEqual({ error: "method_not_allowed" });

    const deletedLink = await dispatch("/api/links/1", { method: "DELETE" });
    expect(deletedLink.status).toBe(404);
    await expect(deletedLink.json()).resolves.toEqual({ error: "not_found" });

    const putLink = await dispatch("/api/links/1", { method: "PUT" });
    expect(putLink.status).toBe(405);
    expect(putLink.headers.get("allow")).toBe("GET, PATCH, DELETE, OPTIONS");
  });
});

interface LinkRecord {
  id: number;
  url: string;
  note: string;
  created_at: string;
  learned: boolean;
  learned_at: string | null;
}

async function create(url: string, note?: string): Promise<LinkRecord> {
  const response = await postJson(note === undefined ? { url } : { url, note });
  expect(response.status).toBe(201);
  return await response.json();
}

async function postJson(body: unknown): Promise<Response> {
  return dispatch("/api/links", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });
}

async function postRaw(body: string): Promise<Response> {
  return dispatch("/api/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
}

async function patchLearned(id: number, learned: boolean): Promise<LinkRecord> {
  const response = await patchJson(id, { learned });
  expect(response.status).toBe(200);
  return await response.json();
}

async function patchJson(id: number, body: unknown): Promise<Response> {
  return dispatch(`/api/links/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });
}

async function patchRaw(id: number, body: string): Promise<Response> {
  return dispatch(`/api/links/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body
  });
}

async function claimEnrichment(): Promise<Response> {
  return dispatchEnrichment("/api/enrichment/jobs/claim", { method: "POST" });
}

async function claimEnrichmentByID(id: number): Promise<Response> {
  return dispatchEnrichment(`/api/enrichment/jobs/${id}/claim`, { method: "POST" });
}

async function completeEnrichment(id: number, body: unknown): Promise<Response> {
  return dispatchEnrichment(`/api/enrichment/jobs/${id}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });
}

async function failEnrichment(id: number, body: unknown): Promise<Response> {
  return dispatchEnrichment(`/api/enrichment/jobs/${id}/fail`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });
}

async function storeImages(id: number, body: unknown): Promise<Response> {
  return dispatchEnrichment(`/api/enrichment/jobs/${id}/images`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });
}

async function expectError(responsePromise: Promise<Response>, status: number, code: string): Promise<void> {
  const response = await responsePromise;
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ error: code });
}

async function json(response: Response): Promise<any> {
  return response.json();
}

async function dispatch(
  path: string,
  init?: RequestInit,
  token: string | null = TEST_TOKEN,
  configuredToken: string = TEST_TOKEN,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token !== null) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const request = new Request(`https://cairn-share-api.example${path}`, {
    ...init,
    headers,
  });
  return worker.fetch(request, {
    DB: env.DB,
    ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
    CAIRN_API_TOKEN: configuredToken,
    CAIRN_ENRICHER_TOKEN: TEST_ENRICHER_TOKEN,
  } satisfies Env);
}

async function dispatchEnrichment(
  path: string,
  init?: RequestInit,
  token: string | null = TEST_ENRICHER_TOKEN,
  configuredToken: string = TEST_ENRICHER_TOKEN
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token !== null) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const request = new Request(`https://cairn-share-api.example${path}`, {
    ...init,
    headers
  });
  return worker.fetch(request, {
    DB: env.DB,
    ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
    CAIRN_API_TOKEN: TEST_TOKEN,
    CAIRN_ENRICHER_TOKEN: configuredToken
  } satisfies Env);
}
