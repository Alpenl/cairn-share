export interface Env {
  DB: D1Database;
  CAIRN_API_TOKEN: string;
}

interface LinkRecord {
  id: number;
  url: string;
  note: string;
  created_at: string;
  learned: boolean;
  learned_at: string | null;
}

interface LinkRow {
  id: number;
  url: string;
  note: string;
  created_at: string;
  learned: number;
  learned_at: string | null;
}

type ErrorCode =
  | "invalid_json"
  | "invalid_content_type"
  | "invalid_url"
  | "invalid_note"
  | "invalid_client_id"
  | "invalid_learned"
  | "invalid_query"
  | "invalid_update"
  | "invalid_limit"
  | "invalid_before_id"
  | "missing_auth"
  | "invalid_token"
  | "auth_not_configured"
  | "not_found"
  | "method_not_allowed";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  ...CORS_HEADERS
};

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  ...CORS_HEADERS
};

const MAX_URL_LENGTH = 8192;
const MAX_NOTE_LENGTH = 2000;
const MAX_QUERY_LENGTH = 200;
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const READ_CACHE_TTL_SECONDS = 15;
const READ_CACHE_CONTROL = `public, max-age=${READ_CACHE_TTL_SECONDS}, s-maxage=${READ_CACHE_TTL_SECONDS}`;
const CACHE_VERSION = "2";
const CACHE_ORIGIN = "https://cairn-share-cache.internal";
const LINKS_CACHE_GENERATION_KEY = "links_generation";

type CacheState = "MISS" | "HIT" | "BYPASS";

class TimingCollector {
  private readonly started = performance.now();
  private readonly entries: Array<{ name: string; duration: number }> = [];
  private cacheState: CacheState | null = null;

  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      this.entries.push({ name, duration: performance.now() - started });
    }
  }

  setCacheState(cacheState: CacheState): void {
    this.cacheState = cacheState;
  }

  headerValue(): string {
    const total = performance.now() - this.started;
    const metrics = [`total;dur=${formatDuration(total)}`];
    if (this.cacheState !== null) {
      metrics.push(`cache-state;desc="${this.cacheState}"`);
    }
    for (const entry of this.entries) {
      metrics.push(`${entry.name};dur=${formatDuration(entry.duration)}`);
    }
    return metrics.join(", ");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const timing = new TimingCollector();
    const response = await handleRequest(request, env, timing);
    return withServerTiming(response, timing);
  }
};

async function handleRequest(request: Request, env: Env, timing: TimingCollector): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = trimTrailingSlash(url.pathname);

  if (path === "/" || path === "/debug") {
    return routeMethod(request, ["GET"], () => html(apiDebugHtml()));
  }

  if (path === "/health") {
    return routeMethod(request, ["GET"], () => json({ ok: true }));
  }

  if (path === "/api/links") {
    const authError = requireApiToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET", "POST"], () => {
      if (request.method === "POST") return createLink(request, env, timing);
      return listLinks(request, url, env, timing);
    });
  }

  const linkIdMatch = path.match(/^\/api\/links\/(\d+)$/);
  if (linkIdMatch !== null) {
    const authError = requireApiToken(request, env);
    if (authError !== null) return authError;
    return routeMethod(request, ["GET", "PATCH", "DELETE"], () => {
      const id = Number(linkIdMatch[1]);
      if (request.method === "PATCH") return updateLink(request, env, id, timing);
      if (request.method === "DELETE") return deleteLink(env, id, timing);
      return getLink(request, url, id, env, timing);
    });
  }

  return json({ error: "not_found" }, 404);
}

async function createLink(request: Request, env: Env, timing: TimingCollector): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().split(";")[0].trim() !== "application/json") {
    return error("invalid_content_type");
  }

  const raw = await readJson(request);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return error("invalid_json");
  }

  const body = raw as Record<string, unknown>;
  const validation = validateLinkBodyForCreate(body);
  if (typeof validation === "string") {
    return error(validation);
  }

  const createdAt = new Date().toISOString();
  const row = await timing.measure("db", () =>
    env.DB.prepare(
      `INSERT INTO links (url, note, created_at, client_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(client_id) DO UPDATE SET client_id = excluded.client_id
        RETURNING id, url, note, created_at, learned, learned_at`
    )
      .bind(validation.url, validation.note, createdAt, validation.clientId)
      .first<LinkRow>()
  );

  if (row === null) {
    return json({ error: "not_found" }, 500);
  }

  await bumpLinksCacheGeneration(env, timing);
  return json(mapLink(row), 201);
}

