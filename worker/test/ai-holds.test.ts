import { describe, expect, it } from "vitest";
import { computeHolds, withoutHolds } from "../src/ai-holds";
import type { AutomaticView } from "../src/domain";

const base: AutomaticView = { topics: [], resource_kinds: [], content_functions: [], carriers: ["single"], affordances: ["quote"], form: "method", use: "try", entities: [] };
const prefs = { ai_suggestion_limit: 5, ai_confirm_before_apply: false, ai_low_confidence_review: false };
const accepted = (dimension: string, term: string, probability: number) => ({ dimension, term_id: term, verdict: "accepted" as const, reason: "t", probability });

describe("computeHolds", () => {
  it("holds nothing with the defaults", () => {
    expect(computeHolds({ ...base, topics: ["a", "b", "c", "d", "e"] }, prefs)).toEqual([]);
  });
  it("limits primary tags (topics + resource kinds) by confidence, never content functions", () => {
    const automatic = { ...base, topics: ["a", "b"], resource_kinds: ["r"], content_functions: ["m", "n"],
      assessment: { version: 1, incomplete: [], decisions: [accepted("topics", "a", 0.85), accepted("topics", "b", 0.97), accepted("resource_kinds", "r", 0.9)] } } as AutomaticView;
    expect(computeHolds(automatic, { ...prefs, ai_suggestion_limit: 2 })).toEqual([{ field: "topics", term: "a", reason: "limit", probability: 0.85 }]);
  });
  it("unknown probabilities keep classifier order under the limit", () => {
    expect(computeHolds({ ...base, topics: ["a", "b", "c"] }, { ...prefs, ai_suggestion_limit: 2 }).map((h) => h.term)).toEqual(["c"]);
  });
  it("confirm-before-apply holds every tag-type term but leaves carriers, affordances and form/use", () => {
    const holds = computeHolds({ ...base, topics: ["a"], resource_kinds: ["r"], content_functions: ["m"] }, { ...prefs, ai_confirm_before_apply: true });
    expect(holds.map((h) => `${h.field}:${h.term}:${h.reason}`)).toEqual(["topics:a:confirm", "resource_kinds:r:confirm", "content_functions:m:confirm"]);
  });
  it("low-confidence review holds accepted terms below 0.9 only", () => {
    const automatic = { ...base, topics: ["a", "b", "c"],
      assessment: { version: 1, incomplete: [], decisions: [accepted("topics", "a", 0.81), accepted("topics", "b", 0.93)] } } as AutomaticView;
    expect(computeHolds(automatic, { ...prefs, ai_low_confidence_review: true })).toEqual([{ field: "topics", term: "a", reason: "low_confidence", probability: 0.81 }]);
  });
  it("a limit hold wins over a review reason for the same term", () => {
    const automatic = { ...base, topics: ["a", "b"],
      assessment: { version: 1, incomplete: [], decisions: [accepted("topics", "a", 0.81), accepted("topics", "b", 0.93)] } } as AutomaticView;
    expect(computeHolds(automatic, { ...prefs, ai_suggestion_limit: 1, ai_confirm_before_apply: true }).map((h) => `${h.term}:${h.reason}`)).toEqual(["a:limit", "b:confirm"]);
  });
});

describe("withoutHolds", () => {
  it("removes held terms without mutating the decision", () => {
    const automatic = { ...base, topics: ["a", "b"], content_functions: ["m"] };
    const out = withoutHolds(automatic, [{ field: "topics", term: "a" }, { field: "content_functions", term: "m" }]);
    expect(out.topics).toEqual(["b"]);
    expect(out.content_functions).toEqual([]);
    expect(automatic.topics).toEqual(["a", "b"]);
  });
});
