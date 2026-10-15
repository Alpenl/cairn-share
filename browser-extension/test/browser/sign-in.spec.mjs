import { chromium, expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../scripts/build.mjs";

const token = "cairn_c_" + "d".repeat(64);
let context, server, origin, extensionURL, root;
let started = null, redeemed = null, providers = ["github"];

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://x");
    const ok = (data) => { response.writeHead(200, { "Content-Type": "application/json", "X-Cairn-Collections": "1" }); response.end(JSON.stringify({ code: "OK", data })); };
    if (url.pathname === "/api/v1/auth/methods") return ok({ password: false, providers });
    if (url.pathname === "/api/v1/auth/extension/token" && request.method === "POST") {
      let raw = ""; for await (const part of request) raw += part;
      redeemed = JSON.parse(raw);
      const challenge = createHash("sha256").update(redeemed.code_verifier).digest("base64url");
      if (redeemed.code !== "grant-1" || challenge !== started.get("code_challenge")) { response.writeHead(400); response.end("{}"); return; }
      return ok({ token, id: "token-1", label: redeemed.label });
    }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
    return ok({ items: [] });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  root = await mkdtemp(join(tmpdir(), "cairn-sign-in-"));
  await build({ outputRoot: join(root, "build"), apiBase: origin, pack: false });
  const extensionPath = join(root, "build", "chrome");
  context = await chromium.launchPersistentContext(join(root, "profile"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox"] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const workerURL = new URL(worker.url());
  extensionURL = `${workerURL.protocol}//${workerURL.host}`;
});

test.afterAll(async () => {
  await context?.close();
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  await rm(root, { recursive: true, force: true });
});

// Stands in for the provider round trip: the library redirects back to this
// extension with `answer` (a grant code, or an error).
async function openOptions(answer) {
  const options = await context.newPage();
  await options.exposeFunction("recordStart", (url) => { started = new URL(url).searchParams; });
  await options.addInitScript((answer) => {
    chrome.identity.launchWebAuthFlow = async ({ url }) => {
      await window.recordStart(url);
      const state = new URL(url).searchParams.get("state");
      return `${chrome.identity.getRedirectURL()}?${answer}&state=${state}`;
    };
  }, answer);
  await options.goto(`${extensionURL}/options.html`);
  return options;
}

test("GitHub sign-in connects the extension without pasting a token", async () => {
  let options = await openOptions("error=forbidden");
  const button = options.getByRole("button", { name: "使用 GitHub 登录" });
  await expect(button).toBeVisible();
  await expect(options.locator("#auth-redirect-row")).toBeHidden();
  await button.click();
  await expect(options.locator("#status")).toHaveText("这个账号不是收藏库的所有者，无法连接。");
  expect(redeemed).toBeNull();
  await expect(options.locator("#sync-text")).toHaveText("未连接");
  await options.close();

  options = await openOptions("code=grant-1");
  await options.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(options.locator("#status")).toHaveText("已通过 GitHub 连接收藏库。");
  await expect(options.locator("#sync-text")).toHaveText("已连接");
  await expect(options.locator("#settings-form")).toBeHidden();
  expect(started.get("client")).toBe("extension");
  expect(started.get("redirect_uri")).toMatch(/^https:\/\/[a-p]{32}\.chromiumapp\.org\/$/);
  expect(redeemed.label).toBe("Cairn 插件 · Chrome");
  // Changing the connection offers sign-in again next to the token field.
  await options.locator("#change-token").click();
  await expect(options.getByRole("button", { name: "使用 GitHub 登录" })).toBeVisible();
  await options.close();
});

test("a library without extension sign-in shows the redirect to register", async () => {
  providers = [];
  const options = await openOptions("code=grant-1");
  await expect(options.locator("#auth-redirect-row")).toBeVisible();
  await expect(options.locator("#auth-redirect")).toHaveText(/^https:\/\/[a-p]{32}\.chromiumapp\.org\/$/);
  await expect(options.getByRole("button", { name: "使用 GitHub 登录" })).toHaveCount(0);
  providers = ["github"];
});

test('a second server is selected through settings and owns login, tags and captures', async () => {
  const calls=[];
  const second=createServer(async(req,res)=>{
    const ok=data=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'OK',data}));};
    calls.push({path:req.url,authorization:req.headers.authorization});
    if(req.url.startsWith('/api/v1/auth/methods'))return ok({password:true,providers:['github']});
    if(req.url==='/api/v1/auth/extension/token')return ok({token});
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end();return;}
    if(req.url==='/api/v1/collector/tags')return ok({catalog_version:1,dimensions:[]});
    if(req.method==='GET')return ok({items:[]});
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw);return ok({id:321,url:body.url,note:body.note});
  });
  await new Promise(resolve=>second.listen(0,'127.0.0.1',resolve));
  const secondOrigin=`http://127.0.0.1:${second.address().port}`;
  const options=await openOptions('code=second-grant');
  try {
    await options.locator('#change-token').click();
    await options.getByLabel('服务器地址',{exact:true}).fill(secondOrigin);
    await options.getByRole('button',{name:'检查登录方式',exact:true}).click();
    await options.getByRole('button',{name:'使用 GitHub 登录',exact:true}).click();
    await expect(options.locator('#status')).toHaveText('已通过 GitHub 连接收藏库。');
    await expect(options.locator('#server')).toHaveText(new URL(secondOrigin).host);
    await options.evaluate(async()=>{
      const {send}=await import('./ui.mjs');
      await send('tags-sync',{mode:'refresh'});
      await send('save',{capture:{client_id:crypto.randomUUID(),url:'https://article.example/custom-server',note:''}});
      await send('retry');
    });
    expect(calls.some(c=>c.path==='/api/v1/auth/extension/token')).toBe(true);
    expect(calls.some(c=>c.path==='/api/v1/collector/tags')).toBe(true);
    expect(calls.some(c=>c.path==='/api/v1/collector/links')).toBe(true);
    expect(calls.filter(c=>c.authorization).every(c=>c.authorization===`Bearer ${token}`)).toBe(true);
  } finally {await options.close();second.closeAllConnections();await new Promise(resolve=>second.close(resolve));}
});
