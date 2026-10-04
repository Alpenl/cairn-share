import { API_BASE, STATE_KEY } from "./config.mjs";
import { $, ext, renderQueue, send, showError, status } from "./ui.mjs";

let state;
let initialized = false;
$("server").value = API_BASE;
$("version").textContent = ext.runtime.getManifest().version;
$("show-token").addEventListener("click", () => {
  const show = $("token").type === "password";
  $("token").type = show ? "text" : "password";
  $("show-token").textContent = show ? "隐藏" : "显示";
  $("show-token").setAttribute("aria-label", show ? "隐藏访问令牌" : "显示访问令牌");
});

async function refresh() {
  state = await send("snapshot");
  $("token").placeholder = state.configured ? "已保存；留空保留当前令牌" : "填写访问令牌";
  $("pending-count").textContent = String(state.queue.length);
  $("retry-all").hidden = !state.queue.length;
  $("move-pending-label").hidden = !state.queue.length;
  $("move-pending-text").textContent = `更换令牌时，用新令牌上传这 ${state.queue.length} 条待上传收藏`;
  renderQueue($("queue"), state, refresh, (error) => showError($("status"), error));
}

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!initialized || $("connect").disabled) return;
  $("connect").disabled = true;
  $("connect").textContent = "正在测试连接…";
  try {
    const settings = { token: $("token").value, keepFullUrl: $("keep-full-url").checked, movePending: $("move-pending").checked };
    await send("settings", { settings });
    $("token").value = "";
    $("move-pending").checked = false;
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
  finally { $("connect").disabled = false; $("connect").textContent = "测试并保存连接"; }
});

$("retry-all").addEventListener("click", async () => {
  $("retry-all").disabled = true;
  try { await send("retry"); await refresh(); } catch (error) { showError($("status"), error); }
  finally { $("retry-all").disabled = false; }
});
ext.storage.onChanged.addListener((changes, area) => {
  if (initialized && area === "local" && changes[STATE_KEY]) void refresh().catch((error) => showError($("status"), error));
});
try {
  await refresh();
  $("keep-full-url").checked = state.keepFullUrl;
  initialized = true;
  $("connect").disabled = false;
} catch (error) { showError($("status"), error); }