async function listLinks(request: Request, url: URL, env: Env, timing: TimingCollector): Promise<Response> {
  const limit = parseBoundedInt(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  if (limit === null) return error("invalid_limit");

  const beforeId = parseOptionalPositiveInt(url.searchParams.get("before_id"));
  if (beforeId === null) return error("invalid_before_id");

  const learned = parseLearnedFilter(url.searchParams.get("learned"));
  if (learned === null) return error("invalid_learned");

  const query = parseSearchQuery(url.searchParams.get("q"));
  if (query === null) return error("invalid_query");

  return cachedJson(request, env, timing, (generation) => listCacheUrl(url, { limit, beforeId, learned, query }, generation), async () => {
    const pageSize = limit + 1;
    const select = "SELECT id, url, note, created_at, learned, learned_at FROM links";
    const order = "ORDER BY id DESC LIMIT ?";
    const clauses: string[] = [];
    const bindings: Array<string | number> = [];

    if (learned !== undefined) {
      clauses.push("learned = ?");
      bindings.push(learned ? 1 : 0);
    }
    if (beforeId !== undefined) {
      clauses.push("id < ?");
      bindings.push(beforeId);
    }
    if (query !== undefined) {
      clauses.push("(url LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(query)}%`;
      bindings.push(like, like);
    }

    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const statement = env.DB.prepare(`${select}${where} ${order}`).bind(...bindings, pageSize);

    const result = await timing.measure("db", () => statement.all<LinkRow>());
    const rows = result.results ?? [];
    const items = rows.slice(0, limit);
    const next = rows.length > limit ? items[items.length - 1]?.id ?? null : null;
    return { items: items.map(mapLink), next_before_id: next };
  });
}

async function getLink(request: Request, url: URL, id: number, env: Env, timing: TimingCollector): Promise<Response> {
  return cachedJson(request, env, timing, (generation) => detailCacheUrl(id, url, generation), async () => {
    const row = await timing.measure("db", () =>
      env.DB.prepare(
        "SELECT id, url, note, created_at, learned, learned_at FROM links WHERE id = ?"
      )
        .bind(id)
        .first<LinkRow>()
    );

    if (row === null) {
      return null;
    }
    return mapLink(row);
  });
}

async function updateLink(request: Request, env: Env, id: number, timing: TimingCollector): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().split(";")[0].trim() !== "application/json") {
    return error("invalid_content_type");
  }

  const raw = await readJson(request);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return error("invalid_json");
  }

  const body = raw as Record<string, unknown>;
  const updates: string[] = [];
  const bindings: Array<string | number | null> = [];

  if ("url" in body) {
    if (typeof body.url !== "string") {
      return error("invalid_url");
    }
    const url = body.url.trim();
    if (!isValidHttpUrl(url)) {
      return error("invalid_url");
    }
    updates.push("url = ?");
    bindings.push(url);
  }

  if ("note" in body) {
    if (typeof body.note !== "string" || body.note.length > MAX_NOTE_LENGTH) {
      return error("invalid_note");
    }
    updates.push("note = ?");
    bindings.push(body.note);
  }

  if ("learned" in body) {
    if (typeof body.learned !== "boolean") {
      return error("invalid_learned");
    }
    updates.push("learned = ?", "learned_at = ?");
    bindings.push(body.learned ? 1 : 0, body.learned ? new Date().toISOString() : null);
  }

  if (updates.length === 0) {
    return error("invalid_update");
  }

  bindings.push(id);
  const row = await timing.measure("db", () =>
    env.DB.prepare(
      `UPDATE links
        SET ${updates.join(", ")}
        WHERE id = ?
        RETURNING id, url, note, created_at, learned, learned_at`
    )
      .bind(...bindings)
      .first<LinkRow>()
  );

  if (row === null) {
    return error("not_found", 404);
  }
  await bumpLinksCacheGeneration(env, timing);
  return json(mapLink(row));
}

