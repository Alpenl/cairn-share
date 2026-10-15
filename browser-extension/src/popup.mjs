import { STATE_KEY, CaptureError, MAX_NOTE, MAX_TAGS, submissionUrl, validateCapture } from "./config.mjs";
import { $, ext, renderQueue, queueStatus, send, showError, status } from "./ui.mjs";
import { pagePreview } from './capture.mjs';
import { DEFAULT_PREFS, PREFS_KEY, TAG_CACHE_KEY, shortLabel, tagSize } from './tags.mjs';

let state;
let title = "";
let activeTab;
let saved = false;
let operationId = crypto.randomUUID();
let saving = false;
let initialized = false;
let editingUrl = false;
let requestedOrigins = [];
let selectedCollections=new Set();let definitions=[];
// Tag cloud: rendered from the local cache; `tagPhase` is loading (first
// fetch), refreshing, synced (refreshed in this popup), offline or idle.
let tagCache=null,tagPhase="idle",tagsVisible=false,tagDim="all",tagsExpanded=false;
let selectedTags=new Set(),freshTags=new Set(),prefs={...DEFAULT_PREFS};
let preview=null;let known=null;
let draftWrites = Promise.resolve();
const DRAFT_KEY = "cairn_capture_draft";
const PERMISSION_ERRORS = new Set(["media_permission", "capture_images_incomplete"]);

const openSettings = () => ext.runtime.openOptionsPage();
$("settings").addEventListener("click", openSettings);
$("open-settings").addEventListener("click", openSettings);

