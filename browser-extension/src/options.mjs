import { STATE_KEY } from "./config.mjs";
import { $, ext, renderQueue, send, showError, status } from "./ui.mjs";
import { DEFAULT_PREFS, PREFS_KEY, TAG_CACHE_KEY, tagCount } from "./tags.mjs";

const ALL_SITES = { origins: ["http://*/*", "https://*/*"] };
let state;
let initialized = false;
let changingToken = false;
let tagCache = null;
let tagsSyncing = false;
let prefs = { ...DEFAULT_PREFS };

$("version").textContent = ext.runtime.getManifest().version;
$("show-token").addEventListener("click", () => {
  const show = $("token").type === "password";
  $("token").type = show ? "text" : "password";
  $("show-token").textContent = show ? "隐藏" : "显示";
  $("show-token").setAttribute("aria-label", show ? "隐藏访问令牌" : "显示访问令牌");
});

const day = (ms) => { const t = new Date(ms); return `${t.getMonth() + 1} 月 ${t.getDate()} 日`; };
function ago(ms) {
  const d = Date.now() - ms;
  if (d < 60000) return "刚刚";
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  return day(ms);
}

function renderConnection() {
  const ok = Boolean(state?.configured);
  const queue = state?.queue || [];
  const failed = queue.filter((j) => j.errorKind).length;
  $("sync-pill").className = `sync-pill ${!ok || failed ? "warn" : queue.length ? "busy" : "ok"}`;
  $("sync-text").textContent = !ok ? "未连接" : failed ? `${failed} 条待重试` : queue.length ? `同步中 · ${queue.length}` : "已连接";
  $("conn-row").hidden = !ok;
  $("server").textContent = ok ? state.server : "cairn-go.alpenl.com";
  $("conn-desc").textContent = [state?.binding && `令牌指纹 ${state.binding.slice(0, 8)}`, state?.connectedAt && `${day(state.connectedAt)}连接`, "只保存在这个浏览器"].filter(Boolean).join(" · ");
  $("change-token").textContent = changingToken ? "取消" : "更换令牌";
  $("settings-form").hidden = ok && !changingToken;
  $("token").placeholder = ok ? "粘贴新的采集令牌；留空则重新测试当前令牌" : "粘贴 cairn.alpenl.com 创建的采集令牌";
  $("move-pending-label").hidden = !queue.length;
  $("move-pending-text").textContent = `用新令牌上传这 ${queue.length} 条待同步收藏`;
}

function renderTagCache() {
  const go = state?.configured && state.server === "cairn-go.alpenl.com";
  const own = tagCache?.binding === state?.binding ? tagCache : null;
  const count = tagCount(own);
  const stale = Boolean(own?.update) && !tagsSyncing;
  const unsupported = state?.configured && (!go || own?.unsupported);
  $("tag-ico").className = `ico${stale ? " warn" : count ? " ok" : ""}`;
  $("tag-title").textContent = !state?.configured ? "尚未拉取标签" : unsupported ? "当前收藏库没有标签目录" : count ? `本地标签 ${count} 个 · ${own.dimensions.length} 个类型` : "本地没有标签缓存";
  $("tag-desc").textContent = !state?.configured ? "连接收藏库后，第一次打开弹窗会把标签拉取到本机。"
    : unsupported ? "旧服务不提供标签，弹窗不显示标签区；服务更新后点立即刷新。"
    : tagsSyncing ? "正在从收藏库拉取标签词表…"
    : stale ? `收藏库已更新到 v${own.update.version}${own.update.added ? `（新增 ${own.update.added} 个标签）` : ""}，本机仍是 v${own.version}。`
    : count ? `词表 v${own.version} · ${ago(own.syncedAt)}同步 · 弹窗直接读取本机缓存` : "下次打开弹窗时会重新拉取。";
  $("tags-refresh").className = stale ? "primary" : "secondary";
  $("tags-refresh").textContent = tagsSyncing ? "同步中…" : stale ? "刷新标签" : "立即刷新";
  $("tags-refresh").disabled = !go || tagsSyncing;
  $("tags-clear").disabled = !own;
  $("tag-auto").checked = prefs.tagAutoCheck !== false;
  $("tag-version").textContent = own?.version !== undefined ? `v${own.version}` : "未拉取";
}

async function refresh() {
  state = await send("snapshot");
  $("pending-count").textContent = String(state.queue.length);
  $("pending-count").hidden = !state.queue.length;
  $("retry-all").hidden = !state.queue.length;
  $("queue").hidden = !state.queue.length;
  $("queue-empty").hidden = Boolean(state.queue.length);
  renderQueue($("queue"), [...state.queue].sort((a, b) => Boolean(b.errorKind) - Boolean(a.errorKind)), refresh, (error) => showError($("status"), error));
  renderConnection();
  renderTagCache();
}

$("change-token").addEventListener("click", () => {
  changingToken = !changingToken;
  if (!changingToken) { $("token").value = ""; $("move-pending").checked = false; }
  renderConnection();
  if (changingToken) $("token").focus();
});

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!initialized || $("connect").disabled) return;
  $("connect").disabled = true;
  $("connect").textContent = "正在测试…";
  try {
    const settings = { token: $("token").value, keepFullUrl: $("keep-full-url").checked, movePending: $("move-pending").checked };
    await send("settings", { settings });
    $("token").value = "";
    $("move-pending").checked = false;
    changingToken = false;
    status($("status"), "连接成功，设置已保存。", "success");
    await refresh();
  } catch (error) {
    const message = {
      network: "暂时无法连接服务器，请稍后再测试连接。",
      timeout: "连接测试超时，请稍后重试。",
      server: "服务暂时不可用，请稍后再测试连接。",
      response: "服务器响应异常，连接尚未保存。"
    }[error.kind];
    if (message) status($("status"), message, "error");
    else showError($("status"), error);
  }
  finally { $("connect").disabled = false; $("connect").textContent = "测试并保存"; }
});

