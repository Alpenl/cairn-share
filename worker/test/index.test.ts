import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("cairn-share worker", () => {
  it("saves a public link anonymously and preserves the exact URL and note", async () => {
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

  it("rejects invalid bodies and unsupported URL shapes with stable errors", async () => {
    await expectError(postRaw("{"), 400, "invalid_json");
    await expectError(postJson({ url: "ftp://example.com/file" }), 400, "invalid_url");
    await expectError(postJson({ url: "javascript:alert(1)" }), 400, "invalid_url");
    await expectError(postJson({ url: "http:///missing-host" }), 400, "invalid_url");
    await expectError(postJson({ url: "https://user:secret@example.com/a" }), 400, "invalid_url");
    await expectError(postJson({ url: "" }), 400, "invalid_url");
    await expectError(postJson({ url: "https://example.com", note: 1 }), 400, "invalid_note");
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

  it("validates list query parameters", async () => {
    await expectError(dispatch("/api/links?limit=0"), 400, "invalid_limit");
    await expectError(dispatch("/api/links?limit=101"), 400, "invalid_limit");
    await expectError(dispatch("/api/links?limit=abc"), 400, "invalid_limit");
    await expectError(dispatch("/api/links?before_id=0"), 400, "invalid_before_id");
    await expectError(dispatch("/api/links?before_id=abc"), 400, "invalid_before_id");
    await expectError(dispatch("/api/links?learned=maybe"), 400, "invalid_learned");
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

  it("validates learned state writes", async () => {
    const created = await create("https://example.com/state-errors");

    await expectError(patchRaw(created.id, "{"), 400, "invalid_json");
    await expectError(patchJson(created.id, { learned: "true" }), 400, "invalid_learned");
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
    expect(deletedLink.status).toBe(405);
    expect(deletedLink.headers.get("allow")).toBe("GET, PATCH, OPTIONS");
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

async function expectError(responsePromise: Promise<Response>, status: number, code: string): Promise<void> {
  const response = await responsePromise;
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ error: code });
}

async function json(response: Response): Promise<any> {
  return response.json();
}

async function dispatch(path: string, init?: RequestInit): Promise<Response> {
  const request = new Request(`https://cairn-share-api.example${path}`, init);
  return worker.fetch(request, env);
}