function valid() {
  try { validateCapture($("url").value, $("note").value); return true; } catch { return false; }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function inputsChanged() {
  const configured = Boolean(state?.configured);
  $("setup").hidden = !state || configured;
  $("capture-form").hidden = !configured;
  $("save-dock").hidden = !configured;
  const length = $("note").value.length;
  $("note-count").textContent = `${length} / ${MAX_NOTE}`;
  $("note-count").classList.toggle("near", length >= MAX_NOTE - 200);
  $("save").disabled = saving || saved || !configured || !valid();
  $("url").readOnly = saving;
  $("note").readOnly = saving;
  $("collection-choices").querySelectorAll("input").forEach(n=>n.disabled=saving||saved);
  $("tag-cloud").querySelectorAll("button").forEach(n=>n.disabled=saving||saved);
  const samePage = Boolean(activeTab?.id) && $("url").value === activeTab.url;
  // The current tab is shown as a card; the raw URL only matters when the
  // user pastes another link or the tab is not a web page.
  const showCard = !editingUrl && valid() && $("url").value === activeTab?.url;
  $("url-field").hidden = showCard;
  $("edit-url").hidden = !showCard;
  $("page-title").textContent = title || hostOf($("url").value);
  $("page-host").textContent = hostOf($("url").value);
  $("favicon").hidden = !showCard || !$("favicon").getAttribute("src");
  $("capture-option").hidden = !samePage;
  $("capture-page").disabled = saving;
  renderStats(samePage);
  const isKnown = Boolean(known?.saved) && known.url === $("url").value;
  $("saved-badge").hidden = !isKnown;
  $("saved-note").hidden = !isKnown || saved;
  if (isKnown) renderKnown();
  $("save-label").textContent = saving ? "正在保存…" : saved ? "已保存" : isKnown ? "更新收藏" : "保存";
  const chosen = selectedCollections.size;
  $("collections-aux").textContent = chosen ? `已选 ${chosen}` : "可多选";
  $("collections-aux").classList.toggle("on", chosen > 0);
  renderSync();
  $("recapture").hidden = !saved || saving;
  const stripped = valid() && state?.keepFullUrl === false && submissionUrl($("url").value, false) !== $("url").value.trim();
  $("url-policy").hidden = !stripped;
  if (stripped) $("url-policy").textContent = "按设置，保存时去掉链接中的参数。";
}

const ICONS = {
  text: [["path", { d: "M4 6h16M4 12h16M4 18h10" }]],
  image: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ["circle", { cx: 9, cy: 10, r: 2 }], ["path", { d: "m21 16-5-5-9 9" }]],
  video: [["rect", { x: 3, y: 5, width: 13, height: 14, rx: 2 }], ["path", { d: "m16 10 5-3v10l-5-3" }]],
  coll: [["path", { d: "M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" }]]
};
const SVG = "http://www.w3.org/2000/svg";
function icon(name) {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const [tag, attrs] of ICONS[name]) { const el = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); svg.append(el); }
  return svg;
}
function stat(name, text) { const span = document.createElement("span"); span.append(icon(name), document.createTextNode(text)); return span; }
const count = n => n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, "")} 万` : n.toLocaleString("zh-CN");

// One line under the card: what this save will capture.
function renderStats(samePage) {
  const root = $("cap-stats");
  if (!samePage) { root.replaceChildren(); return; }
  if (!$("capture-page").checked) { root.replaceChildren(document.createTextNode("只保存链接和收藏原因")); return; }
  if (!preview) { root.replaceChildren(document.createTextNode("正在识别正文和媒体…")); return; }
  if (preview.failed) { root.replaceChildren(document.createTextNode("暂未识别到正文，保存时会再读取一次")); return; }
  const parts = [stat("text", preview.chars ? `${count(preview.chars)} 字${preview.truncated ? "+" : ""}` : "无正文")];
  if (preview.images) parts.push(stat("image", `${preview.images} 张图`));
  if (preview.videos + preview.audios) parts.push(stat("video", `${preview.videos + preview.audios} 个${preview.videos ? "视频" : "音频"}`));
  root.replaceChildren(...parts);
}

function renderKnown() {
  const link = known.link || {};
  const note = $("saved-note"); note.replaceChildren();
  const when = link.created_at ? new Date(link.created_at) : null;
  const date = when && !Number.isNaN(when.getTime()) ? when.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }) : "";
  const b = document.createElement("b"); b.textContent = date ? `${date}已收藏` : "已在收藏库中";
  note.append(b);
  const names = (link.collections || []).map(c => c.name).filter(Boolean);
  if (names.length) note.append(document.createTextNode(` · 在「${names.slice(0, 3).join("」「")}」${names.length > 3 ? ` 等 ${names.length} 个合集` : ""}`));
  note.append(document.createTextNode("。再次保存会更新原收藏，不会重复。"));
}

function renderSync() {
  const pill = $("sync-pill");
  pill.hidden = !state?.configured;
  if (pill.hidden) return;
  const queue = state.queue || [];
  const failed = queue.filter(j => j.errorKind).length;
  pill.className = `sync-pill ${failed ? "warn" : queue.length ? "busy" : "ok"}`;
  $("sync-text").textContent = failed ? `${failed} 条待重试` : queue.length ? `同步中 · ${queue.length}` : "已同步";
}

async function loadKnown() {
  const url = $("url").value;
  if (!state?.configured || !/^https?:/.test(url)) return;
  try {
    const answer = await send("lookup", { url: submissionUrl(url, state.keepFullUrl !== false) });
    if (answer.binding !== state?.binding || !answer.result) return;
    known = { ...answer.result, url };
    inputsChanged();
  } catch { /* lookup is advisory */ }
}

function persistDraft() {
  const draft = { url: $("url").value, note: $("note").value, title, client_id: operationId, ...(state?.server === "cairn-go.alpenl.com" && known?.saved && known.url === $("url").value ? {expected:{id:known.id,content_revision:known.content_revision,app_body_revision:known.app_body_revision,personal_revision:known.personal_revision}} : {}), collection_ids:[...selectedCollections],tag_refs:[...selectedTags],binding:state?.binding };
  draftWrites = draftWrites.catch(() => {}).then(() => ext.storage.local.set({ [DRAFT_KEY]: draft }))
    .catch(() => { throw new CaptureError("storage"); });
  return draftWrites;
}

for (const id of ["url", "note"]) $(id).addEventListener("input", () => {
  saved = false;
  status($("status"), "");
  if (id === "url") title = "";
  operationId = crypto.randomUUID();
  inputsChanged();
  void persistDraft().catch((error) => showError($("status"), error));
});

$("edit-url").addEventListener("click", () => {
  editingUrl = true;
  inputsChanged();
  $("url").focus();
  $("url").select();
});

function resultText(result, pending) {
  if (pending) return [pending.errorKind ? "已保存在本机，同步未完成，见下方。" : `${queueStatus(pending)}，可以关闭窗口。`, pending.errorKind ? "error" : "pending"];
  if (result.status === "media") return ["正文已同步，正在归档媒体，可以关闭窗口。", "pending"];
  if (result.status !== "uploaded") return ["已保存在本机，正在上传，可以关闭窗口。", "pending"];
  const tags = result.tagsSaved ? ` · ${result.tagsSaved} 个标签` : "";
  if (!result.captured) return [`已上传到收藏库${tags}。`, "success"];
  const parts = [];
  if (result.imagesSaved) parts.push(`${result.imagesSaved} 张图片`);
  if (result.mediaSaved) parts.push(`${result.mediaSaved} 个视频/音频`);
  const warnings = [];
  if (result.missingImages) warnings.push(`${result.missingImages} 张图片未取到，保留了来源链接`);
  if (result.truncated) warnings.push("正文过长，仅保存了部分");
  const head = result.action === "updated" ? "已更新原收藏" : "已同步";
  const text = `${head}${parts.length ? ` · ${parts.join("、")}` : ""}${tags}${warnings.length ? `。${warnings.join("；")}。` : ""}`;
  return [text, warnings.length ? "pending" : "success"];
}

async function refresh() {
  const next=await send("snapshot");if(state?.binding&&state.binding!==next.binding){selectedCollections.clear();definitions=[];renderCollections();selectedTags.clear();tagCache=null;tagsVisible=false;renderTags();}
  state=next;
  // Only surface queue items that are not the one already described in the
  // status line, unless they need the user's attention.
  const shown = state.queue.filter(j => j.client_id !== operationId || j.errorKind)
    .sort((a, b) => Boolean(b.errorKind) - Boolean(a.errorKind));
  $("queue-section").hidden = !shown.length;
  $("pending-count").textContent = String(state.queue.length);
  $("retry-all").hidden = !state.queue.some(j => j.errorKind);
  $("image-permission").hidden = !state.queue.some(j => PERMISSION_ERRORS.has(j.errorKind));
  renderQueue($("queue"), shown, refresh, (error) => showError($("status"), error));
  if (state.lastResult?.client_id === operationId) {
    saved = true;
    const pending = state.queue.find(j => j.client_id === operationId);
    status($("status"), ...resultText(state.lastResult, pending));
  }
  inputsChanged();
}

$("capture-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving || !initialized || !state?.configured || !valid()) return;
  saving = true;
  status($("status"), "正在读取页面…", "pending");
  inputsChanged();
  try {
    // Invoke directly in the user's save gesture; permissions are specific to
    // this page's media hosts and prepared before the button becomes active.
    if ($("capture-page").checked && $("url").value===activeTab?.url && requestedOrigins.length) await ext.permissions.request({origins:requestedOrigins});
    await persistDraft();
    const capture = { url: $("url").value, note: $("note").value, title, client_id: operationId, ...(state?.server === "cairn-go.alpenl.com" && known?.saved && known.url === $("url").value ? {expected:{id:known.id,content_revision:known.content_revision,app_body_revision:known.app_body_revision,personal_revision:known.personal_revision}} : {}), collection_ids:[...selectedCollections],tag_refs:chosenTags(),binding:state?.binding };
    await send("save", { capture, tabId: activeTab?.id, capturePage: $("capture-page").checked && capture.url === activeTab?.url });
    await draftWrites;
    await ext.storage.local.remove(DRAFT_KEY);
    status($("status"), "已保存在本机，正在上传…", "pending");
    await refresh();
    // Keep the submitted UUID until the user edits the form. A double click
    // or re-submit of the same form is the same operation.
  } catch (error) { showError($("status"), error); }
  finally { saving = false; inputsChanged(); }
});

$("retry-all").addEventListener("click", async () => {
  $("retry-all").disabled = true;
  try { await send("retry"); await refresh(); } catch (error) { showError($("status"), error); }
  finally { $("retry-all").disabled = false; }
});

ext.storage.onChanged.addListener((changes, area) => {
  if (initialized && area === "local" && changes[STATE_KEY]) void refresh().catch((error) => showError($("status"), error));
});

$("image-permission").addEventListener("click", async () => {
  try {
    const origins=[...new Set([...requestedOrigins,...(state?.queue || []).flatMap(j=>j.requiredOrigins || [])])];
    const granted = await ext.permissions.request({origins:origins.length?origins:["http://*/*", "https://*/*"]});
    if (granted) { await send("retry"); await refresh(); }
    else status($("status"), "未开启权限，部分跨站图片无法归档。", "pending");
  } catch (error) { showError($("status"), error); }
});
$("recapture").addEventListener('click',()=>{saved=false;operationId=crypto.randomUUID();inputsChanged();$("capture-form").requestSubmit();});
$("capture-page").addEventListener("change", () => { saved=false; operationId=crypto.randomUUID(); inputsChanged(); });
document.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !$("save").disabled) $("capture-form").requestSubmit(); });
$("favicon").addEventListener("error", () => { $("favicon").removeAttribute("src"); $("favicon").hidden = true; });

try {
  const [tabs, stored] = await Promise.all([ext.tabs.query({ active: true, currentWindow: true }), ext.storage.local.get([DRAFT_KEY, PREFS_KEY, TAG_CACHE_KEY])]);
  prefs = { ...DEFAULT_PREFS, ...stored[PREFS_KEY] };
  $("capture-page").checked = prefs.captureDefault !== false;
  const tab = tabs[0];
  activeTab = tab;
  if (tab?.id && /^https?:/.test(tab.url || '')) {
    try { const result=await pagePreview(ext,tab.id,tab.url); requestedOrigins=result.origins; preview=result.stats; } catch { preview={failed:true}; /* Save still offers a useful extraction error. */ }
  }
  if (/^https?:/.test(tab?.favIconUrl || '')) $("favicon").src = tab.favIconUrl;
  const draft = stored[DRAFT_KEY];
  state = await send("snapshot");
  if (draft && !state.queue.some((job) => job.client_id === draft.client_id) && state.lastResult?.client_id !== draft.client_id) {
    $("url").value = draft.url;
    $("note").value = draft.note;
    selectedCollections=new Set(draft.binding===state.binding?(draft.collection_ids||[]):[]);
    selectedTags=new Set(draft.binding===state.binding?(draft.tag_refs||[]):[]);
    title = draft.title;
    operationId = draft.client_id;
    if (draft.url !== tab?.url) status($("status"), "已恢复上次未保存的草稿。", "pending");
  } else {
    $("url").value = tab?.url ?? "";
    title = tab?.title ?? "";
    if (draft) {
      operationId = draft.client_id;
      $("url").value = draft.url;
      $("note").value = draft.note;
      title = draft.title;
      await ext.storage.local.remove(DRAFT_KEY);
    }
  }
  if (!draft && state.lastResult?.url === $("url").value) operationId = state.lastResult.client_id;
  initialized = true;
  await refresh();
  void loadCollections();
  void loadKnown();
  void loadTags(stored[TAG_CACHE_KEY]);
} catch (error) { showError($("status"), error); }

function renderCollections(){
 const root=$("collection-choices");root.replaceChildren();
 const active=definitions.filter(c=>!c.deleted&&!c.archived).sort((a,b)=>b.pinned-a.pinned||a.name.localeCompare(b.name));
 $("collections").hidden=!active.length;
 for(const c of active){
  const label=document.createElement("label");label.className="collection-choice";const input=document.createElement("input");input.type="checkbox";input.checked=selectedCollections.has(c.id);input.disabled=saving||saved;
  input.addEventListener("change",()=>{input.checked?selectedCollections.add(c.id):selectedCollections.delete(c.id);operationId=crypto.randomUUID();void persistDraft();inputsChanged();});
  const name=document.createElement("span");name.textContent=c.name;label.append(input,icon("coll"),name);root.append(label);
 }
}
// Collections are optional; when the list can't be read the row stays hidden
// and saving works as usual.
async function loadCollections(){try{const result=await send("collections");if(result.binding!==state?.binding)return;definitions=result.items;renderCollections();}catch{/* keep hidden */}}

// ───────────── Tags ─────────────
// Declarations below run during the top-level await above, so they are hoisted functions.
function dimensionsOf() { return tagCache?.dimensions || []; }
function knownTags() { return new Map(dimensionsOf().flatMap(d => d.tags.map(t => [t.tag_ref, { ...t, dimension: d }]))); }
// Only tags still in the local catalog are sent; a stale draft cannot carry
// refs from another library or from before a refresh removed them.
function chosenTags() { if (!tagsVisible) return []; const known = knownTags(); return [...selectedTags].filter(ref => known.has(ref)); }

function ago(ms) {
  const d = Date.now() - ms;
  if (!ms || d < 60000) return "刚刚";
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  const t = new Date(ms); return `${t.getMonth() + 1} 月 ${t.getDate()} 日`;
}

function toggleTag(ref, dimension) {
  if (saving || saved) return;
  if (selectedTags.has(ref)) selectedTags.delete(ref);
  else {
    // Single-choice dimensions (e.g. 载体) keep one tag, like the web editor.
    if (dimension.selection_mode === "single") for (const t of dimension.tags) selectedTags.delete(t.tag_ref);
    if (selectedTags.size >= MAX_TAGS) return;
    selectedTags.add(ref);
  }
  operationId = crypto.randomUUID();
  void persistDraft();
  renderTags();
  inputsChanged();
}

function dot(color) { const i = document.createElement("i"); i.className = `tag-dot c${color}`; return i; }

function renderTags() {
  $("tags").hidden = !tagsVisible;
  if (!tagsVisible) return;
  const dims = dimensionsOf();
  const loading = tagPhase === "loading";
  const busy = loading || tagPhase === "refreshing";
  const stale = Boolean(tagCache?.update) && !busy;
  const offline = tagPhase === "offline";
  const chosen = chosenTags();
  $("tags-aux").textContent = chosen.length ? `已选 ${chosen.length}` : "可多选";
  $("tags-aux").classList.toggle("on", chosen.length > 0);
  const synced = tagCache?.syncedAt;
  $("tags-sync").textContent = loading ? "正在拉取…" : busy ? "同步中…" : offline ? (synced ? `本地缓存 · ${ago(synced)}` : "未连接") : stale ? "有更新" : tagPhase === "synced" ? `已同步 · ${ago(synced)}` : `本地 · ${ago(synced)}`;
  $("tags-sync").className = `sync-note${stale ? " stale" : offline ? " offline" : ""}`;
  $("tags-refresh").className = `refresh-btn${busy ? " spinning" : ""}${stale ? " has-update" : ""}`;
  $("tags-refresh").setAttribute("aria-busy", String(busy));
  $("tags-stale").hidden = !stale;
  if (stale) $("tags-stale-text").textContent = tagCache.update.added > 0 ? `收藏库标签已更新（新增 ${tagCache.update.added} 个）` : "收藏库标签已更新";
  $("tags-offline").hidden = !offline;
  $("tags-offline-text").textContent = dims.length ? "暂时连不上收藏库，显示本地缓存" : "暂时连不上收藏库，稍后重试";
  $("tags-loading").hidden = !loading;
  $("tags-empty").hidden = loading || offline || dims.length > 0;
  $("tags-body").hidden = loading || !dims.length;
  if (loading || !dims.length) return;

  if (tagDim !== "all" && !dims.some(d => d.id === tagDim)) tagDim = "all";
  const total = dims.reduce((n, d) => n + d.tags.length, 0);
  const filters = [{ id: "all", label: "全部", title: "全部", count: total }, ...dims.map(d => ({ id: d.id, label: shortLabel(d.label), title: d.label, count: d.tags.length }))];
  $("tag-filter").replaceChildren(...filters.map(f => {
    const b = document.createElement("button"); b.type = "button"; b.title = f.title; b.setAttribute("aria-pressed", String(tagDim === f.id));
    const n = document.createElement("span"); n.className = "n"; n.textContent = String(f.count);
    b.append(document.createTextNode(f.label), n);
    b.addEventListener("click", () => { tagDim = f.id; tagsExpanded = false; renderTags(); });
    return b;
  }));

  const visible = dims.filter(d => tagDim === "all" || d.id === tagDim).flatMap(d => d.tags.map(t => ({ ...t, dimension: d })))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));
  const max = visible.reduce((m, t) => Math.max(m, t.count), 0);
  $("tag-cloud").replaceChildren(...visible.map(t => {
    const on = selectedTags.has(t.tag_ref), fresh = freshTags.has(t.tag_ref);
    const b = document.createElement("button"); b.type = "button";
    b.className = `tag ${tagSize(t.count, max)}${fresh ? " new" : ""}`;
    b.setAttribute("aria-pressed", String(on));
    b.title = `${t.dimension.label} · ${t.count} 篇${fresh ? " · 新增" : ""}`;
    b.disabled = saving || saved;
    const n = document.createElement("span"); n.className = "n"; n.textContent = String(t.count);
    b.append(dot(t.dimension.color), document.createTextNode(t.label), n);
    b.addEventListener("click", () => toggleTag(t.tag_ref, t.dimension));
    return b;
  }));
  const canExpand = visible.length > 12;
  $("tag-cloud").classList.toggle("collapsed", canExpand && !tagsExpanded);
  $("tags-expand").hidden = !canExpand;
  $("tags-expand").textContent = tagsExpanded ? "收起" : `展开全部 ${visible.length} 个`;
  const known = knownTags();
  $("tags-picked").hidden = !chosen.length;
  $("tags-picked").textContent = `已选：${chosen.map(ref => known.get(ref).label).join("、")}`;
  $("tag-legend").hidden = chosen.length > 0 || tagDim !== "all";
  $("tag-legend").replaceChildren(...dims.slice(0, 4).map(d => { const s = document.createElement("span"); s.title = d.label; s.append(dot(d.color), document.createTextNode(shortLabel(d.label))); return s; }));
}

$("tags-expand").addEventListener("click", () => { tagsExpanded = !tagsExpanded; renderTags(); });
for (const button of [$("tags-refresh"), ...document.querySelectorAll("[data-tags-refresh]")]) button.addEventListener("click", () => void syncTags("refresh"));

async function syncTags(mode, { quiet = false } = {}) {
  if (tagPhase === "loading" || tagPhase === "refreshing") return;
  if (!quiet) { tagPhase = tagCache?.dimensions ? (mode === "refresh" ? "refreshing" : tagPhase) : "loading"; tagsVisible = true; renderTags(); }
  try {
    const { cache, added } = await send("tags-sync", { mode });
    if (!cache || cache.binding !== state?.binding) return;
    const before = chosenTags().length;
    tagCache = cache.unsupported ? null : cache;
    tagsVisible = Boolean(tagCache);
    for (const ref of added) freshTags.add(ref);
    tagPhase = mode === "refresh" && tagCache ? "synced" : "idle";
    if (tagsVisible && chosenTags().length !== before) void persistDraft();
  } catch {
    // Keep showing the cache with a retry banner. A quiet re-check of a
    // library that had no tag endpoint stays hidden.
    tagPhase = tagCache || !quiet ? "offline" : "idle";
  }
  renderTags();
  inputsChanged();
}

async function loadTags(stored) {
  // Only the Go collector has a tag catalog; other libraries hide the section.
  if (!state?.configured || state.server !== "cairn-go.alpenl.com") return;
  tagCache = stored?.binding === state.binding && stored.dimensions ? stored : null;
  if (tagCache) {
    tagsVisible = true;
    renderTags();
    if (prefs.tagAutoCheck !== false) await syncTags("check", { quiet: true });
  } else if (stored?.binding === state.binding && stored.unsupported) {
    // An older library said it has no tags; ask again quietly in case it was upgraded.
    await syncTags("refresh", { quiet: true });
  } else await syncTags("refresh");
}
