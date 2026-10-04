import assert from "node:assert/strict";
import test from "node:test";
import { RETRY_ALARM, STATE_KEY } from "../src/config.mjs";
import { emptyState } from "../src/controller.mjs";

test("background rejects page messages and routes page/link menus and retry alarms", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const originalBrowser = globalThis.browser;
  const events = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  const message = events(), menu = events(), alarm = events(), installed = events();
  let state = emptyState();
  state.settings.token = "background-test-token";
  let fail = false;
  const posted = [];
  const menus = [];
  const badges = [];
  globalThis.browser = undefined;
  globalThis.chrome = {
    runtime: { id: "extension-id", getURL: (path) => `chrome-extension://extension-id/${path}`,
      onMessage: message, onInstalled: installed, onStartup: events(), openOptionsPage: async () => {} },
    storage: { local: { get: async () => ({ [STATE_KEY]: structuredClone(state) }), set: async (value) => { state = structuredClone(value[STATE_KEY]); }, setAccessLevel: async () => {} } },
    action: { setBadgeText: async (value) => { badges.push(value.text); }, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    contextMenus: { onClicked: menu, removeAll: async () => { menus.length = 0; }, create: (value) => { menus.push(value); } },
    alarms: { onAlarm: alarm, get: async () => null, create: async () => {} }
  };
  globalThis.fetch = async (_url, options) => {
    if (fail) return new Response("", { status: 503 });
    const body = JSON.parse(options.body);
    posted.push(body);
    return Response.json({ id: posted.length, ...body });
  };
  const until = async (predicate) => {
    for (let tries = 0; tries < 100; tries++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("background event did not finish");
  };
  try {
    await import("../src/background.mjs");
    const listener = message.listeners[0];
    let responded = false;
    assert.equal(listener({ type: "snapshot" }, { id: "extension-id", url: "https://untrusted.example" }, () => { responded = true; }), false);
    assert.equal(responded, false);
    const result = await new Promise((resolve) => {
      assert.equal(listener({ type: "snapshot" }, { id: "extension-id", url: "chrome-extension://extension-id/popup.html" }, resolve), true);
    });
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes("background-test-token"), false);
    installed.listeners[0]();
    await until(() => menus.length === 2);
    assert.deepEqual(menus.map((item) => item.contexts), [["page"], ["link"]]);
    menu.listeners[0]({ menuItemId: "cairn-link", linkUrl: "https://example.com/link?x=1#part", pageUrl: "https://example.com/page" }, { title: "Page title" });
    await until(() => posted.length === 1 && state.queue.length === 0);
    assert.equal(posted[0].url, "https://example.com/link?x=1#part");
    assert.equal(posted[0].note, "");
    fail = true;
    menu.listeners[0]({ menuItemId: "cairn-page", pageUrl: "https://example.com/page" }, { title: "Page title" });
    await until(() => state.queue[0]?.errorKind === "server");
    assert.equal(state.queue[0].title, "Page title");
    assert.ok(badges.includes("1"));
    fail = false;
    state.queue[0].nextAttemptAt = 0;
    alarm.listeners[0]({ name: RETRY_ALARM });
    await until(() => state.queue.length === 0);
    assert.equal(posted.at(-1).url, "https://example.com/page");
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.browser = originalBrowser;
    globalThis.fetch = originalFetch;
  }
});
