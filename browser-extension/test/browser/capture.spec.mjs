import { chromium, expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../scripts/build.mjs";

let context, server, origin, extensionURL, worker, root;
let offline = false, holdResponse = false, releaseResponse;
const posts = [];
const records = new Map();
const errors = [];

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    if (request.url.startsWith("/api/")) {
      if (offline) { response.writeHead(503); response.end(); return; }
      if (request.headers.authorization !== "Bearer browser-test-token") { response.writeHead(401); response.end(); return; }
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET") { response.end(JSON.stringify({ items: [], next_before_id: null })); return; }
      let raw = "";
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      posts.push(body);
      const saved = records.get(body.client_id) ?? { id: records.size + 1, ...body };
      records.set(body.client_id, saved);
      if (holdResponse) await new Promise((resolve) => { releaseResponse = resolve; });
      response.end(JSON.stringify(saved));
      return;
    }
    if (request.url === "/image.svg") { response.setHeader("Content-Type", "image/svg+xml");response.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#6d8d73"/></svg>');return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>一篇值得收藏的文章</title><main><h1>浏览器测试页面</h1><a href='https://example.org/right-click?x=1#part'>示例链接</a></main>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  root = await mkdtemp(join(tmpdir(), "cairn-browser-"));
  await build({ outputRoot: join(root, "build"), apiBase: origin, pack: false });
  const extensionPath = join(root, "build", "chrome");
  context = await chromium.launchPersistentContext(join(root, "profile"), {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox"]
  });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(String(error))));
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const workerURL = new URL(worker.url());
  extensionURL = `${workerURL.protocol}//${workerURL.host}`;
});

test.afterAll(async () => {
  if (releaseResponse) releaseResponse();
  await context?.close();
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  await rm(root, { recursive: true, force: true });
});

test("real extension: connection, exact capture, close popup, queue retry and background restart", async () => {
  const options = await context.newPage();
  await options.goto(`${extensionURL}/options.html`);
  await expect(options.locator("#connect")).toBeEnabled();
  await options.locator("#token").fill("wrong-token");
  await options.locator("#connect").click();
  await expect(options.locator("#status")).toContainText("访问令牌不可用");
  await options.locator("#token").fill("browser-test-token");
  await options.locator("#connect").click();
  await expect(options.locator("#status")).toContainText("连接成功");
  await expect(options.locator("#token")).toHaveValue("");

  const page = await context.newPage();
  const exactURL = `${origin}/article?x=%20&keep=2#section`;
  await page.goto(exactURL);
  // Opening extension HTML in a tab loses the native action's activeTab
  // grant; inject only the tab query in this test, keeping real background,
  // messaging, local storage, permissions and HTTP requests intact.
  const popup = await context.newPage();
  await popup.addInitScript(({ url }) => {
    chrome.tabs.query = async () => [{ url, title: "一篇值得收藏的文章" }];
  }, { url: exactURL });
  await popup.goto(`${extensionURL}/popup.html`);
  await expect(popup.locator("#url")).toHaveValue(exactURL);
  await popup.locator("#note").fill("保留参数，稍后再读");
  holdResponse = true;
  await popup.locator("#save").click();
  await expect.poll(() => posts.length).toBe(1);
  await popup.close();
  holdResponse = false;
  releaseResponse();
  releaseResponse = null;
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get("cairn_capture_v1")).cairn_capture_v1.queue.length)).toBe(0);
  expect(posts[0].url).toBe(exactURL);
  expect(posts[0].note).toBe("保留参数，稍后再读");
  expect(Object.keys(posts[0]).sort()).toEqual(["client_id", "note", "url"]);

  offline = true;
  const queued = await context.newPage();
  await queued.goto(`${extensionURL}/popup.html`);
  await queued.locator("#url").fill("https://example.com/offline?keep=true#part");
  await queued.locator("#note").fill("离线也不能丢");
  await queued.locator("#save").click();
  await expect(queued.locator("#queue")).toContainText("服务暂时不可用");
  const clientId = await worker.evaluate(async () => (await chrome.storage.local.get("cairn_capture_v1")).cairn_capture_v1.queue[0].client_id);
  await queued.close();
  // Kill the service worker to exercise reconstruction from durable storage.
  const cdp = await context.newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  offline = false;
  await options.reload();
  await expect(options.locator("#pending-count")).toHaveText("1");
  await options.locator("#retry-all").click();
  await expect(options.locator("#pending-count")).toHaveText("0");
  expect(posts.at(-1).client_id).toBe(clientId);
  expect(posts.at(-1).note).toBe("离线也不能丢");

  // A server HTML fragment in the title or note must remain text.
  const hostile = await context.newPage();
  await hostile.goto(`${extensionURL}/popup.html`);
  await hostile.locator("#url").fill("https://example.com/security");
  await hostile.locator("#note").fill('<img src=x onerror="alert(1)">');
  await hostile.locator("#save").click();
  await expect(hostile.locator("#status")).toContainText("已上传");
  expect(posts.at(-1).note).toContain("<img");
  await hostile.locator("body").screenshot({ path: "test-results/cairn-popup.png" });
  await options.screenshot({ path: "test-results/cairn-options.png", fullPage: true });
  expect(errors).toEqual([]);
});


test("capture rendered content with real scripting and keep success visible in a compact popup", async () => {
  const article = await context.newPage();
  await article.goto(`${origin}/rendered-article`);
  await article.evaluate(() => {
    document.body.innerHTML = '<nav>Navigation noise</nav><article><h1>已加载文章</h1><p>这段正文来自浏览器。</p><ul><li>第一项</li><li>第二项</li></ul><input value="private form"><script>window.secret="ignored"</script><p hidden>隐藏内容</p></article>';
  });
  await article.evaluate(async () => {
    const img=document.createElement('img');img.src='/image.svg';img.alt='已加载配图';document.querySelector('article').append(img);await img.decode();
  });
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url), article.url());
  const popup = await context.newPage();
  await popup.setViewportSize({width:380,height:580});
  await popup.addInitScript(tab => { chrome.tabs.query=async()=>[tab]; },tab);
  await popup.goto(`${extensionURL}/popup.html`);
  await expect(popup.locator('#save')).toBeEnabled();
  await popup.locator('#save').click();
  await expect(popup.locator('#status')).toContainText('已同步');
  const saved=posts.find(p=>p.url===article.url());
  expect(saved.capture.text).toContain('# 已加载文章');
  expect(saved.capture.text).toContain('- 第一项');
  expect(saved.capture.text).toContain('![已加载配图](cairn-image:0)');
  expect(saved.capture.images).toHaveLength(1);
  expect(saved.capture.images[0].content_type).toBe('image/webp');
  expect(saved.capture.images[0].data.length).toBeGreaterThan(40);
  expect(saved.capture.text).not.toContain('Navigation noise');
  expect(saved.capture.text).not.toContain('private form');
  expect(saved.capture.text).not.toContain('隐藏内容');
  const box=await popup.locator('#status').boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(580);
  await expect(popup.locator('#save')).toHaveText('已保存');
  await expect(popup.locator('#save')).toBeDisabled();
  await popup.screenshot({path:'test-results/capture-success.png'});
  await popup.reload();await expect(popup.locator('#status')).toContainText('已同步');
  await popup.locator('#note').fill('补充备注');await expect(popup.locator('#save')).toBeEnabled();
  await article.close();await popup.close();
});
