import { STATE_KEY, CaptureError, MAX_NOTE, submissionUrl, validateCapture } from "./config.mjs";
import { $, ext, renderQueue, queueStatus, send, showError, status } from "./ui.mjs";
import { mediaPermissions } from './capture.mjs';

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
  $("note-count").hidden = length < MAX_NOTE - 200;
  $("note-count").textContent = `${length} / ${MAX_NOTE}`;
  $("save").disabled = saving || saved || !configured || !valid();
  $("url").readOnly = saving;
  $("note").readOnly = saving;
  $("collection-choices").querySelectorAll("input").forEach(n=>n.disabled=saving||saved);
  const samePage = Boolean(activeTab?.id) && $("url").value === activeTab.url;
  // The current tab is shown as a card; the raw URL only matters when the
  // user pastes another link or the tab is not a web page.
  const showCard = !editingUrl && valid() && $("url").value === activeTab?.url;
  $("page-card").hidden = !showCard;
  $("url-field").hidden = showCard;
  $("page-title").textContent = title || hostOf($("url").value);
  $("page-host").textContent = hostOf($("url").value);
  $("favicon").hidden = !showCard || !$("favicon").getAttribute("src");
  $("capture-option").hidden = !samePage;
  $("capture-page").disabled = saving;
  $("save").textContent = saving ? "正在保存…" : saved ? "已保存" : "保存";
  $("recapture").hidden = !saved || saving;
  const stripped = valid() && state?.keepFullUrl === false && submissionUrl($("url").value, false) !== $("url").value.trim();
  $("url-policy").hidden = !stripped;
  if (stripped) $("url-policy").textContent = "按设置，保存时去掉链接中的参数。";
}

function persistDraft() {
  const draft = { url: $("url").value, note: $("note").value, title, client_id: operationId, collection_ids:[...selectedCollections],binding:state?.binding };
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
  if (!result.captured) return ["已上传到收藏库。", "success"];
  const parts = [];
  if (result.imagesSaved) parts.push(`${result.imagesSaved} 张图片`);
  if (result.mediaSaved) parts.push(`${result.mediaSaved} 个视频/音频`);
  const warnings = [];
  if (result.missingImages) warnings.push(`${result.missingImages} 张图片未取到，保留了来源链接`);
  if (result.truncated) warnings.push("正文过长，仅保存了部分");
  const head = result.action === "updated" ? "已更新原收藏" : "已同步";
  const text = `${head}${parts.length ? ` · ${parts.join("、")}` : ""}${warnings.length ? `。${warnings.join("；")}。` : ""}`;
  return [text, warnings.length ? "pending" : "success"];
}

async function refresh() {
  const next=await send("snapshot");if(state?.binding&&state.binding!==next.binding){selectedCollections.clear();definitions=[];renderCollections();}
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
    const capture = { url: $("url").value, note: $("note").value, title, client_id: operationId, collection_ids:[...selectedCollections],binding:state?.binding };
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
  const [tabs, stored] = await Promise.all([ext.tabs.query({ active: true, currentWindow: true }), ext.storage.local.get(DRAFT_KEY)]);
  const tab = tabs[0];
  activeTab = tab;
  if (tab?.id && /^https?:/.test(tab.url || '')) {
    try { requestedOrigins=await mediaPermissions(ext,tab.id,tab.url); } catch { /* Save still offers a useful extraction error. */ }
  }
  if (/^https?:/.test(tab?.favIconUrl || '')) $("favicon").src = tab.favIconUrl;
  const draft = stored[DRAFT_KEY];
  state = await send("snapshot");
  if (draft && !state.queue.some((job) => job.client_id === draft.client_id) && state.lastResult?.client_id !== draft.client_id) {
    $("url").value = draft.url;
    $("note").value = draft.note;
    selectedCollections=new Set(draft.binding===state.binding?(draft.collection_ids||[]):[]);
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
} catch (error) { showError($("status"), error); }

function renderCollections(){
 const root=$("collection-choices");root.replaceChildren();
 const active=definitions.filter(c=>!c.deleted&&!c.archived).sort((a,b)=>b.pinned-a.pinned||a.name.localeCompare(b.name));
 $("collections").hidden=!active.length;
 for(const c of active){
  const label=document.createElement("label");label.className="collection-choice";const input=document.createElement("input");input.type="checkbox";input.checked=selectedCollections.has(c.id);input.disabled=saving||saved;
  input.addEventListener("change",()=>{input.checked?selectedCollections.add(c.id):selectedCollections.delete(c.id);operationId=crypto.randomUUID();void persistDraft();inputsChanged();});
  const name=document.createElement("span");name.textContent=c.name;label.append(input,name);root.append(label);
 }
}
// Collections are optional; when the list can't be read the row stays hidden
// and saving works as usual.
async function loadCollections(){try{const result=await send("collections");if(result.binding!==state?.binding)return;definitions=result.items;renderCollections();}catch{/* keep hidden */}}
