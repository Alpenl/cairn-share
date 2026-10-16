import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "../src/api.mjs";
import { pagePreview, mediaPermissions, captureTab } from "../src/capture.mjs";

test("lookup asks the Worker with an encoded URL and the bearer token", async () => {
  const seen = [];
  const client = createClient({ apiBase: "http://127.0.0.1:1", fetchImpl: async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization, method: init.method });
    return Response.json({ saved: true, link: { id: 7, created_at: "2026-10-01T00:00:00Z", collections: [{ id: "c", name: "设计参考" }] } });
  } });
  const result = await client.lookup("secret", "https://example.com/a?b=1&c=中");
  assert.equal(result.saved, true);
  assert.equal(result.link.collections[0].name, "设计参考");
  assert.equal(seen[0].url, `http://127.0.0.1:1/api/links/lookup?url=${encodeURIComponent("https://example.com/a?b=1&c=中")}`);
  assert.equal(seen[0].auth, "Bearer secret");
  assert.equal(seen[0].method, "GET");
});

test("lookup degrades to null on Workers without the endpoint and rejects malformed answers", async () => {
  assert.equal(await createClient({ fetchImpl: async () => new Response("", { status: 404 }) }).lookup("secret", "https://example.com"), null);
  assert.deepEqual(await createClient({ fetchImpl: async () => Response.json({ saved: false }) }).lookup("secret", "https://example.com"), { saved: false });
  await assert.rejects(createClient({ fetchImpl: async () => Response.json({ ok: 1 }) }).lookup("secret", "https://example.com"), { kind: "response" });
  await assert.rejects(createClient({ fetchImpl: async () => new Response("", { status: 401 }) }).lookup("secret", "https://example.com"), { kind: "invalid_token" });
});

function fakeExt(result) {
  return { scripting: { executeScript: async ({ files }) => files ? [{ result: true }] : [{ result }] } };
}

test("page preview reports characters, images, videos and audio alongside origins", async () => {
  const ext = fakeExt({ text: "一二三四五", images: [{ url: "https://img.example/a.png" }, { url: "https://img.example/b.png" }],
    media: [{ kind: "video", url: "https://v.example/x.mp4" }, { kind: "audio", url: "" }], truncated: true, comments: 3 });
  const preview = await pagePreview(ext, 1, "https://example.com/post");
  assert.deepEqual(preview.stats, { chars: 5, images: 2, videos: 1, audios: 1, comments: 3, truncated: true });
  assert.deepEqual(preview.origins.sort(), ["https://img.example/*", "https://v.example/*"]);
  assert.deepEqual((await mediaPermissions(ext, 1, "https://example.com/post")).sort(), preview.origins.sort());
});

test("page preview tolerates empty extraction results", async () => {
  const preview = await pagePreview(fakeExt(null), 1, "https://x.com/a/status/1");
  assert.deepEqual(preview.stats, { chars: 0, images: 0, videos: 0, audios: 0, comments: 0, truncated: false });
  assert.ok(preview.origins.includes("https://video.twimg.com/*"));
});

test("the 采集评论区 choice reaches the page extractor for previews and captures", async () => {
  const calls = [];
  const ext = prefs => ({
    storage: { local: { get: async () => (prefs ? { cairn_prefs_v1: prefs } : {}) } },
    scripting: { executeScript: async ({ files, args }) => { if (files) return [{ result: true }]; calls.push(args[2]); return [{ result: { text: "正文", images: [], media: [] } }]; } }
  });
  await pagePreview(ext(null), 1, "https://example.com/a");
  await pagePreview(ext({ captureComments: false }), 1, "https://example.com/a");
  await captureTab(ext({ captureComments: false }), 1, "https://example.com/a", "id");
  await captureTab(ext({ captureComments: true }), 1, "https://example.com/a", "id");
  await captureTab(ext({ captureComments: true }), 1, "https://example.com/a", "id", { comments: false });
  await pagePreview(ext({ captureComments: false }), 1, "https://example.com/a", { comments: true });
  assert.deepEqual(calls, [{ comments: true }, { comments: false }, { comments: false }, { comments: true }, { comments: false }, { comments: true }]);
});
