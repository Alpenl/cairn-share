import type { Env } from "./index";
import { readBody } from "./provider-attempts";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const validScope = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
type Check = { scope: string; lease_token: string | null; lease_until: number; valid_until: number;
  next_check_at: number; last_started_at: number; last_success_at: number; failures: number;
  reason: string; manual_after: number; manual_requests: number };
function view(row: Check | null, now: number) {
  const running = !!row && row.lease_until > now;
  return { state: running ? "checking" : (row?.valid_until ?? 0) > now ? "healthy" :
    (row?.next_check_at ?? 0) > now ? "waiting" : "pending",
    next_check_at: running ? row!.lease_until : row?.next_check_at ?? 0,
    last_success_at: row?.last_success_at ?? 0, valid_until: row?.valid_until ?? 0,
    reason: row?.reason ?? "", failures: row?.failures ?? 0,
    manual_after: row?.manual_after ?? 0, can_recover: !running && (row?.manual_after ?? 0) <= now };
}
export async function providerCheckRoute(request: Request, env: Env, path: string): Promise<Response> {
  const action = path.slice("/api/enrichment/provider-checks/".length);
  const now = Date.now();
  const body = request.method === "GET" && action === "status"
    ? { scope: new URL(request.url).searchParams.get("scope") } : await readBody(request);
  if (body instanceof Response) return body;
  if (!validScope(body.scope)) return json({ error: "invalid_scope" }, 400);
  const scope = body.scope;
  const read = () => env.DB.prepare("SELECT * FROM provider_checks WHERE scope=?").bind(scope).first<Check>();
  if (action === "status" && request.method === "GET") return json(view(await read(), now));
  if (request.method !== "POST" || !["claim", "finish", "recover"].includes(action)) return json({ error: "not_found" }, 404);
  await env.DB.prepare("INSERT OR IGNORE INTO provider_checks(scope) VALUES (?)").bind(scope).run();
  if (action === "claim") {
    const token = crypto.randomUUID();
    // One owner across processes. A lost response cannot replay permission.
    const row = await env.DB.prepare(`UPDATE provider_checks SET lease_token=?,lease_until=?,
      last_started_at=?,manual_after=MAX(manual_after,?),next_check_at=?
      WHERE scope=? AND lease_until<=? AND valid_until<=? AND next_check_at<=? RETURNING *`)
      .bind(token, now + 900_000, now, now + 60_000, now + 900_000, scope, now, now, now).first<Check>();
    return json({ ...view(row ?? await read(), now), granted: !!row, ...(row ? { lease_token: token } : {}) });
  }
  if (action === "recover") {
    // A request advances the next probe, never marks the provider healthy.
    const row = await env.DB.prepare(`UPDATE provider_checks SET next_check_at=?,valid_until=0,
      manual_after=?,manual_requests=manual_requests+1 WHERE scope=? AND lease_until<=? AND manual_after<=? RETURNING *`)
      .bind(now, now + 60_000, scope, now, now).first<Check>();
    return json({ ...view(row ?? await read(), now), accepted: !!row });
  }
  const reasons = ["unavailable", "timeout", "unauthorized", "rate_limited", "budget_exhausted", "invalid_response"];
  if (typeof body.lease_token !== "string" || typeof body.success !== "boolean" ||
      !body.success && !reasons.includes(String(body.reason))) return json({ error: "invalid_result" }, 400);
  const old = await read();
  if (!old || old.lease_token !== body.lease_token || old.lease_until <= now) return json({ error: "stale_check" }, 409);
  const delay = Math.min(3_600_000, 300_000 * 2 ** Math.min(old.failures, 4));
  // Global paid-call exhaustion still respects the existing UTC budget window.
  const next = body.reason === "budget_exhausted" ? Date.parse(new Date(now).toISOString().slice(0,10)) + 86_400_000 : now + delay;
  const result = await env.DB.prepare(`UPDATE provider_checks SET lease_token=NULL,lease_until=0,
    valid_until=?,next_check_at=?,last_success_at=?,failures=?,reason=?
    WHERE scope=? AND lease_token=? AND lease_until>? RETURNING scope`)
    .bind(body.success ? now + 86_400_000 : 0, body.success ? 0 : next,
      body.success ? now : old.last_success_at, body.success ? 0 : old.failures + 1,
      body.success ? "" : body.reason, scope, body.lease_token, now).first();
  if (result && body.success) {
    // Permit the next normal single-job probe; do not close gates, steal an
    // active probe, clear faults, or release uncertain paid calls.
    const at = new Date(now).toISOString();
    await env.DB.prepare(`UPDATE enrichment_component_gates SET retry_at=?,updated_at=?
      WHERE component IN ('source','reading') AND state='open' AND retry_at>?`)
      .bind(at,at,at).run();
  }
  return result ? json(view(await read(), now)) : json({ error: "stale_check" }, 409);
}
