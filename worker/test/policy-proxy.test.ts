import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { policyPreviewCapability as capability } from "../src/policy-preview";

beforeEach(async () => {
  await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("INSERT INTO links(id,url,note,created_at) VALUES(1,'https://example.test/private','','2026-10-17')").run();
});
afterEach(() => vi.restoreAllMocks());
const settings = { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "reader-token",
  CAIRN_ENRICHER_TOKEN: "executor-token", CAIRN_POLICY_REPLAY_URL: "https://executor.test/private" };
function call(action: string, body?: unknown, token = "reader-token", configuration = settings, method = body === undefined ? "GET" : "POST") {
  return worker.fetch(new Request(`https://library.test/api/bookmarks/1/policy-replay/${action}`, { method,
    headers: { Authorization: `Bearer ${token}`, Cookie: "never-forward=private", "Content-Type": "application/json", [capability]: "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), configuration);
}
function response(body: unknown, status = 200, marked = true) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...(marked ? { [capability]: "1" } : {}) } });
}
function prepared(): Record<string, unknown> {
  const view = { topics: ["ai_coding"], content_functions: [], carriers: [], affordances: [], entities: [], form: "", use: "" };
  return { version: 1, id: 1, preview_key: "pending-intent", preview_hash: "a".repeat(64), status: "prepared", model_calls: 0,
    policy_version: "jev-policy-v5", policy_hash: "b".repeat(64), target_generation: 0, content_revision: 3, personal_revision: 0, before: view, after: view };
}
const previewBody = { version: 1, preview_key: "pending-intent" };
const applyBody = { ...previewBody, preview_hash: "a".repeat(64) };

it("proxies only a configured executor path with its private credential, no caller cookies or redirects", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("https://executor.test/private/api/app-policy/bookmarks/1/capabilities");
    expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("manual");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer executor-token"); expect(headers.get("Cookie")).toBeNull();
    expect(headers.get(capability)).toBe("1"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    return response({ version: 1, id: 1, supported: true, can_preview: true, can_apply: false, policy_version: "jev-policy-v5", model_calls: 0 });
  });
  const result = await call("capabilities"); expect(result.status).toBe(200); expect(result.headers.get("Cache-Control")).toContain("no-store");
  expect(await result.json()).toMatchObject({ can_apply: false, model_calls: 0 }); expect(fetch).toHaveBeenCalledTimes(1);
});

it("forwards only the immutable identity for explicit preview and apply", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input)); expect(init?.method).toBe("POST");
    if (url.pathname.endsWith("/preview")) { expect(JSON.parse(String(init?.body))).toEqual(previewBody); return response(prepared()); }
    expect(url.pathname).toBe("/private/api/app-policy/bookmarks/1/apply");
    expect(JSON.parse(String(init?.body))).toEqual(applyBody);
    return response({ ...prepared(), status: "applied", decision_id: 7, revision: 0, replayed: false });
  });
  expect((await call("preview", previewBody)).status).toBe(200);
  expect(await (await call("apply", applyBody)).json()).toMatchObject({ status: "applied", decision_id: 7, model_calls: 0 });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not call an executor for unauthorized, deleted, malformed or management-style requests", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
  expect((await call("capabilities", undefined, "wrong-token")).status).toBe(401);
  expect((await call("preview", { ...previewBody, policy: {} })).status).toBe(400);
  expect((await call("apply", { ...applyBody, spec_id: "arbitrary" })).status).toBe(400);
  expect((await call("preview", { ...previewBody, requested_model: "arbitrary" })).status).toBe(400);
  expect((await call("capabilities?unknown=1")).status).toBe(400);
  expect((await call("preview?preview_key=a&preview_key=b")).status).toBe(400);
  expect((await call("preview", { version: 1, preview_key: "x".repeat(5000) })).status).toBe(400);
  expect((await call("apply", undefined)).status).toBe(405);
  await env.DB.prepare("DELETE FROM links WHERE id=1").run();
  expect((await call("capabilities")).status).toBe(404); expect(fetch).not.toHaveBeenCalled();
});

it.each([undefined, "http://remote.test", "https://user:pass@executor.test", "https://executor.test?redirect=other", "not-a-url"])
  ("keeps an absent or invalid executor configuration explicitly unsupported: %s", async url => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
    const result = await call("capabilities", undefined, "reader-token", { ...settings, CAIRN_POLICY_REPLAY_URL: url as string });
    expect(result.status).toBe(501); expect(fetch).not.toHaveBeenCalled();
  });

it.each(["owner", "nonce", "hash", "calls", "target", "plan", "review_hash", "apply_not_applied"])
  ("keeps a malformed or foreign executor response unknown: %s", async change => {
    const body: Record<string, unknown> = { ...prepared(), status: "applied", decision_id: 7, revision: 0, replayed: false };
    if (change === "owner") body.id = 2;
    if (change === "nonce") body.preview_key = "other-intent";
    if (change === "hash") body.preview_hash = "c".repeat(64);
    if (change === "calls") body.model_calls = 1;
    if (change === "target") delete body.target_generation;
    if (change === "plan") body.plan = { private: true };
    if (change === "review_hash") body.review_hash = "c".repeat(64);
    if (change === "apply_not_applied") body.status = "prepared";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(body));
    const result = await call("apply", applyBody);
    expect(result.status).toBe(503); expect(fetch).toHaveBeenCalledTimes(1);
  });

it("cancels redirected or unmarked bodies and never repeats an ambiguous POST", async () => {
  let canceled = false;
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); }, cancel() { canceled = true; } });
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(stream, { status: 307, headers: { Location: "https://other.test" } }))
    .mockResolvedValueOnce(response({ error: "preview_changed" }, 409, false)).mockRejectedValueOnce(new Error("lost response"));
  expect((await call("apply", applyBody)).status).toBe(503); expect(canceled).toBe(true);
  expect((await call("apply", applyBody)).status).toBe(503);
  expect((await call("apply", applyBody)).status).toBe(503); expect(fetch).toHaveBeenCalledTimes(3);
});

it("bounds a chunked executor response and cancels the remaining bytes", async () => {
  let canceled = false, pulls = 0;
  const stream = new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(64 << 10)); }, cancel() { canceled = true; } });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { headers: { "Content-Type": "application/json", [capability]: "1" } }));
  expect((await call("preview", previewBody)).status).toBe(503); expect(canceled).toBe(true); expect(pulls).toBeLessThanOrEqual(7);
});
