import { API_BASE, STATE_KEY, CaptureError, submissionUrl, validateCapture } from "./config.mjs";
import { $, ext, renderQueue, send, showError, status } from "./ui.mjs";
import { mediaPermissions } from './capture.mjs';

let state;
let title = "";
let activeTab;
let saved = false;
let operationId = crypto.randomUUID();
let saving = false;
let initialized = false;
let requestedOrigins = [];
let selectedCollections=new Set();let definitions=[];
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
  $("collection-choices").querySelectorAll("input").forEach(n=>n.disabled=saving||saved);
  const samePage = activeTab?.id && $("url").value === activeTab.url;
  $("capture-page").disabled = saving || !samePage;
  $("capture-hint").textContent = samePage ? "保存已加载的正文和图片。未展开或未加载的内容不在采集范围内。" : "当前链接不是打开的网页，将仅保存链接。";
  $("save").textContent = saving ? "正在采集并保存…" : saved ? "已保存" : "保存收藏";
  $("recapture").hidden = !saved || saving;
  if (valid()) {
    const url = submissionUrl($("url").value, state?.keepFullUrl !== false);
    $("url-policy").textContent = state?.keepFullUrl === false ? `将保存：${url}（已按设置移除 query 和 fragment）` : "保留完整链接，包括 query 和 fragment。";
  } else $("url-policy").textContent = "浏览器内部页面无法收藏，可以在上方粘贴网页链接。";
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
  if (id === "url") { title = ""; $("page-title").textContent = ""; }
  operationId = crypto.randomUUID();
  inputsChanged();
  void persistDraft().catch((error) => showError($("status"), error));
});

async function refresh() {
  const next=await send("snapshot");if(state?.binding&&state.binding!==next.binding){selectedCollections.clear();definitions=[];renderCollections();}
  state=next;
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
    else status($("status"), result.status === "uploaded" ? (result.captured ? `${result.action==='updated'?'已更新原收藏':'正文已同步'} · ${result.imagesSaved || 0} 张图片、${result.mediaSaved || 0} 个视频/音频已归档。` : "已上传，Android 收藏中也能看到。") + warning + truncated : result.status==='media' ? `正文已同步，正在归档媒体${pending?.mediaProgress ? `（${Math.round(100*pending.mediaProgress.uploaded/pending.mediaProgress.size)}%）` : ''}；可以关闭窗口。` : "已保存在本机，正在上传；可以关闭窗口。", result.status === "uploaded" && !warning && !truncated ? "success" : "pending");
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
    const origins=[...new Set([...requestedOrigins,...(state?.queue || []).flatMap(j=>j.requiredOrigins || [])])];
    const granted = await ext.permissions.request({origins:origins.length?origins:["http://*/*", "https://*/*"]});
    status($("status"), granted ? "已允许读取正文引用的图片。仅在你收藏时使用。" : "未开启额外权限，部分跨站图片可能无法归档。", granted ? "success" : "pending");
  } catch (error) { showError($("status"), error); }
});
$("recapture").addEventListener('click',()=>{saved=false;operationId=crypto.randomUUID();inputsChanged();$("capture-form").requestSubmit();});
$("capture-page").addEventListener("change", () => { saved=false; operationId=crypto.randomUUID(); inputsChanged(); });
document.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !$("save").disabled) $("capture-form").requestSubmit(); });

try {
  const [tabs, stored] = await Promise.all([ext.tabs.query({ active: true, currentWindow: true }), ext.storage.local.get(DRAFT_KEY)]);
  const tab = tabs[0];
  activeTab = tab;
  if (tab?.id && /^https?:/.test(tab.url || '')) {
    try { requestedOrigins=await mediaPermissions(ext,tab.id,tab.url); } catch { /* Save still offers a useful extraction error. */ }
  }
  const draft = stored[DRAFT_KEY];
  state = await send("snapshot");
  if (draft && !state.queue.some((job) => job.client_id === draft.client_id) && state.lastResult?.client_id !== draft.client_id) {
    $("url").value = draft.url;
    $("note").value = draft.note;
    selectedCollections=new Set(draft.binding===state.binding?(draft.collection_ids||[]):[]);
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
  void loadCollections();
} catch (error) { showError($("status"), error); }

function renderCollections(){
 const root=$("collection-choices");root.replaceChildren();
 for(const c of definitions.filter(c=>!c.deleted&&!c.archived).sort((a,b)=>b.pinned-a.pinned||a.name.localeCompare(b.name))){
  const label=document.createElement("label");label.className="collection-choice";const input=document.createElement("input");input.type="checkbox";input.checked=selectedCollections.has(c.id);input.disabled=saving||saved;
  input.addEventListener("change",()=>{input.checked?selectedCollections.add(c.id):selectedCollections.delete(c.id);operationId=crypto.randomUUID();void persistDraft();inputsChanged();});
  const name=document.createElement("span");name.textContent=c.name;label.append(input,name);root.append(label);
 }
}
async function loadCollections(){try{const result=await send("collections");if(result.binding!==state?.binding)return;definitions=result.items;renderCollections();$("collection-status").textContent=result.cached?"离线列表，联网后核对并加入。":definitions.some(c=>!c.deleted&&!c.archived)?"可选多个合集。":"还没有使用中的合集，可在网页或 APP 中新建。";}catch(error){$("collection-status").textContent="合集暂时无法读取，仍可保存收藏。";}}
$("refresh-collections").addEventListener("click",loadCollections);
