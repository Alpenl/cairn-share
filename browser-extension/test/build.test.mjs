import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { build, manifest, projectRoot } from "../scripts/build.mjs";

test("browser manifests use minimal permissions and native MV3 backgrounds", () => {
  const chrome = manifest("chrome", "0.1.0");
  const firefox = manifest("firefox", "0.1.0");
  assert.deepEqual(chrome.host_permissions, ["https://share.alpenl.com/*"]);
  assert.deepEqual(chrome.permissions, ["activeTab", "storage", "unlimitedStorage", "scripting", "contextMenus", "alarms"]);
  assert.equal(chrome.background.service_worker, "background.mjs");
  assert.deepEqual(firefox.background.scripts, ["background.mjs"]);
  assert.equal(chrome.content_scripts, undefined);
  assert.equal(chrome.chrome_url_overrides, undefined);
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.required, ["authenticationInfo", "browsingActivity", "websiteContent"]);
});

test("installation archives contain all referenced local assets and no tokens", async () => {
  const folder = await mkdtemp(join(tmpdir(), "cairn-build-"));
  try {
    await build({ outputRoot: folder });
    const { version } = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    for (const browser of ["chrome", "firefox"]) {
      const zip = await JSZip.loadAsync(await readFile(join(folder, `cairn-${browser}-${version}.zip`)));
      const config = JSON.parse(await zip.file("manifest.json").async("string"));
      for (const name of ["popup.html", "options.html", "background.mjs", "api.mjs", "config.mjs", "controller.mjs", "ui.mjs", "styles.css", "LICENSE", "PRIVACY.md", ...Object.values(config.icons)]) {
        assert.ok(zip.file(name), `${browser}: ${name}`);
      }
      assert.equal(zip.file("package-lock.json"), null);
      assert.equal(zip.file(".env"), null);
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
