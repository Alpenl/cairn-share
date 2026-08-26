export interface Env {
  DB: D1Database;
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
  | "invalid_learned"
  | "invalid_limit"
  | "invalid_before_id"
  | "not_found"
  | "method_not_allowed";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  ...CORS_HEADERS
};

const MAX_URL_LENGTH = 8192;
const MAX_NOTE_LENGTH = 2000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = trimTrailingSlash(url.pathname);

    if (path === "/health") {
      return routeMethod(request, ["GET"], () => json({ ok: true }));
    }

    if (path === "/api/links") {
      return routeMethod(request, ["GET", "POST"], () => {
        if (request.method === "POST") return createLink(request, env);
        return listLinks(url, env);
      });
    }

    const linkIdMatch = path.match(/^\/api\/links\/(\d+)$/);
    if (linkIdMatch !== null) {
      return routeMethod(request, ["GET", "PATCH"], () => {
        const id = Number(linkIdMatch[1]);
        if (request.method === "PATCH") return updateLinkLearned(request, env, id);
        return getLink(id, env);
      });
    }

    return json({ error: "not_found" }, 404);
  }
};

async function createLink(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().split(";")[0].trim() !== "application/json") {
    return error("invalid_content_type");
  }

  const raw = await readJson(request);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return error("invalid_json");
  }

  const body = raw as Record<string, unknown>;
  if (typeof body.url !== "string") {
    return error("invalid_url");
  }
  if (body.note !== undefined && typeof body.note !== "string") {
    return error("invalid_note");
  }

  const url = body.url.trim();
  const note = body.note ?? "";
  if (!isValidHttpUrl(url)) {
    return error("invalid_url");
  }
  if (url.length > MAX_URL_LENGTH || note.length > MAX_NOTE_LENGTH) {
    return error(url.length > MAX_URL_LENGTH ? "invalid_url" : "invalid_note");
  }

  const createdAt = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO links (url, note, created_at)
      VALUES (?, ?, ?)
      RETURNING id, url, note, created_at, learned, learned_at`
  )
    .bind(url, note, createdAt)
    .first<LinkRow>();

  if (row === null) {
    return json({ error: "not_found" }, 500);
  }

  return json(mapLink(row), 201);
}

async function listLinks(url: URL, env: Env): Promise<Response> {
  const limit = parseBoundedInt(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  if (limit === null) return error("invalid_limit");

  const beforeId = parseOptionalPositiveInt(url.searchParams.get("before_id"));
  if (beforeId === null) return error("invalid_before_id");

  const learned = parseLearnedFilter(url.searchParams.get("learned"));
  if (learned === null) return error("invalid_learned");

  const pageSize = limit + 1;
  const select = "SELECT id, url, note, created_at, learned, learned_at FROM links";
  const order = "ORDER BY id DESC LIMIT ?";
  const learnedValue = learned === undefined ? undefined : learned ? 1 : 0;
  const statement = learnedValue === undefined
    ? beforeId === undefined
      ? env.DB.prepare(`${select} ${order}`).bind(pageSize)
      : env.DB.prepare(`${select} WHERE id < ? ${order}`).bind(beforeId, pageSize)
    : beforeId === undefined
      ? env.DB.prepare(`${select} WHERE learned = ? ${order}`).bind(learnedValue, pageSize)
      : env.DB.prepare(`${select} WHERE learned = ? AND id < ? ${order}`).bind(learnedValue, beforeId, pageSize);

  const result = await statement.all<LinkRow>();
  const rows = result.results ?? [];
  const items = rows.slice(0, limit);
  const next = rows.length > limit ? items[items.length - 1]?.id ?? null : null;
  return json({ items: items.map(mapLink), next_before_id: next });
}

async function getLink(id: number, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT id, url, note, created_at, learned, learned_at FROM links WHERE id = ?"
  )
    .bind(id)
    .first<LinkRow>();

  if (row === null) {
    return error("not_found", 404);
  }
  return json(mapLink(row));
}

async function updateLinkLearned(request: Request, env: Env, id: number): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().split(";")[0].trim() !== "application/json") {
    return error("invalid_content_type");
  }

  const raw = await readJson(request);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return error("invalid_json");
  }

  const body = raw as Record<string, unknown>;
  if (typeof body.learned !== "boolean") {
    return error("invalid_learned");
  }

  const learned = body.learned ? 1 : 0;
  const learnedAt = body.learned ? new Date().toISOString() : null;
  const row = await env.DB.prepare(
    `UPDATE links
      SET learned = ?, learned_at = ?
      WHERE id = ?
      RETURNING id, url, note, created_at, learned, learned_at`
  )
    .bind(learned, learnedAt, id)
    .first<LinkRow>();

  if (row === null) {
    return error("not_found", 404);
  }
  return json(mapLink(row));
}

function routeMethod(
  request: Request,
  allowed: ReadonlyArray<"GET" | "POST" | "PATCH">,
  handler: () => Promise<Response> | Response
): Promise<Response> | Response {
  if (allowed.includes(request.method as "GET" | "POST" | "PATCH")) {
    return handler();
  }
  return json(
    { error: "method_not_allowed" },
    405,
    { Allow: [...allowed, "OPTIONS"].join(", ") }
  );
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
