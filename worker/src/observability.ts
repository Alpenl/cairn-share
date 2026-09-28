type LogMode = "off" | "basic" | "diagnostic";

interface Policy {
  version: number;
  logs: LogMode;
  fallback_logs: "off" | "basic" | null;
  diagnostic_until: number | null;
}

const OFF: Policy = { version: -1, logs: "off", fallback_logs: null, diagnostic_until: null };
const CACHE_MS = 30_000;
const FAILURE_RETRY_MS = 5_000;
const MAX_BODY_BYTES = 1024;
const CLOCK_SKEW_MS = 5 * 60_000;

// An isolate reads once on first use. Expired reads share one promise and a
// failed read is cached briefly as off, so a D1 outage cannot fan out reads.
let cache: { policy: Policy; until: number } | undefined;
let loading: Promise<Policy> | undefined;
let generation = 0;
let logWindow = { minute: -1, emitted: 0, dropped: 0 };

function effective(policy: Policy): LogMode {
  if (policy.logs === "diagnostic" && Date.now() >= (policy.diagnostic_until ?? 0)) {
    return policy.fallback_logs ?? "off";
  }
  return policy.logs;
}

async function load(db: D1Database): Promise<Policy> {
  const row = await db.prepare(
    "SELECT version, logs, fallback_logs, diagnostic_until FROM observability_policy WHERE singleton = 1"
  ).first<Policy>();
  if (!row || !Number.isSafeInteger(row.version) || !validPolicy(row)) throw new Error("invalid observability policy");
  return row;
}

export async function requestPolicy(db: D1Database): Promise<Policy> {
  if (cache && Date.now() < cache.until) return cache.policy;
  if (!loading) {
    const startedAtGeneration = generation;
    loading = load(db).then((policy) => {
      if (generation === startedAtGeneration) cache = { policy, until: Date.now() + CACHE_MS };
      return cache?.policy ?? policy;
    }).catch(() => {
      if (generation === startedAtGeneration) cache = { policy: OFF, until: Date.now() + FAILURE_RETRY_MS };
      return cache?.policy ?? OFF;
    }).finally(() => { loading = undefined; });
  }
  return loading;
}

export function policyReadAvailable(policy: Policy): boolean { return policy !== OFF; }

function validPolicy(value: Policy): boolean {
  if (!Number.isSafeInteger(value.version) || value.version < -1) return false;
  if (value.logs === "off" || value.logs === "basic") {
    return value.fallback_logs === null && value.diagnostic_until === null;
  }
  return value.logs === "diagnostic" &&
    (value.fallback_logs === "off" || value.fallback_logs === "basic") &&
    Number.isSafeInteger(value.diagnostic_until) && (value.diagnostic_until ?? 0) > 0;
}

async function limitedJSON(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("body too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(body));
}

function parsePublished(value: unknown): Policy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = Object.keys(value);
  if (fields.some((key) => !["version", "logs", "fallback_logs", "diagnostic_until"].includes(key))) return null;
  const object = value as Record<string, unknown>;
  if (!Object.hasOwn(object, "version") || !Object.hasOwn(object, "logs")) return null;
  const policy: Policy = {
    version: object.version as number,
    logs: object.logs as LogMode,
    fallback_logs: (object.fallback_logs ?? null) as Policy["fallback_logs"],
    diagnostic_until: (object.diagnostic_until ?? null) as number | null
  };
  // Go limits diagnostics to one hour at creation. Allow bounded clock skew
  // between Go and Cloudflare; an already expired publication stays expired.
  return policy.version >= 0 && validPolicy(policy) &&
    (policy.logs !== "diagnostic" || (policy.diagnostic_until ?? 0) <= Date.now() + 3_600_000 + CLOCK_SKEW_MS)
    ? policy : null;
}

function reply(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" }
  });
}

