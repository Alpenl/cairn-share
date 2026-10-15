import { chromium, expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../scripts/build.mjs";

const token = "cairn_c_" + "c".repeat(64);
let context, server, origin, extensionURL, worker, root;
let version = 18, offline = false, missing = false;
const posts = [], tagRequests = [];
const topics = [["system/topics/llm", "大语言模型", 6], ["system/topics/ml", "机器学习", 4], ["system/topics/design", "设计系统", 3], ["system/topics/lora", "LoRA", 1]];
const kinds = [["system/resource_kinds/blog", "博客文章", 5], ["system/resource_kinds/paper", "论文", 2]];
const carriers = [["system/carriers/web", "网页", 6], ["system/carriers/pdf", "PDF", 2]];
const added = [["system/topics/agent", "智能体", 1]];
const dimension = (id, label, color, selection_mode, rows) => ({ id, label, color, selection_mode, tags: rows.map(([tag_ref, name, count]) => ({ tag_ref, label: name, count })) });
const catalog = () => ({ catalog_version: version, dimensions: [dimension("topics", "主题", 0, "multiple", version > 18 ? [...topics, ...added] : topics), dimension("resource_kinds", "资源类型", 1, "multiple", kinds), dimension("carriers", "载体", 3, "single", carriers)] });

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const path = request.url.replace(/^\/api\/v1\/collector/, "");
    const ok = (data, headers = {}) => { response.writeHead(200, { "Content-Type": "application/json", "X-Cairn-Collections": "1", ...headers }); response.end(JSON.stringify({ code: "OK", data })); };
    if (!request.url.startsWith("/api/v1/collector/")) { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end("<!doctype html><title>标签测试</title><p>正文</p>"); return; }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
    if (path === "/tags") {
      tagRequests.push(request.headers["if-none-match"] || "");
      if (offline) { response.writeHead(503); response.end(); return; }
      if (missing) { response.writeHead(404); response.end("{}"); return; }
      const etag = `W/"tags-${version}"`;
      if (request.headers["if-none-match"] === etag) { response.writeHead(304, { ETag: etag }); response.end(); return; }
      return ok(catalog(), { ETag: etag });
    }
    if (path.startsWith("/links/lookup")) return ok({ saved: false });
    if (path.startsWith("/collections")) return ok({ items: [] });
    if (request.method === "GET") return ok({ items: [] });
    let raw = ""; for await (const part of request) raw += part;
    const body = JSON.parse(raw); posts.push({ path, body });
    return ok({ id: posts.length, url: body.url, note: body.note, completed: true, reuse_existing: true, capture_result: { action: "saved", images_saved: 0, tags_saved: body.tag_refs?.length || 0 } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  root = await mkdtemp(join(tmpdir(), "cairn-tags-"));
  await build({ outputRoot: join(root, "build"), apiBase: origin, pack: false });
  const extensionPath = join(root, "build", "chrome");
  context = await chromium.launchPersistentContext(join(root, "profile"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox"] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const workerURL = new URL(worker.url());
  extensionURL = `${workerURL.protocol}//${workerURL.host}`;
});

test.afterAll(async () => {
  await context?.close();
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  await rm(root, { recursive: true, force: true });
});

async function openPopup(url = "https://example.com/tagged-article") {
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.addInitScript((u) => { chrome.tabs.query = async () => [{ url: u, title: "视觉创作工作流：从参考图到成片的素材管理" }]; }, url);
  await popup.goto(`${extensionURL}/popup.html`);
  return popup;
}
const cache = () => worker.evaluate(async () => (await chrome.storage.local.get("cairn_tags_v1")).cairn_tags_v1);

test("tag cloud: first fetch, cached open, version check, refresh, offline and settings", async () => {
  const options = await context.newPage();
  await options.goto(`${extensionURL}/options.html`);
  await options.locator("#token").fill(token);
  await options.locator("#connect").click();
  await expect(options.locator("#status")).toContainText("连接成功");
  await expect(options.locator("#settings-form")).toBeHidden();
  await expect(options.locator("#tag-title")).toHaveText("本地没有标签缓存");

  // First open: skeleton, then the catalog is stored with its version.
  let popup = await openPopup();
  await expect(popup.locator("#tag-cloud .tag")).toHaveCount(8);
  expect(tagRequests).toEqual([""]);
  expect((await cache()).version).toBe(18);
  await expect(popup.locator("#tag-filter button")).toHaveText(["全部8", "主题4", "类型2", "载体2"]);
  await expect(popup.locator(".tag", { hasText: "大语言模型" })).toHaveClass(/s3/);
  await expect(popup.locator(".tag", { hasText: "LoRA" })).toHaveClass(/s1/);
  await popup.screenshot({ path: "test-results/popup-tags.png" });

  // Multi-select, single choice within 载体, filter tabs.
  await popup.locator(".tag", { hasText: "设计系统" }).click();
  await popup.locator(".tag", { hasText: "网页" }).click();
  await popup.locator(".tag", { hasText: "PDF" }).click();
  await expect(popup.locator(".tag", { hasText: "网页" })).toHaveAttribute("aria-pressed", "false");
  await expect(popup.locator("#tags-aux")).toHaveText("已选 2");
  await expect(popup.locator("#tags-picked")).toHaveText("已选：设计系统、PDF");
  await popup.locator("#tag-filter button", { hasText: "载体" }).click();
  await expect(popup.locator("#tag-cloud .tag")).toHaveCount(2);
  await popup.locator("#tag-filter button", { hasText: "全部" }).click();
  await popup.locator("#note").fill("命名和版本管理的思路很清楚。");
  await popup.screenshot({ path: "test-results/popup-tags-picked.png" });
  await popup.locator("#save").click();
  await expect(popup.locator("#status")).toContainText("2 个标签");
  expect(posts.at(-1).body.tag_refs).toEqual(["system/topics/design", "system/carriers/pdf"]);
  await expect(popup.locator(".tag", { hasText: "设计系统" })).toBeDisabled();
  await popup.screenshot({ path: "test-results/popup-tags-saved.png" });
  await popup.close();

  // The library changes: the cache renders at once, the check only announces it.
  version = 19;
  popup = await openPopup("https://example.com/second");
  await expect(popup.locator("#tags-stale")).toContainText("收藏库标签已更新（新增 1 个）");
  await expect(popup.locator("#tags-refresh")).toHaveClass(/has-update/);
  await expect(popup.locator("#tag-cloud .tag")).toHaveCount(8);
  expect(tagRequests.at(-1)).toBe('W/"tags-18"');
  expect((await cache()).version).toBe(18);
  await popup.screenshot({ path: "test-results/popup-tags-stale.png" });
  await popup.locator("#tags-stale button").click();
  await expect(popup.locator("#tag-cloud .tag")).toHaveCount(9);
  await expect(popup.locator(".tag", { hasText: "智能体" })).toHaveClass(/new/);
  await expect(popup.locator("#tags-sync")).toContainText("已同步");
  await expect(popup.locator("#tags-stale")).toBeHidden();
  expect((await cache()).version).toBe(19);
  await popup.close();

  // Unchanged library: one 304, nothing rewritten.
  popup = await openPopup("https://example.com/third");
  await expect.poll(() => tagRequests.at(-1)).toBe('W/"tags-19"');
  await expect(popup.locator("#tags-sync")).toContainText("本地");
  await popup.close();

  // Offline: keep the cache and offer a retry.
  offline = true;
  popup = await openPopup("https://example.com/offline");
  await expect(popup.locator("#tags-offline")).toContainText("显示本地缓存");
  await expect(popup.locator("#tag-cloud .tag")).toHaveCount(9);
  await popup.screenshot({ path: "test-results/popup-tags-offline.png" });
  offline = false;
  await popup.locator("#tags-offline button").click();
  await expect(popup.locator("#tags-offline")).toBeHidden();
  await popup.close();

  // Settings: cache summary, switches and clearing.
  await options.reload();
  await expect(options.locator("#tag-title")).toHaveText("本地标签 9 个 · 3 个类型");
  await expect(options.locator("#tag-version")).toHaveText("v19");
  await options.setViewportSize({ width: 1280, height: 1480 });
  await options.screenshot({ path: "test-results/options-v2.png", fullPage: true });
  await options.locator("#tag-auto").evaluate((input) => input.click());
  expect(await worker.evaluate(async () => (await chrome.storage.local.get("cairn_prefs_v1")).cairn_prefs_v1.tagAutoCheck)).toBe(false);
  await options.locator("#keep-full-url").evaluate((input) => input.click());
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get("cairn_capture_v1")).cairn_capture_v1.settings.keepFullUrl)).toBe(false);
  await options.locator("#change-token").click();
  await expect(options.locator("#token")).toBeVisible();
  await options.locator("#change-token").click();
  await options.locator("#tags-clear").click();
  await expect(options.locator("#status")).toContainText("已清除本地标签缓存");
  expect(await cache()).toBeUndefined();

  // A Go server without the tag endpoint hides the section.
  missing = true;
  popup = await openPopup("https://example.com/old-server");
  await expect(popup.locator("#save")).toBeEnabled();
  await expect.poll(async () => (await cache())?.unsupported).toBe(true);
  await expect(popup.locator("#tags")).toBeHidden();
  await popup.close();
  missing = false;
  await options.close();
});
