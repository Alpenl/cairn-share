import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { build, projectRoot } from "../scripts/build.mjs";

// Optional native Firefox smoke test. Requires Firefox and geckodriver on PATH.
// Uses the WebDriver protocol directly to avoid another runtime dependency.
const server = createServer();
let offline = false;
const records = new Map();
let requestCount = 0;
const requests = [];
server.on("request", async (request, response) => {
  requestCount++;
  requests.push({ method: request.method, path: request.url, authorized: request.headers.authorization === "Bearer firefox-test-token" });
  response.setHeader("Content-Type", "application/json");
  if (offline) { response.writeHead(503); response.end(); return; }
  if (request.headers.authorization !== "Bearer firefox-test-token") { response.writeHead(401); response.end(); return; }
  if (request.method === "GET") { response.end(JSON.stringify({ items: [], next_before_id: null })); return; }
  let raw = "";
  for await (const part of request) raw += part;
  const body = JSON.parse(raw);
  const saved = records.get(body.client_id) ?? { id: records.size + 1, ...body };
  records.set(body.client_id, saved);
  response.end(JSON.stringify(saved));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiBase = `http://127.0.0.1:${server.address().port}`;
await mkdir(join(projectRoot, ".firefox-smoke"), { recursive: true });
const root = await mkdtemp(join(projectRoot, ".firefox-smoke", "run-"));
const { version } = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const portProbe = createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
// Firefox requires system access to automate an extension's internal pages.
// The driver binds only loopback and always creates a fresh temporary profile.
const driver = spawn(process.env.GECKODRIVER_BINARY || "geckodriver", ["--port", String(port), "--host", "127.0.0.1", "--allow-system-access", "--log", "error"], { stdio: "ignore" });
let startupError;
driver.on("error", (error) => { startupError = error; });
let sessionId;
const base = `http://127.0.0.1:${port}`;
const uuid = "8a67873e-0234-499f-932f-7c51b36ec6ee";

async function request(path, method = "GET", data) {
  const response = await fetch(`${base}${path}`, { method,
    ...(data ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.value?.message ?? response.statusText);
  return result.value;
}
const command = (path, data) => request(`/session/${sessionId}/${path}`, "POST", data);
const execute = (script, args = []) => command("execute/sync", { script, args });
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await pause(); }
  throw new Error(message);
}
async function fill(id, value) {
  await execute("const e=document.getElementById(arguments[0]); e.value=arguments[1]; e.dispatchEvent(new Event('input',{bubbles:true}));", [id, value]);
}
async function click(id) {
  const found = await command("element", { using: "css selector", value: `#${id}` });
  const elementId = found["element-6066-11e4-a52e-4f735466cecf"];
  await command(`element/${elementId}/click`, {});
}
const text = (id) => execute("return document.getElementById(arguments[0])?.textContent || ''", [id]);

try {
  await until(async () => {
    if (startupError) throw startupError;
    return fetch(`${base}/status`).then((res) => res.ok).catch(() => false);
  }, "geckodriver did not start");
  await build({ outputRoot: join(root, "build"), apiBase });
  const session = await request("/session", "POST", { capabilities: { alwaysMatch: { browserName: "firefox",
    "moz:firefoxOptions": { args: ["-headless"], ...(process.env.FIREFOX_BINARY ? { binary: process.env.FIREFOX_BINARY } : {}),
      prefs: { "extensions.webextensions.uuids": JSON.stringify({ "cairn-capture@alpenl.com": uuid }) } }
  } } });
  sessionId = session.sessionId;
  await command("moz/addon/install", { path: join(root, "build", `cairn-firefox-${version}.zip`), temporary: true });
  const url = `moz-extension://${uuid}`;
  await command("url", { url: `${url}/options.html` });
  await until(async () => execute("return document.getElementById('connect')?.disabled === false"), "Firefox options/background did not initialize");
  await fill("token", "firefox-test-token");
  await click("connect");
  await until(async () => (await text("status")).includes("连接成功"), "Firefox connection test failed");
  await command("url", { url: `${url}/popup.html` });
  await until(async () => (await text("connection")).includes("已连接"), "Firefox popup did not initialize");
  const exactUrl = "https://example.com/firefox?keep=%20#fragment";
  await fill("url", exactUrl);
  await fill("note", "Firefox 收藏备注");
  await click("save");
  await until(async () => (await text("status")).includes("已上传"), "Firefox upload failed");
  assert.equal(records.size, 1);
  assert.equal([...records.values()][0].url, exactUrl);
  assert.equal([...records.values()][0].note, "Firefox 收藏备注");
  offline = true;
  await fill("note", "断网后的 Firefox 收藏");
  await click("save");
  await until(async () => (await text("queue")).includes("服务暂时不可用"), "Firefox did not retain failed upload");
  await command("url", { url: `${url}/options.html` });
  await until(async () => (await text("pending-count")) === "1", "Firefox pending job did not survive popup close");
  offline = false;
  await click("retry-all");
  await until(async () => (await text("pending-count")) === "0", "Firefox retry failed");
  assert.equal(records.size, 2);
  console.log(`Firefox ${session.capabilities.browserVersion}: connection, exact URL, durable queue and retry passed.`);
} catch (error) {
  if (sessionId) {
    console.error("Firefox smoke diagnostic:", JSON.stringify({ requestCount, requests, status: await text("status").catch(() => "unavailable"),
      permissions: await execute("return browser.permissions.getAll()").catch(() => "unavailable") }));
  }
  throw error;
} finally {
  if (sessionId) await request(`/session/${sessionId}`, "DELETE").catch(() => {});
  driver.kill("SIGTERM");
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  await rm(root, { recursive: true, force: true });
}
