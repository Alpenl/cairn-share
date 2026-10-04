import { CaptureError, errorText } from "./config.mjs";

export const ext = globalThis.browser ?? chrome;
export const $ = (id) => document.getElementById(id);

export async function send(type, fields = {}) {
  const result = await ext.runtime.sendMessage({ type, ...fields });
  if (!result?.ok) throw new CaptureError(result?.error ?? "unexpected");
  return result.state;
}

export function status(element, text, kind = "") {
  element.textContent = text;
  element.className = `status ${kind}`;
  element.hidden = !text;
}

export function showError(element, error) {
  status(element, errorText(error.kind), "error");
}

export function renderQueue(container, state, refresh, onError) {
  container.replaceChildren();
  if (!state.queue.length) {
    const empty = document.createElement("p");
    empty.className = "muted empty";
    empty.textContent = "所有收藏已同步。";
    container.append(empty);
    return;
  }
  for (const job of state.queue) {
    const row = document.createElement("article");
    row.className = "queue-item";
    const title = document.createElement("div");
    title.className = "queue-title";
    title.textContent = job.title || job.url;
    title.title = job.url;
    const url = document.createElement("p");
    url.className = "queue-url";
    url.textContent = job.url;
    const info = document.createElement("p");
    info.className = "muted";
    info.textContent = job.errorKind ? errorText(job.errorKind) : "已保存在本机，等待上传。";
    const actions = document.createElement("div");
    actions.className = "row-actions";
    for (const [label, type] of [["重试", "retry"], ["移除", "remove"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.textContent = label;
      button.addEventListener("click", async () => {
        if (type === "remove" && !confirm("移除这条尚未上传的收藏？")) return;
        button.disabled = true;
        try { await send(type, { client_id: job.client_id }); await refresh(); } catch (error) { onError(error); }
        finally { button.disabled = false; }
      });
      actions.append(button);
    }
    row.append(title, url, info, actions);
    container.append(row);
  }
}
