import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { API_BASE } from "../src/config.mjs";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function manifest(browser, version, apiBase = API_BASE) {
  const endpoint = new URL(apiBase);
  const result = {
    manifest_version: 3,
    name: "Cairn 收藏",
    version,
    description: "从当前网页保存正文、图片、链接与备注，与 Cairn Android 和 X 增强共用收藏库。",
    icons: { 16: "icons/16.png", 48: "icons/48.png", 128: "icons/128.png" },
    action: { default_title: "收藏到 Cairn", default_popup: "popup.html", default_icon: { 16: "icons/16.png", 48: "icons/48.png" } },
    permissions: ["activeTab", "storage", "unlimitedStorage", "scripting", "contextMenus", "alarms"],
    host_permissions: [`${endpoint.protocol}//${endpoint.hostname}/*`],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    options_ui: { page: "options.html", open_in_tab: true },
    commands: { _execute_action: { suggested_key: { default: "Alt+Shift+C" } } },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" }
  };
  if (browser === "firefox") {
    result.background = { scripts: ["background.mjs"], type: "module" };
    result.browser_specific_settings = { gecko_android: { strict_min_version: "142.0" }, gecko: {
      id: "cairn-capture@alpenl.com",
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["authenticationInfo", "browsingActivity", "websiteContent"] }
    } };
  } else {
    result.minimum_chrome_version = "110";
    result.background = { service_worker: "background.mjs", type: "module" };
  }
  return result;
}

async function archive(directory, filename) {
  const zip = new JSZip();
  async function visit(folder, prefix = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path, `${name}/`);
      else zip.file(name, await readFile(path), { date: new Date("2026-01-01T00:00:00Z") });
    }
  }
  await visit(directory);
  await writeFile(filename, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

export async function build({ outputRoot = join(projectRoot, "dist"), apiBase = API_BASE, pack = true } = {}) {
  // Test servers are deliberately restricted to loopback. Production builds
  // always use the fixed Cairn Share host and never read environment secrets.
  if (apiBase !== API_BASE && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(apiBase).hostname)) throw new Error("Only loopback test servers are allowed");
  const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  await mkdir(outputRoot, { recursive: true });
  for (const browser of ["chrome", "firefox"]) {
    const folder = join(outputRoot, browser);
    await rm(folder, { recursive: true, force: true });
    await cp(join(projectRoot, "src"), folder, { recursive: true });
    if (apiBase !== API_BASE) {
      const configPath = join(folder, "config.mjs");
      const source = await readFile(configPath, "utf8");
      await writeFile(configPath, source.replace(JSON.stringify(API_BASE), JSON.stringify(apiBase)));
    }
    await writeFile(join(folder, "manifest.json"), `${JSON.stringify(manifest(browser, pkg.version, apiBase), null, 2)}\n`);
    await cp(join(projectRoot, "..", "LICENSE"), join(folder, "LICENSE"));
    await cp(join(projectRoot, "PRIVACY.md"), join(folder, "PRIVACY.md"));
    if (pack) await archive(folder, join(outputRoot, `cairn-${browser}-${pkg.version}.zip`));
  }
  return outputRoot;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build();
  console.log("Built dist/chrome, dist/firefox and both installation ZIP archives.");
}
