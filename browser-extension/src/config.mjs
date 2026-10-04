export const API_BASE = "https://share.alpenl.com";
export const STATE_KEY = "cairn_capture_v1";
export const RETRY_ALARM = "cairn-upload";
export const MAX_QUEUE = 100;
export const MAX_URL = 8192;
export const MAX_NOTE = 2000;

export class CaptureError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

// Keep the exact shared URL, including its query, fragment and percent escapes.
export function validateCapture(url, note = "") {
  if (typeof url !== "string") throw new CaptureError("invalid_url");
  const value = url.trim();
  try {
    const parsed = new URL(value);
    if (!/^https?:\/\/[^/?#]/i.test(value) || !/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || value.length > MAX_URL) {
      throw new Error();
    }
  } catch {
    throw new CaptureError("invalid_url");
  }
  if (typeof note !== "string" || note.length > MAX_NOTE) throw new CaptureError("invalid_note");
  return { url: value, note };
}

export function submissionUrl(url, keepFullUrl) {
  const value = validateCapture(url).url;
  return keepFullUrl ? value : value.split(/[?#]/, 1)[0];
}

export async function tokenIdentity(token) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const ERROR_TEXT = {
  not_configured: "请先在设置中填写访问令牌。",
  invalid_url: "请填写完整的 HTTP(S) 链接，不能包含用户名或密码。",
  invalid_note: "备注最多 2000 个字符。",
  invalid_token: "访问令牌不可用，请在设置中重新连接。",
  invalid_client_id: "收藏标识无效，请更新扩展后重试。",
  network: "暂时无法连接，收藏已保留在本机。",
  timeout: "上传超时，收藏已保留在本机。",
  server: "服务暂时不可用，稍后会自动重试。",
  response: "服务器响应异常，收藏已保留，请稍后重试。",
  queue_full: "待上传队列已满，请先重试或移除部分收藏。",
  queue_connection: "请确认是否用新令牌上传已有的待上传收藏。",
  storage: "无法写入本机存储，收藏尚未保存，请重试。",
  capture_unavailable: "未能读取此页正文。请回到网页重试，或取消勾选正文采集，仅保存链接。",
  invalid_capture: "采集内容未通过校验，请更新插件后重试。",
  capture_conflict: "这次收藏的内容与已提交内容不同，请重新打开插件保存。",
  capture_images_incomplete: "本次图片未取全，原收藏已保留。请允许媒体站点权限后重新采集。",
  capture_deleted: "该收藏已经被删除，请移除待上传记录；如需恢复，请重新收藏。",
  upgrade_required: "收藏服务尚未支持正文采集。内容已保存在本机，服务更新后可重试。",
  media_permission: '正文已保存；媒体站点尚未授权，请点击允许读取媒体后重试。',
  media_unavailable: '正文已保存；未取得媒体文件，请在原页面播放或展开媒体后重新采集。',
  media_too_large: '正文已保存；单个媒体超过 256 MB，尚未归档。',
  media_protected: '正文已保存；媒体受加密保护，未能归档。',
  media_live_or_unsupported: '正文已保存；媒体为直播或未能取得完整播放列表，尚未归档。',
  media_unsupported: '正文已保存；媒体格式尚不支持，未归档。',
  media_stale: '原收藏已删除或已重新采集，请移除此旧媒体任务。',
  media_conflict: '媒体内容发生变化，请重新采集原页面。',
  invalid_media: '媒体文件未通过校验，请重新采集。',
  media_incomplete: '媒体尚未上传完整，请重试以继续上传。',
  unexpected: "操作未完成，请重试。"
};

export function errorText(kind) {
  return ERROR_TEXT[kind] ?? ERROR_TEXT.unexpected;
}
