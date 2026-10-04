import { API_BASE, STATE_KEY, CaptureError, submissionUrl, validateCapture } from "./config.mjs";
import { $, ext, renderQueue, send, showError, status } from "./ui.mjs";

let state;
let title = "";
let activeTab;
let saved = false;
let operationId = crypto.randomUUID();
let saving = false;
let initialized = false;
let draftWrites = Promise.resolve();
const DRAFT_KEY = "cairn_capture_draft";

$("server").textContent = new URL(API_BASE).host;
$("settings").addEventListener("click", () => ext.runtime.openOptionsPage());

function valid() {
  try { validateCapture($("url").value, $("note").value); return true; } catch { return false; }
}

function inputsChanged() {
  $("note-count").textContent = `${$("note").value.length} / 2000`;
  $("save").disabled = saving || saved || !state?.configured || !valid();
  $("url").readOnly = saving;
  $("note").readOnly = saving;
  const samePage = activeTab?.id && $("url").value === activeTab.url;
  $("capture-page").disabled = saving || !samePage;
  $("capture-hint").textContent = samePage ? "保存已加载的正文和图片。未展开或未加载的内容不在采集范围内。" : "当前链接不是打开的网页，将仅保存链接。";
  $("save").textContent = saving ? "正在采集并保存…" : saved ? "已保存" : "保存收藏";
  if (valid()) {
    const url = submissionUrl($("url").value, state?.keepFullUrl !== false);
    $("url-policy").textContent = state?.keepFullUrl === false ? `将保存：${url}（已按设置移除 query 和 fragment）` : "保留完整链接，包括 query 和 fragment。";
  } else $("url-policy").textContent = "浏览器内部页面无法收藏，可以在上方粘贴网页链接。";
}

function persistDraft() {
  const draft = { url: $("url").value, note: $("note").value, title, client_id: operationId };
  draftWrites = draftWrites.catch(() => {}).then(() => ext.storage.local.set({ [DRAFT_KEY]: draft }))
    .catch(() => { throw new CaptureError("storage"); });
  return draftWrites;
}

for (const id of ["url", "note"]) $(id).addEventListener("input", () => {
  saved = false;
  status($("status"), "");
  if (id === "url") { title = ""; $("page-title").textContent = ""; }
  operationId = crypto.randomUUID();
  inputsChanged();
  void persistDraft().catch((error) => showError($("status"), error));
});

async function refresh() {
  state = await send("snapshot");
  $("connection").textContent = state.configured ? "已连接到你的收藏库" : "首次使用，请先打开设置填写访问令牌。";
  $("pending-count").textContent = String(state.queue.length);
  $("retry-all").hidden = state.queue.length === 0;
  renderQueue($("queue"), state, refresh, (error) => showError($("status"), error));
  if (state.lastResult?.client_id === operationId) {
    const result = state.lastResult;
    saved = true;
    const warning = result.missingImages ? ` ${result.missingImages} 张图片未归档，保留了来源链接。` : "";
    const truncated = result.truncated ? " 正文过长，仅保存了部分内容。" : "";
    const pending = state.queue.find(j => j.client_id === operationId);
    if (pending?.errorKind) showError($("status"), {kind: pending.errorKind});
    else status($("status"), result.status === "uploaded" ? (result.captured ? "正文与已取得的图片已同步。" : "已上传，Android 收藏中也能看到。") + warning + truncated : "已保存在本机，正在上传；可以关闭窗口。", result.status === "uploaded" ? "success" : "pending");
  }
  inputsChanged();
}

$("capture-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving || !initialized || !state?.configured || !valid()) return;
  saving = true;
  $("save").textContent = "正在保存…";
  status($("status"), "正在读取当前页面，请稍候…", "pending");
  inputsChanged();
  try {
    await persistDraft();
    const capture = { url: $("url").value, note: $("note").value, title, client_id: operationId };
    await send("save", { capture, tabId: activeTab?.id, capturePage: $("capture-page").checked && capture.url === activeTab?.url });
    await draftWrites;
    await ext.storage.local.remove(DRAFT_KEY);
    status($("status"), "已保存在本机，正在上传…", "pending");
    await refresh();
    // Keep the submitted UUID until the user edits the form. A double click
    // or re-submit of the same form is the same operation.
  } catch (error) { showError($("status"), error); }
  finally { saving = false; $("save").textContent = "保存收藏"; inputsChanged(); }
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
    const granted = await ext.permissions.request({origins:["http://*/*", "https://*/*"]});
    status($("status"), granted ? "已允许读取正文引用的图片。仅在你收藏时使用。" : "未开启额外权限，部分跨站图片可能无法归档。", granted ? "success" : "pending");
  } catch (error) { showError($("status"), error); }
});
$("capture-page").addEventListener("change", () => { saved=false; operationId=crypto.randomUUID(); inputsChanged(); });
document.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !$("save").disabled) $("capture-form").requestSubmit(); });

try {
  const [tabs, stored] = await Promise.all([ext.tabs.query({ active: true, currentWindow: true }), ext.storage.local.get(DRAFT_KEY)]);
  const tab = tabs[0];
  activeTab = tab;
  const draft = stored[DRAFT_KEY];
  state = await send("snapshot");
  if (draft && !state.queue.some((job) => job.client_id === draft.client_id) && state.lastResult?.client_id !== draft.client_id) {
    $("url").value = draft.url;
    $("note").value = draft.note;
    title = draft.title;
    operationId = draft.client_id;
    if (draft.url !== tab?.url) status($("status"), "已恢复上次未保存的草稿。请确认链接后保存。", "pending");
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
  $("page-title").textContent = title;
  initialized = true;
  await refresh();
} catch (error) { showError($("status"), error); }