$("retry-all").addEventListener("click", async () => {
  $("retry-all").disabled = true;
  try { await send("retry"); await refresh(); } catch (error) { showError($("status"), error); }
  finally { $("retry-all").disabled = false; }
});

// ───────────── Tags ─────────────
async function syncTags(mode, { quiet = false } = {}) {
  if (tagsSyncing) return;
  const before = tagCache?.binding === state?.binding ? tagCache : null;
  tagsSyncing = !quiet;
  renderTagCache();
  try {
    const { cache, added } = await send("tags-sync", { mode });
    if (cache) tagCache = cache;
    if (!quiet) {
      if (cache?.unsupported) status($("status"), "当前收藏库没有标签目录。", "pending");
      else if (cache && cache.version !== before?.version) status($("status"), `已同步标签词表 v${cache.version}${added.length ? `，新增 ${added.length} 个标签` : ""}。`, "success");
      else if (cache) status($("status"), "标签已是最新。", "success");
    }
  } catch (error) { if (!quiet) showError($("status"), error); }
  finally { tagsSyncing = false; renderTagCache(); }
}
$("tags-refresh").addEventListener("click", () => void syncTags("refresh"));
$("tags-clear").addEventListener("click", async () => {
  try { await send("tags-clear"); tagCache = null; renderTagCache(); status($("status"), "已清除本地标签缓存。", "pending"); }
  catch (error) { showError($("status"), error); }
});

// ───────────── Capture preferences ─────────────
async function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  await ext.storage.local.set({ [PREFS_KEY]: prefs });
}
$("tag-auto").addEventListener("change", () => void savePrefs({ tagAutoCheck: $("tag-auto").checked }).catch((error) => showError($("status"), error)));
$("capture-default").addEventListener("change", () => void savePrefs({ captureDefault: $("capture-default").checked }).catch((error) => showError($("status"), error)));
$("keep-full-url").addEventListener("change", async () => {
  try { await send("preferences", { preferences: { keepFullUrl: $("keep-full-url").checked } }); }
  catch (error) { $("keep-full-url").checked = !$("keep-full-url").checked; showError($("status"), error); }
});

function renderImagePermission(granted) {
  $("image-permission").checked = granted;
  $("image-desc").textContent = granted ? "已允许。可随时在扩展管理页撤销。" : "默认只申请当前文章用到的站点；跨站图片经常缺失时再开启。";
}
$("image-permission").addEventListener("change", async () => {
  const enable = $("image-permission").checked;
  try {
    // The request must run directly in the click gesture.
    if (enable) {
      const granted = await ext.permissions.request(ALL_SITES);
      renderImagePermission(granted);
      status($("status"), granted ? "已允许读取所有网站的图片。" : "未开启额外权限。", granted ? "success" : "pending");
    } else {
      await ext.permissions.remove(ALL_SITES);
      renderImagePermission(false);
      status($("status"), "已关闭，保存时只申请当前文章用到的站点。", "pending");
    }
  } catch (error) { renderImagePermission(!enable); showError($("status"), error); }
});

// ───────────── More ─────────────
$("privacy-toggle").addEventListener("click", () => {
  const open = $("privacy").hidden;
  $("privacy").hidden = !open;
  $("privacy-toggle").setAttribute("aria-expanded", String(open));
  $("privacy-chevron").setAttribute("d", open ? "m6 9 6 6 6-6" : "m9 6 6 6-6 6");
});
if (typeof ext.action?.openPopup === "function") {
  $("open-popup").hidden = false;
  $("open-popup").addEventListener("click", () => ext.action.openPopup().catch(() => status($("status"), "请点击浏览器工具栏中的 Cairn 图标。", "pending")));
}

ext.storage.onChanged.addListener((changes, area) => {
  if (!initialized || area !== "local") return;
  if (changes[STATE_KEY]) void refresh().catch((error) => showError($("status"), error));
  if (changes[TAG_CACHE_KEY]) { tagCache = changes[TAG_CACHE_KEY].newValue ?? null; renderTagCache(); }
});

try {
  const [stored, granted] = await Promise.all([ext.storage.local.get([PREFS_KEY, TAG_CACHE_KEY]), ext.permissions.contains(ALL_SITES).catch(() => false)]);
  prefs = { ...DEFAULT_PREFS, ...stored[PREFS_KEY] };
  tagCache = stored[TAG_CACHE_KEY] ?? null;
  $("capture-default").checked = prefs.captureDefault !== false;
  renderImagePermission(granted);
  await refresh();
  $("keep-full-url").checked = state.keepFullUrl !== false;
  initialized = true;
  $("connect").disabled = false;
  // A cheap version-only check, so this page can say when the library changed.
  if (state.configured && state.server === "cairn-go.alpenl.com" && tagCache?.binding === state.binding && tagCache.dimensions) void syncTags("check", { quiet: true });
  // Older links (options.html#queue, #media, #about) land on the matching group.
  const anchor = location.hash.slice(1);
  if (anchor) document.getElementById({ queue: "queue-group", media: "capture", about: "more" }[anchor] || anchor)?.scrollIntoView();
} catch (error) { showError($("status"), error); }
