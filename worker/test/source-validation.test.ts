import { expect, it } from "vitest";
import { validEnrichmentSource } from "../src/source-validation";

it("uses the same 100 KB source boundary as the Go reading client for multibyte text", () => {
  const source = (original_text: string) => ({
    original_text, original_language: "zh", context_text: "", related_links: [],
    image_urls: [], model: "fixture"
  });
  const atLimit = "中".repeat(33_333) + "x";
  expect(new TextEncoder().encode(atLimit).byteLength).toBe(100_000);
  expect(validEnrichmentSource(source(atLimit))).toBe(true);
  expect(validEnrichmentSource(source(atLimit + "中"))).toBe(false);
  expect(validEnrichmentSource({ ...source("safe"), context_text: atLimit + "中" })).toBe(false);
});