async function deleteLink(env: Env, id: number, timing: TimingCollector): Promise<Response> {
  const row = await timing.measure("db", () =>
    env.DB.prepare("DELETE FROM links WHERE id = ? RETURNING id")
      .bind(id)
      .first<{ id: number }>()
  );

  if (row === null) {
    return error("not_found", 404);
  }
  await bumpLinksCacheGeneration(env, timing);
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function cachedJson(
  request: Request,
  env: Env,
  timing: TimingCollector,
  cacheUrlForGeneration: (generation: number) => string,
  producer: () => Promise<unknown | null>
): Promise<Response> {
  if (shouldBypassReadCache(request)) {
    timing.setCacheState("BYPASS");
    const body = await producer();
    if (body === null) return error("not_found", 404);
    return json(body, 200, { "X-Cairn-Cache": "BYPASS" });
  }

  const generation = await readLinksCacheGeneration(env, timing);
  const cacheUrl = cacheUrlForGeneration(generation);
  const cacheRequest = new Request(cacheUrl, { method: "GET" });
  const cached = await timing.measure("cache", () => caches.default.match(cacheRequest));
  if (cached !== undefined) {
    timing.setCacheState("HIT");
    return withCacheHeader(cached, "HIT");
  }

  timing.setCacheState("MISS");
  const body = await producer();
  if (body === null) return error("not_found", 404);

  const response = cacheableJson(body, "MISS");
  await timing.measure("cache-put", () => caches.default.put(cacheRequest, response.clone()));
  return response;
}

function shouldBypassReadCache(request: Request): boolean {
  if (request.headers.has("cookie")) {
    return true;
  }
  const cacheControl = request.headers.get("cache-control") ?? "";
  return /\bno-cache\b|\bno-store\b/i.test(cacheControl);
}

function requireApiToken(request: Request, env: Env): Response | null {
  const expected = env.CAIRN_API_TOKEN?.trim();
  if (!expected) {
    return authError("auth_not_configured", 500);
  }

  const token = bearerToken(request.headers.get("authorization"));
  if (token === null) {
    return authError("missing_auth", 401);
  }
  if (!constantTimeEquals(token, expected)) {
    return authError("invalid_token", 401);
  }
  return null;
}

function bearerToken(authorization: string | null): string | null {
  if (authorization === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

function authError(code: "missing_auth" | "invalid_token" | "auth_not_configured", status: number): Response {
  const headers: HeadersInit = status === 401 ? { "WWW-Authenticate": "Bearer" } : {};
  return json({ error: code }, status, headers);
}

function constantTimeEquals(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;

  let diff = 0;
  for (let i = 0; i < leftBytes.length; i += 1) {
    diff |= leftBytes[i] ^ rightBytes[i];
  }
  return diff === 0;
}

function cacheableJson(body: unknown, cacheState: CacheState): Response {
  return json(body, 200, {
    "Cache-Control": READ_CACHE_CONTROL,
    "X-Cairn-Cache": cacheState
  });
}

function withCacheHeader(response: Response, cacheState: "HIT" | "BYPASS"): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", READ_CACHE_CONTROL);
  headers.set("X-Cairn-Cache", cacheState);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function withServerTiming(response: Response, timing: TimingCollector): Response {
  const headers = new Headers(response.headers);
  headers.set("Server-Timing", timing.headerValue());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function formatDuration(duration: number): string {
  return Math.max(0, duration).toFixed(1);
}

async function readLinksCacheGeneration(env: Env, timing: TimingCollector): Promise<number> {
  const row = await timing.measure("generation", () =>
    env.DB.prepare("SELECT value FROM cache_metadata WHERE key = ?")
      .bind(LINKS_CACHE_GENERATION_KEY)
      .first<{ value: number | string }>()
  );
  const value = Number(row?.value ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

async function bumpLinksCacheGeneration(env: Env, timing: TimingCollector): Promise<void> {
  await timing.measure("generation", () =>
    env.DB.prepare(
      `INSERT INTO cache_metadata (key, value, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = cache_metadata.value + 1,
          updated_at = excluded.updated_at`
    )
      .bind(LINKS_CACHE_GENERATION_KEY, new Date().toISOString())
      .run()
  );
}

function listCacheUrl(
  requestUrl: URL,
  parsed: {
    limit: number;
    beforeId: number | undefined;
    learned: boolean | undefined;
    query: string | undefined;
  },
  generation: number
): string {
  const url = new URL("/api/links", CACHE_ORIGIN);
  url.searchParams.set("v", CACHE_VERSION);
  url.searchParams.set("g", String(generation));
  url.searchParams.set("limit", String(parsed.limit));
  if (parsed.beforeId !== undefined) url.searchParams.set("before_id", String(parsed.beforeId));
  if (parsed.learned !== undefined) url.searchParams.set("learned", parsed.learned ? "true" : "false");
  if (parsed.query !== undefined) url.searchParams.set("q", parsed.query);
  url.searchParams.set("host", requestUrl.host);
  return url.toString();
}

function detailCacheUrl(id: number, requestUrl: URL, generation: number): string {
  const url = new URL(`/api/links/${id}`, CACHE_ORIGIN);
  url.searchParams.set("v", CACHE_VERSION);
  url.searchParams.set("g", String(generation));
  url.searchParams.set("host", requestUrl.host);
  return url.toString();
}

function routeMethod(
  request: Request,
  allowed: ReadonlyArray<"GET" | "POST" | "PATCH" | "DELETE">,
  handler: () => Promise<Response> | Response
): Promise<Response> | Response {
  if (allowed.includes(request.method as "GET" | "POST" | "PATCH" | "DELETE")) {
    return handler();
  }
  return json(
    { error: "method_not_allowed" },
    405,
    { Allow: [...allowed, "OPTIONS"].join(", ") }
  );
}

function parseSearchQuery(raw: string | null): string | undefined | null {
  if (raw === null || raw === "") return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value.length > MAX_QUERY_LENGTH) return null;
  return value;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function validateLinkBodyForCreate(
  body: Record<string, unknown>
): { url: string; note: string; clientId: string | null } | ErrorCode {
  if (typeof body.url !== "string") {
    return "invalid_url";
  }
  if (body.note !== undefined && typeof body.note !== "string") {
    return "invalid_note";
  }
  if (body.client_id !== undefined && (typeof body.client_id !== "string" || !CLIENT_ID_PATTERN.test(body.client_id))) {
    return "invalid_client_id";
  }

  const url = body.url.trim();
  const note = body.note === undefined ? "" : body.note;
  if (!isValidHttpUrl(url)) {
    return "invalid_url";
  }
  if (url.length > MAX_URL_LENGTH || note.length > MAX_NOTE_LENGTH) {
    return url.length > MAX_URL_LENGTH ? "invalid_url" : "invalid_note";
  }
  return { url, note, clientId: body.client_id === undefined ? null : body.client_id };
}

async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isValidHttpUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  if (!/^https?:\/\/[^/?#]/i.test(value)) return false;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.hostname.length === 0) return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    return true;
  } catch {
    return false;
  }
}

function parseBoundedInt(raw: string | null, fallback: number, max: number): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) return null;
  return value;
}

function parseOptionalPositiveInt(raw: string | null): number | undefined | null {
  if (raw === null || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

function parseLearnedFilter(raw: string | null): boolean | undefined | null {
  if (raw === null || raw === "" || raw === "all") return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return null;
}

function mapLink(row: LinkRow): LinkRecord {
  return {
    id: row.id,
    url: row.url,
    note: row.note,
    created_at: row.created_at,
    learned: row.learned === 1,
    learned_at: row.learned_at
  };
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function error(code: ErrorCode, status = 400): Response {
  return json({ error: code }, status);
}

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...extraHeaders
    }
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: HTML_HEADERS
  });
}

function apiDebugHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cairn Share API 调试台</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f4ee;
      --card: #ffffff;
      --text: #1e1b16;
      --muted: #6f6559;
      --line: #e5ddd2;
      --primary: #6d4c21;
      --primary-contrast: #ffffff;
      --danger: #9b1c1c;
      --code: #15120f;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #15120f;
        --card: #211d18;
        --text: #f3ece2;
        --muted: #cfc2b3;
        --line: #3c342c;
        --primary: #e8bf79;
        --primary-contrast: #271805;
        --danger: #ffb4a8;
        --code: #090806;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top left, rgba(232, 191, 121, .22), transparent 34rem), var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
    }
    main {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 44px;
    }
    header {
      display: grid;
      gap: 12px;
      margin-bottom: 22px;
    }
    h1, h2, p { margin: 0; }
    h1 { font-size: clamp(30px, 5vw, 56px); letter-spacing: -.04em; line-height: 1.02; }
    h2 { font-size: 18px; }
    .lead { max-width: 760px; color: var(--muted); font-size: 17px; }
    .warning {
      border: 1px solid rgba(155, 28, 28, .35);
      background: rgba(155, 28, 28, .08);
      color: var(--danger);
      border-radius: 18px;
      padding: 14px 16px;
      font-weight: 650;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      align-items: start;
    }
    .card {
      background: color-mix(in oklab, var(--card), transparent 0%);
      border: 1px solid var(--line);
      border-radius: 24px;
      padding: 18px;
      box-shadow: 0 18px 42px rgba(55, 41, 23, .08);
    }
    .card.full { grid-column: 1 / -1; }
    .row { display: grid; gap: 10px; margin-top: 14px; }
    .inline {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 11px 12px;
      background: var(--card);
      color: var(--text);
      font: inherit;
    }
    input[type="checkbox"] { width: auto; }
    textarea { min-height: 92px; resize: vertical; }
    button {
      border: 0;
      border-radius: 999px;
      padding: 11px 16px;
      background: var(--primary);
      color: var(--primary-contrast);
      font: inherit;
      font-weight: 750;
      cursor: pointer;
    }
    button.secondary {
      background: transparent;
      color: var(--primary);
      border: 1px solid color-mix(in oklab, var(--primary), transparent 55%);
    }
    button.danger {
      background: var(--danger);
      color: #fff;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 14px;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    pre {
      min-height: 260px;
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--code);
      color: #f7f0e6;
      border-radius: 18px;
      padding: 16px;
      font-size: 13px;
    }
    .meta {
      color: var(--muted);
      font-size: 13px;
      margin-top: 10px;
    }
    a { color: var(--primary); }
    @media (max-width: 820px) {
      .grid, .inline { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="meta">Cairn Share · Cloudflare Worker + D1</p>
      <h1>API 调试台</h1>
      <p class="lead">这个页面直接调用当前域名下的 API。填写访问 Token 后，可以创建、查询、搜索、修改和删除链接，用来验证 Android App 背后的 Cloudflare 接口。</p>
      <div class="warning">链接 API 已启用 Bearer Token 保护。不要在非可信设备上保存 Token，也不要把 Token 放进 URL 查询参数。</div>
    </header>

    <section class="grid">
      <section class="card full">
        <h2>访问 Token</h2>
        <div class="row">
          <label>API Token
            <input id="api-token" type="password" autocomplete="off" placeholder="Authorization: Bearer ...">
          </label>
        </div>
        <div class="actions">
          <button type="button" id="save-token">保存到浏览器</button>
          <button type="button" class="secondary" id="clear-token">清除</button>
        </div>
        <p class="meta">Token 只保存在当前浏览器的 localStorage 中。/health 不需要 Token，其它 /api/links 请求都会自动带上 Authorization 头。</p>
      </section>

      <form class="card" id="create-form">
        <h2>创建链接</h2>
        <div class="row">
          <label>URL
            <input id="create-url" required placeholder="https://example.com/a?x=1#fragment">
          </label>
          <label>备注
            <textarea id="create-note" maxlength="2000" placeholder="可选，例如：稍后阅读、项目资料"></textarea>
          </label>
        </div>
        <div class="actions">
          <button type="submit">POST /api/links</button>
        </div>
      </form>

      <form class="card" id="list-form">
        <h2>查询列表</h2>
        <div class="row">
          <div class="inline">
            <label>学习状态
              <select id="list-learned">
                <option value="all">全部</option>
                <option value="false">未学习</option>
                <option value="true">已学习</option>
              </select>
            </label>
            <label>数量
              <input id="list-limit" type="number" min="1" max="100" value="20">
            </label>
          </div>
          <div class="inline">
            <label>搜索关键词
              <input id="list-q" maxlength="200" placeholder="链接或备注">
            </label>
            <label>before_id
              <input id="list-before" type="number" min="1" placeholder="分页用，可空">
            </label>
          </div>
        </div>
        <div class="actions">
          <button type="submit">GET /api/links</button>
          <button type="button" class="secondary" id="health-button">GET /health</button>
        </div>
      </form>

      <form class="card" id="read-form">
        <h2>读取或删除单条</h2>
        <div class="row">
          <label>链接 ID
            <input id="read-id" type="number" min="1" placeholder="1">
          </label>
        </div>
        <div class="actions">
          <button type="submit">GET /api/links/:id</button>
          <button type="button" class="danger" id="delete-button">DELETE /api/links/:id</button>
        </div>
      </form>

      <form class="card" id="update-form">
        <h2>修改链接</h2>
        <div class="row">
          <label>链接 ID
            <input id="update-id" type="number" min="1" placeholder="1">
          </label>
          <label>新 URL（可空）
            <input id="update-url" placeholder="https://example.com/updated">
          </label>
          <label>新备注
            <textarea id="update-note" maxlength="2000" placeholder="新的备注"></textarea>
          </label>
          <label class="check">
            <input id="update-note-enabled" type="checkbox">
            提交备注字段，可用于清空备注
          </label>
          <label>学习状态
            <select id="update-learned">
              <option value="">不修改</option>
              <option value="true">已学习</option>
              <option value="false">未学习</option>
            </select>
          </label>
        </div>
        <div class="actions">
          <button type="submit">PATCH /api/links/:id</button>
        </div>
      </form>

      <section class="card full">
        <h2>响应</h2>
        <p class="meta">所有请求都从浏览器直接发往 <code id="origin"></code>，没有隐藏代理。</p>
        <pre id="output">等待请求...</pre>
      </section>
    </section>
  </main>

  <script>
    const out = document.getElementById("output");
    const tokenInput = document.getElementById("api-token");
    const tokenStorageKey = "cairn-share-api-token";
    document.getElementById("origin").textContent = location.origin;
    tokenInput.value = localStorage.getItem(tokenStorageKey) || "";

    function value(id) {
      return document.getElementById(id).value.trim();
    }

    function show(payload) {
      out.textContent = JSON.stringify(payload, null, 2);
    }

    function apiToken() {
      return tokenInput.value.trim();
    }

    async function send(method, path, body) {
      out.textContent = "请求中...";
      const options = { method, headers: { "Accept": "application/json" } };
      if (path.startsWith("/api/")) {
        const token = apiToken();
        if (token) {
          options.headers["Authorization"] = "Bearer " + token;
        }
      }
      if (body !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }
      const response = await fetch(path, options);
      const text = await response.text();
      let parsed = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (_) {}
      show({
        method,
        path,
        status: response.status,
        ok: response.ok,
        cache: response.headers.get("x-cairn-cache"),
        serverTiming: response.headers.get("server-timing"),
        body: parsed
      });
    }

    document.getElementById("save-token").addEventListener("click", function () {
      localStorage.setItem(tokenStorageKey, apiToken());
      show({ ok: true, message: "Token 已保存到当前浏览器。" });
    });

    document.getElementById("clear-token").addEventListener("click", function () {
      localStorage.removeItem(tokenStorageKey);
      tokenInput.value = "";
      show({ ok: true, message: "Token 已清除。" });
    });

    document.getElementById("create-form").addEventListener("submit", function (event) {
      event.preventDefault();
      send("POST", "/api/links", { url: value("create-url"), note: document.getElementById("create-note").value });
    });

    document.getElementById("list-form").addEventListener("submit", function (event) {
      event.preventDefault();
      const params = new URLSearchParams();
      params.set("learned", value("list-learned"));
      params.set("limit", value("list-limit") || "20");
      if (value("list-q")) params.set("q", value("list-q"));
      if (value("list-before")) params.set("before_id", value("list-before"));
      send("GET", "/api/links?" + params.toString());
    });

    document.getElementById("health-button").addEventListener("click", function () {
      send("GET", "/health");
    });

    document.getElementById("read-form").addEventListener("submit", function (event) {
      event.preventDefault();
      send("GET", "/api/links/" + value("read-id"));
    });

    document.getElementById("delete-button").addEventListener("click", function () {
      const id = value("read-id");
      if (!id || !confirm("确认删除链接 #" + id + "？")) return;
      send("DELETE", "/api/links/" + id);
    });

    document.getElementById("update-form").addEventListener("submit", function (event) {
      event.preventDefault();
      const body = {};
      const url = value("update-url");
      const learned = value("update-learned");
      if (url) body.url = url;
      if (document.getElementById("update-note-enabled").checked) {
        body.note = document.getElementById("update-note").value;
      }
      if (learned) body.learned = learned === "true";
      send("PATCH", "/api/links/" + value("update-id"), body);
    });
  </script>
</body>
</html>`;
}