export async function publishPolicy(request: Request, db: D1Database): Promise<Response> {
  let proposed: Policy | null;
  try { proposed = parsePublished(await limitedJSON(request)); } catch { proposed = null; }
  if (!proposed) return reply({ error: "invalid_observability_policy" }, 400);
  try {
    const result = await db.prepare(`UPDATE observability_policy
      SET version = ?, logs = ?, fallback_logs = ?, diagnostic_until = ?
      WHERE singleton = 1 AND version < ?`)
      .bind(proposed.version, proposed.logs, proposed.fallback_logs, proposed.diagnostic_until, proposed.version)
      .run();
    if (result.meta.changes === 1) {
      generation++;
      cache = { policy: proposed, until: Date.now() + CACHE_MS };
      return reply({ version: proposed.version, effective_logs: effective(proposed) }, 200);
    }
    const current = await load(db);
    if (current.version === proposed.version && current.logs === proposed.logs &&
      current.fallback_logs === proposed.fallback_logs && current.diagnostic_until === proposed.diagnostic_until) {
      generation++;
      cache = { policy: current, until: Date.now() + CACHE_MS };
      return reply({ version: current.version, effective_logs: effective(current) }, 200);
    }
    return reply({ error: "observability_version_conflict", version: current.version }, 409);
  } catch {
    return reply({ error: "observability_unavailable" }, 503);
  }
}

function routeTemplate(path: string): string {
  if (path === "/api/links" || path === "/api/enrichment/jobs" || path === "/health") return path;
  if (path === "/api/enrichment/provider-attempts") return path;
  if (["reserve", "settle", "authorize-fallback", "summary"].some((action) =>
    path === `/api/enrichment/provider-attempts/${action}`)) return path;
  if (/^\/api\/links\/\d+$/.test(path)) return "/api/links/:id";
  if (/^\/api\/links\/\d+\/curation$/.test(path)) return "/api/links/:id/curation";
  if (/^\/api\/enrichment\/jobs\/\d+\/[a-z-]+$/.test(path)) return "/api/enrichment/jobs/:id/:action";
  if (/^\/api\/enrichment\/jobs\/\d+$/.test(path)) return "/api/enrichment/jobs/:id";
  if (/^\/api\/v2\/links\/\d+\/[a-z-]+$/.test(path)) return "/api/v2/links/:id/:action";
  if (/^\/api\/bookmarks\/\d+\/[a-z-]+$/.test(path)) return "/api/bookmarks/:id/:action";
  return "other";
}

export function emitRequest(policy: Policy, request: Request, response: Response | null, durationMS: number): void {
  const mode = effective(policy);
  if (mode === "off" || (mode === "basic" && response !== null && response.status < 400 && request.method === "GET")) return;
  const path = new URL(request.url).pathname;
  if (path === "/api/internal/observability") return;
  const minute = Math.floor(Date.now() / 60_000);
  if (minute !== logWindow.minute) {
    if (logWindow.dropped > 0) {
      console.log(JSON.stringify({ schema: 1, kind: "worker_log_drops", count: logWindow.dropped }));
    }
    logWindow = { minute, emitted: 0, dropped: 0 };
  }
  const limit = mode === "diagnostic" ? 600 : 120;
  if (logWindow.emitted >= limit) {
    logWindow.dropped++;
    return;
  }
  logWindow.emitted++;
  const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(request.method) ? request.method : "OTHER";
  const contentLength = response?.headers.get("content-length");
  const responseBytes = contentLength && /^\d{1,12}$/.test(contentLength) ? Number(contentLength) : null;
  // Platform logs cannot promise deletion by bookmark. Never include raw URL,
  // IDs, request/response bodies, SQL text, tokens or trace identifiers here.
  console.log(JSON.stringify({ schema: 1, kind: "worker_request", config_version: policy.version,
    route: routeTemplate(path), method, status: response?.status ?? null,
    error_type: response === null ? "unhandled" : response.status >= 400 ? `http_${response.status}` : null,
    duration_ms: Math.round(durationMS), response_bytes: responseBytes, d1_stats: "unavailable" }));
}

export function resetObservabilityCacheForTest(): void {
  generation++;
  cache = undefined;
  loading = undefined;
  logWindow = { minute: -1, emitted: 0, dropped: 0 };
}
