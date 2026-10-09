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
  const prefix=job.savedLink ? '正文已同步；' : '';
  if(job.errorKind) {
    const stage=({text:'正文上传',images:'图片归档',media:'视频/音频归档',collections:'加入合集'})[job.stage]||'同步';
    const reason=job.errorKind==='timeout'?'连接超时，将核对进度后重试。':errorText(job.errorKind).replace(/^(正文|收藏)已保存；/,'');
    return `${prefix}${stage}暂未完成：${reason}`;
  }
  if(job.stage==='images')return `${prefix}正在归档图片 ${job.imageProgress?.uploaded||0}/${job.imageProgress?.total||0}`;
  if(job.stage==='media')return `${prefix}正在归档视频/音频${job.mediaProgress?` ${Math.round(100*job.mediaProgress.uploaded/job.mediaProgress.size)}%`:''}`;
  if(job.stage==='collections')return `${prefix}正在加入合集`;
  return '等待上传';
}

// `jobs` lets the popup show only items that need attention; the options
// page passes the full queue and an empty-state message.
export function renderQueue(container, jobs, refresh, onError, emptyText = "") {
  container.replaceChildren();
  if (!jobs.length) {
    if (!emptyText) return;
    const empty = document.createElement("p");
    empty.className = "muted empty";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  for (const job of jobs) {
    const row = document.createElement("article");
    row.className = job.errorKind ? "queue-item failed" : "queue-item";
    const title = document.createElement("div");
    title.className = "queue-title";
    title.textContent = job.title || job.url.replace(/^https?:\/\//, "");
    title.title = job.url;
    const info = document.createElement("p");
    info.className = "queue-info";
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
    row.append(title, info, actions);
    container.append(row);
  }
}
