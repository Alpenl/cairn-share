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

export function queueStatus(job) {
  const prefix=job.savedLink ? '正文已同步；' : '已保存在本机；';
  if(job.errorKind) {
    const stage=({text:'正文上传',images:'图片归档',media:'视频/音频归档',collections:'加入合集'})[job.stage]||'同步';
    const reason=job.errorKind==='timeout'?'连接超时，将核对进度后重试。':errorText(job.errorKind);
    return `${prefix}${stage}暂未完成：${reason}`;
  }
  if(job.stage==='images')return `${prefix}图片 ${job.imageProgress?.uploaded||0}/${job.imageProgress?.total||0}，正在后台归档。`;
  if(job.stage==='media')return `${prefix}正在归档视频/音频${job.mediaProgress?`（${Math.round(100*job.mediaProgress.uploaded/job.mediaProgress.size)}%）`:''}。`;
  if(job.stage==='collections')return `${prefix}正在加入合集。`;
  return `${prefix}等待上传，可以关闭窗口。`;
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
    info.textContent = queueStatus(job);
    const actions = document.createElement("div");
    actions.className = "row-actions";
    for (const [label, type] of [["重试", "retry"], ["移除", "remove"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.textContent = label;
      button.addEventListener("click", async () => {
        if (type === "remove" && !confirm("停止这条收藏的后续同步？服务器已保存的内容会保留。")) return;
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
