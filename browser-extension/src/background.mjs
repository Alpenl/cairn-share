import { API_BASE, STATE_KEY, RETRY_ALARM, errorText } from "./config.mjs";
import { captureTab } from "./capture.mjs";
import { CaptureError } from "./config.mjs";
import { createClient } from "./api.mjs";
import { createController } from "./controller.mjs";

const ext = globalThis.browser ?? chrome;
const controller = createController({
  store: {
    async read() { return (await ext.storage.local.get(STATE_KEY))[STATE_KEY]; },
    async write(state) { await ext.storage.local.set({ [STATE_KEY]: state }); }
  },
  client: createClient(),
  async onChange(state) {
    await ext.action.setBadgeBackgroundColor({ color: "#a66c21" });
    await ext.action.setBadgeText({ text: state.queue.length ? String(state.queue.length) : "" });
    await ext.action.setTitle({ title: state.queue.length ? `Cairn · ${state.queue.length} 条待上传` :
      state.lastResult?.status === "uploaded" ? "Cairn · 收藏已上传" : "收藏到 Cairn" });
    await ensureAlarm();
  }
});

async function ensureAlarm() {
  if (!(await ext.alarms.get(RETRY_ALARM))) await ext.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
}

async function initialize() {
  // Tokens are local to this browser and are never synced to browser accounts.
  if (ext.storage.local.setAccessLevel) await ext.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await ensureAlarm();
  const state = await controller.snapshot();
  await ext.action.setBadgeText({ text: state.queue.length ? String(state.queue.length) : "" });
  await controller.flush();
}

function handleFailure(error) {
  void ext.action.setTitle({ title: `Cairn · ${errorText(error.kind)}` });
}

async function dispatch(message) {
  switch (message?.type) {
    case "snapshot": return controller.snapshot();
    case "save": {
      const capture = message.capture;
      const known = await controller.snapshot();
      if (message.tabId && message.capturePage && !known.queue.some(j => j.client_id === capture.client_id) && known.lastResult?.client_id !== capture.client_id) {
        try { capture.capture = await captureTab(ext, message.tabId, capture.url); }
        catch { throw new CaptureError("capture_unavailable"); }
      }
      await controller.enqueue(capture);
      // Respond after storage commit. Upload belongs to background, so a
      // closed popup cannot interrupt persistence or discard an upload job.
      void controller.flush().catch(handleFailure);
      return controller.snapshot();
    }
    case "settings": {
      const result = await controller.saveSettings(message.settings);
      void controller.flush({ force: true }).catch(handleFailure);
      return result;
    }
    case "retry": return controller.flush({ force: true, onlyId: message.client_id });
    case "remove": return controller.remove(message.client_id);
    default: throw new Error("Unknown message");
  }
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const allowed = ["popup.html", "options.html"].map((path) => ext.runtime.getURL(path));
  if (sender.id !== ext.runtime.id || !allowed.includes(sender.url)) return false;
  dispatch(message).then((state) => sendResponse({ ok: true, state }),
    (error) => sendResponse({ ok: false, error: error.kind ?? "unexpected" }));
  return true;
});

ext.runtime.onInstalled.addListener(() => {
  void (async () => {
    await ext.contextMenus.removeAll();
    ext.contextMenus.create({ id: "cairn-page", title: "收藏此页到 Cairn", contexts: ["page"], documentUrlPatterns: ["http://*/*", "https://*/*"] });
    ext.contextMenus.create({ id: "cairn-link", title: "收藏此链接到 Cairn", contexts: ["link"], targetUrlPatterns: ["http://*/*", "https://*/*"] });
    await initialize();
  })().catch(handleFailure);
});

ext.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "cairn-page" && info.menuItemId !== "cairn-link") return;
  void (async () => {
    const url = info.menuItemId === "cairn-link" ? info.linkUrl : info.pageUrl;
    const item = { url, title: info.menuItemId === "cairn-page" ? tab?.title : "", client_id: controller.newId() };
    if (info.menuItemId === "cairn-page" && ext.scripting && tab?.id) {
      try { item.capture = await captureTab(ext, tab.id, url); }
      catch { throw new CaptureError("capture_unavailable"); }
    }
    await controller.enqueue(item);
    await controller.flush();
  })().catch((error) => {
    handleFailure(error);
    if (error.kind === "not_configured") void ext.runtime.openOptionsPage();
  });
});

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) void controller.flush().catch(handleFailure);
});
ext.runtime.onStartup.addListener(() => { void initialize().catch(handleFailure); });
// Restoring an MV3 worker should also restore its alarm if the browser removed it.
void ensureAlarm().catch(handleFailure);

export { API_BASE };
