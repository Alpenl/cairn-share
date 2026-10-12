// Local screenshot harness (not part of CI): node scripts/screenshots.mjs <outdir>
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../scripts/build.mjs";
const out = process.argv[2] || "/tmp/shots";
const cols = [["界面设计参考", 1], ["AIGC 生图与视频", 1], ["本地模型实验", 0], ["下一次分享", 0]].map(([name, pinned], i) => ({ id: `c${i}`, name, revision: 1, deleted: 0, archived: 0, pinned }));
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", req.url.startsWith("/api") ? "application/json" : "text/html; charset=utf-8");
  if (req.url.startsWith("/api/collections")) { res.setHeader("X-Cairn-Collections", "1"); return res.end(JSON.stringify({ items: cols })); }
  if (req.url.startsWith("/api/links/lookup")) return res.end(JSON.stringify(req.url.includes("known") ? { saved: true, link: { id: 9, created_at: "2026-09-28T03:00:00Z", collections: [{ id: "c0", name: "界面设计参考" }] } } : { saved: false }));
  if (req.url.startsWith("/api/captures/v2/pending")) return res.end(JSON.stringify({ batch_version: 1, items: [], next: null }));
  if (req.url.startsWith("/api/")) return res.end(JSON.stringify({ items: [], next_before_id: null }));
  if (req.url.startsWith("/img")) { res.setHeader("Content-Type", "image/svg+xml"); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#d97757"/></svg>'); }
  const body = "<p>参考图进库之后，最容易乱的不是生成，而是命名与版本。</p>".repeat(40);
  res.end(`<!doctype html><title>视觉创作工作流：从参考图到成片的素材管理</title><article><h1>视觉创作工作流</h1>${body}<img src="/img1" width="400" height="300"><img src="/img2" width="400" height="300"><img src="/img3" width="400" height="300"></article>`);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const root = await mkdtemp(join(tmpdir(), "cairn-shots-"));
await build({ outputRoot: join(root, "build"), apiBase: origin, pack: false });
const path = join(root, "build", "chrome");
const ctx = await chromium.launchPersistentContext(join(root, "profile"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`, "--no-sandbox"] });
const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
const wu = new URL(worker.url()); const ext = `${wu.protocol}//${wu.host}`;
const opt = await ctx.newPage(); await opt.setViewportSize({ width: 1024, height: 640 });
await opt.goto(`${ext}/options.html`); await opt.locator("#token").fill("shot-token"); await opt.locator("#connect").click();
await opt.locator("#status").filter({ hasText: "连接成功" }).waitFor();
await opt.waitForTimeout(400); await opt.screenshot({ path: `${out}/options-connection.png` });
for (const s of ["queue", "capture", "media", "about"]) { await opt.goto(`${ext}/options.html#${s}`); await opt.waitForTimeout(250); await opt.screenshot({ path: `${out}/options-${s}.png` }); }
await opt.goto(`${ext}/batch.html`); await opt.waitForTimeout(400); await opt.screenshot({ path: `${out}/batch.png` });
for (const [name, url] of [["popup-idle", "/post"], ["popup-known", "/known-post"]]) {
  await worker.evaluate(() => chrome.storage.local.remove("cairn_capture_draft"));
  const article = await ctx.newPage(); await article.goto(origin + url); await article.waitForLoadState("load");
  const tab = await worker.evaluate(async u => (await chrome.tabs.query({})).find(t => t.url === u), article.url());
  const popup = await ctx.newPage(); await popup.setViewportSize({ width: 380, height: 600 });
  await popup.addInitScript(t => { chrome.tabs.query = async () => [t]; }, tab);
  await popup.goto(`${ext}/popup.html`); await popup.locator("#save:not([disabled])").waitFor(); await popup.waitForTimeout(700);
  await popup.screenshot({ path: `${out}/${name}.png` });
  if (name === "popup-idle") { await popup.locator(".collection-choice").first().click(); await popup.locator("#note").fill("命名和版本管理的思路很清楚，下次整理素材库时照着做。"); await popup.evaluate(() => document.activeElement.blur()); await popup.waitForTimeout(300); await popup.screenshot({ path: `${out}/popup-filled.png` }); }
  await popup.close(); await article.close();
}
await ctx.close(); server.close(); await rm(root, { recursive: true, force: true });
console.log("shots ->", out);
