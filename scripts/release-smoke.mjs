import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function verifyRelease({ token, fetcher = fetch, base = "https://share.alpenl.com" }) {
  if (!token) throw new Error("missing_readonly_verification_token");
  const checks = [];
  const get = async (path, capabilities = true) => {
    const headers = { Authorization: `Bearer ${token}` };
    if (capabilities) Object.assign(headers, { "X-Cairn-Tag-System": "1", "X-Cairn-Content-Functions": "1", "X-Cairn-Search-Summary": "1" });
    const start = performance.now();
    const response = await fetcher(base + path, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`readonly_check_http_${response.status}`);
    const body = await response.json();
    if (capabilities && response.headers.get("X-Cairn-Tag-System") !== "1") throw new Error("missing_tag_contract");
    if (capabilities && response.headers.get("X-Cairn-Content-Functions") !== "1") throw new Error("missing_content_functions_contract");
    checks.push({ route: path.split("?")[0].replace(/\/\d+(?=\/|$)/g, "/:id"), status: response.status,
      ms: Math.round(performance.now() - start), server_timing: response.headers.get("Server-Timing") || "" });
    return { body, response };
  };
  const { body: page } = await get("/api/enrichment/jobs?view=summary&limit=2&include_cache_identity=1");
  if (!Array.isArray(page.items) || page.items.length > 2) throw new Error("invalid_summary_contract");
  for (const item of page.items) {
    if (item.content_loaded !== false || item.original_text || item.translated_text) throw new Error("summary_contains_body");
    if (item.classification !== null && !["topics", "resource_kinds", "content_functions"].every(key => Array.isArray(item.classification?.[key]))) throw new Error("invalid_modern_classification");
    if (!Array.isArray(item.custom_tags)) throw new Error("missing_custom_tag_contract");
  }
  const search = await get("/api/enrichment/jobs?view=summary&limit=2&q=Claude");
  if (search.response.headers.get("X-Cairn-Search-Summary") !== "1" || !Array.isArray(search.body.items)) throw new Error("missing_search_contract");
  for (const item of search.body.items) {
    if (item.original_text || item.translated_text || [...(item.search_excerpt || "")].length > 240) throw new Error("unbounded_search_summary");
  }
  await get("/api/v2/tags/counts");
  const { body: quality } = await get("/api/v2/tags/quality");
  if (quality.version !== 1 || !Array.isArray(quality.terms)) throw new Error("invalid_quality_contract");
  if (page.items.length) {
    const id = page.items[0].id;
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("invalid_bookmark_id");
    const { body: tags } = await get(`/api/v2/links/${id}/tags`);
    if (!["topics", "resource_kinds", "content_functions"].every((key) => Array.isArray(tags.selection?.[key]))) throw new Error("invalid_effective_tags");
    const item = page.items[0], identity = item.cache_identity;
    if (!identity || identity.personal_revision !== tags.revision || identity.content_revision !== tags.content_revision || identity.latest_decision_id !== tags.decision_id)
      throw new Error("readonly_state_changed");
    const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    for (const field of ["topics", "resource_kinds", "content_functions"]) {
      if (!same(item.classification?.[field] ?? [], tags.selection[field])) throw new Error("effective_projection_mismatch");
    }
    if (!Array.isArray(tags.custom_tags) || !same(item.custom_tags.map(t => t.id), tags.custom_tags.map(t => t.id))) throw new Error("custom_projection_mismatch");
  }
  const { body: legacy } = await get("/api/enrichment/jobs?view=summary&limit=2", false);
  if (!Array.isArray(legacy.items)) throw new Error("invalid_legacy_contract");
  for (const item of legacy.items) {
    if (Object.hasOwn(item, "custom_tags") || Object.hasOwn(item, "search_excerpt") ||
      item.classification && ["resource_kinds", "content_functions"].some(key => Object.hasOwn(item.classification, key))) throw new Error("legacy_unknown_fields");
  }
  return { version: 1, at: new Date().toISOString(), model_calls: 0, mutations: 0, checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyRelease({ token: process.env.CAIRN_RELEASE_TOKEN });
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    console.log(`Read-only release checks passed: ${result.checks.length}; model calls: 0; mutations: 0`);
  } catch (error) {
    console.error(`Release verification failed: ${String(error.message).replace(/[^a-zA-Z0-9_ :.-]/g, "").slice(0, 100)}`);
    process.exitCode = 1;
  }
}
