export type EnrichmentSource = {
  original_text: string;
  model: string;
  original_language: string;
  context_text: string;
  related_links: string[];
  image_urls: string[];
};

function safeURL(value: unknown, image: boolean): boolean {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && (image
      ? url.protocol === "https:" && url.hostname === "pbs.twimg.com" && !url.port && url.pathname.startsWith("/media/")
      : ["http:", "https:"].includes(url.protocol));
  } catch { return false; }
}

export function validEnrichmentSource(value: unknown): value is EnrichmentSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  const keys = ["original_text", "model", "original_language", "context_text", "related_links", "image_urls"];
  if (Object.keys(source).length !== keys.length || Object.keys(source).some((key) => !keys.includes(key))) return false;
  return typeof source.original_text === "string" && source.original_text.trim().length > 0 &&
    source.original_text.length <= 100_000 &&
    typeof source.model === "string" && source.model.trim().length > 0 && source.model.length <= 200 &&
    typeof source.original_language === "string" && source.original_language.length <= 32 &&
    typeof source.context_text === "string" && source.context_text.length <= 100_000 &&
    Array.isArray(source.related_links) && source.related_links.length <= 50 &&
    source.related_links.every((item) => safeURL(item, false)) &&
    Array.isArray(source.image_urls) && source.image_urls.length <= 8 &&
    source.image_urls.every((item) => safeURL(item, true));
}
