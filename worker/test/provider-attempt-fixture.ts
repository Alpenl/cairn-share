import { env } from "cloudflare:test";

type Send = (path: string, body: unknown) => Promise<Response>;

// Test-only provider metadata: fixture responses stand in for one known HTTP
// 200. The Worker still enforces lease, revision and single-use permit rules.
export async function settleFixtureAttempt(send: Send, id: number, leaseToken: string,
  stage: "fetch" | "reading"): Promise<void> {
  const admitted = await send(`enrichment/jobs/${id}/lease-admit`, {
    lease_token: leaseToken, stage, min_remaining_ms: 210_000
  });
  if (admitted.status !== 200) throw new Error(`fixture ${stage} admission: HTTP ${admitted.status}`);
  const row = await env.DB.prepare("SELECT content_revision FROM links WHERE id=?")
    .bind(id).first<{ content_revision: number }>();
  if (!row) throw new Error("fixture link is missing");
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const operationKey = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const reserved = await send("enrichment/provider-attempts/reserve", {
    operation_key: operationKey, request_hash: "f".repeat(64), model: "fixture",
    stage, variant: stage === "fetch" ? "fetch_thread" : "reading", attempt_number: 1,
    link_id: id, lease_token: leaseToken, content_revision: row.content_revision,
    min_remaining_ms: 210_000
  });
  if (reserved.status !== 200 || !(await reserved.json() as { granted: boolean }).granted) {
    throw new Error(`fixture ${stage} reservation: HTTP ${reserved.status}`);
  }
  const settled = await send("enrichment/provider-attempts/settle", {
    operation_key: operationKey, http_status: 200, response_id: null,
    input_tokens: null, output_tokens: null, total_tokens: null,
    x_search_calls: null, cost_usd_ticks: null
  });
  if (settled.status !== 200) throw new Error(`fixture ${stage} settlement: HTTP ${settled.status}`);
}
