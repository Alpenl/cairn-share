import assert from "node:assert/strict";
import test from "node:test";
import { verifyRelease } from "./release-smoke.mjs";

function fixture({ acknowledge = true, functions = true, bodyLeak = false, mismatch = false, legacyLeak = false, stale = false,
  readingNarrow = false, readingMismatch = false, granularity = true, narrowIgnored = false, countMismatch = false,
  catalogMissing = false, legacyGranularityLeak = false } = {}) {
  const requests = [];
  return { requests, fetcher: async (url, options) => {
    requests.push({ url, options });
    const modern = options.headers["X-Cairn-Tag-System"] === "1";
    let body = {};
    if (url.includes("/jobs")) body = { items: [{ id: 1, content_loaded: false,
      classification: { topics: modern && mismatch ? ["ai_coding"] : [], ...(modern ? { resource_kinds: [], content_functions: [] } : {}) },
      ...(modern ? { custom_tags: [], cache_identity: { personal_revision: 3, content_revision: 1, latest_decision_id: 2, body_revision: 0 } } : {}),
      ...(bodyLeak ? { original_text: "synthetic private body" } : {}), ...(legacyLeak && !modern ? { custom_tags: [] } : {}) }] };
    if (url.endsWith("/quality")) body = { version: 1, terms: [] };
    if (url.endsWith("/taxonomy")) body = { topics: [
      { id: "image_creation", label: "图像生成", ...(modern || legacyGranularityLeak ? { granularity: "broad", navigation: true } : {}) },
      { id: "portrait_photography", label: "写真", ...(modern && !catalogMissing ? { granularity: "specific", navigation: false } : {}) },
    ] };
    if (url.includes("topic_refinements=")) body = url.includes("/counts?") ? {
      total: 1, topics: [{ id: "portrait_photography", count: countMismatch ? 0 : 1 }, { id: "image_creation", count: 1 }],
    } : { items: [{ id: 1, classification: { topics: narrowIgnored ? ["image_creation"] : ["portrait_photography", "image_creation"] } }] };
    if (url.endsWith("/1/tags")) body = { revision: stale ? 4 : 3, content_revision: 1, decision_id: 2,
      selection: { topics: [], resource_kinds: [], content_functions: [] }, custom_tags: [] };
    if (url.includes("/1/reading?")) body = { version: 1, body_unchanged: true,
      detail: { id: 1, classification: { topics: [], ...(readingNarrow ? {} : { resource_kinds: readingMismatch ? ["skill"] : [], content_functions: [] }) },
        custom_tags: [], cache_identity: { personal_revision: 3, content_revision: 1, latest_decision_id: 2, body_revision: 0 } },
      selection: { selection: { topics: [], resource_kinds: [], content_functions: [] } } };
    return new Response(JSON.stringify(body), { headers: acknowledge && modern ? { "X-Cairn-Tag-System": "1", "X-Cairn-Search-Summary": "1",
      ...(functions ? { "X-Cairn-Content-Functions": "1" } : {}), ...(granularity ? { "X-Cairn-Topic-Granularity": "1" } : {}) } : {} });
  } };
}

test("release checks only GET and never retain credential or bookmark body", async () => {
  const { fetcher, requests } = fixture();
  const result = await verifyRelease({ token: "test-secret-only", fetcher });
  assert.equal(requests.length, 11);
  assert.ok(requests.every(({ options }) => options.method === "GET" && options.redirect === "error"));
  assert.equal(JSON.stringify(result).includes("test-secret-only"), false);
  assert.equal(JSON.stringify(result).includes("synthetic private body"), false);
  assert.equal(result.model_calls, 0);
});
test("missing capabilities or full bodies fail release verification", async () => {
  await assert.rejects(verifyRelease({ token: "x", ...fixture({ acknowledge: false }) }), /missing_tag_contract/);
  await assert.rejects(verifyRelease({ token: "x", ...fixture({ functions: false }) }), /missing_content_functions_contract/);
  await assert.rejects(verifyRelease({ token: "x", ...fixture({ bodyLeak: true }) }), /summary_contains_body/);
});
test("effective projection mismatch and changed read identities fail closed", async () => {
  await assert.rejects(verifyRelease({ token: "x", ...fixture({ mismatch: true }) }), /effective_projection_mismatch/);
  await assert.rejects(verifyRelease({ token: "x", ...fixture({ stale: true }) }), /readonly_state_changed/);
});
test("unnegotiated legacy shapes reject new strict-client fields", async () => {
  await assert.rejects(verifyRelease({ token: "x", ...fixture({ legacyLeak: true }) }), /legacy_unknown_fields/);
});
test("reading snapshots cannot erase negotiated tags or diverge from effective selections", async () => {
  await assert.rejects(verifyRelease({ token: "x", ...fixture({ readingNarrow: true }) }), /reading_projection_mismatch/);
  await assert.rejects(verifyRelease({ token: "x", ...fixture({ readingMismatch: true }) }), /reading_projection_mismatch/);
});
test("granularity release requires capability, concrete definitions and legacy-safe catalogs", async () => {
  await assert.rejects(verifyRelease({ token: "x", ...fixture({ granularity: false }) }), /missing_topic_granularity_contract/);
  await assert.rejects(verifyRelease({ token: "x", ...fixture({ catalogMissing: true }) }), /invalid_topic_granularity_catalog/);
  await assert.rejects(verifyRelease({ token: "x", ...fixture({ legacyGranularityLeak: true }) }), /legacy_granularity_fields/);
});
test("granularity release rejects dropped refinement and inconsistent facet counts", async () => {
  await assert.rejects(verifyRelease({ token: "x", ...fixture({ narrowIgnored: true }) }), /topic_refinement_ignored/);
  await assert.rejects(verifyRelease({ token: "x", ...fixture({ countMismatch: true }) }), /topic_refinement_counts_mismatch/);
});
