import assert from "node:assert/strict";
import test from "node:test";
import { verifyRelease } from "./release-smoke.mjs";

function fixture({ acknowledge = true, functions = true, bodyLeak = false, mismatch = false, legacyLeak = false, stale = false,
  readingNarrow = false, readingMismatch = false } = {}) {
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
    if (url.endsWith("/1/tags")) body = { revision: stale ? 4 : 3, content_revision: 1, decision_id: 2,
      selection: { topics: [], resource_kinds: [], content_functions: [] }, custom_tags: [] };
    if (url.includes("/1/reading?")) body = { version: 1, body_unchanged: true,
      detail: { id: 1, classification: { topics: [], ...(readingNarrow ? {} : { resource_kinds: readingMismatch ? ["skill"] : [], content_functions: [] }) },
        custom_tags: [], cache_identity: { personal_revision: 3, content_revision: 1, latest_decision_id: 2, body_revision: 0 } },
      selection: { selection: { topics: [], resource_kinds: [], content_functions: [] } } };
    return new Response(JSON.stringify(body), { headers: acknowledge && modern ? { "X-Cairn-Tag-System": "1", "X-Cairn-Search-Summary": "1",
      ...(functions ? { "X-Cairn-Content-Functions": "1" } : {}) } : {} });
  } };
}

test("release checks only GET and never retain credential or bookmark body", async () => {
  const { fetcher, requests } = fixture();
  const result = await verifyRelease({ token: "test-secret-only", fetcher });
  assert.equal(requests.length, 7);
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
