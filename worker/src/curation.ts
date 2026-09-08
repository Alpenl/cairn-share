import taxonomy from "./taxonomy.json";

export { taxonomy };

export interface Selection {
  topics: string[];
  form: string;
  use: string;
}

export interface Classification extends Selection {
  why_suggestion: string;
  entities: string[];
  uncertainty: boolean;
  taxonomy_version: string;
  discarded_tags: string[];
}

export function validCurationStatus(value: unknown): value is string {
  return typeof value === "string" && ["inbox", "kept", "compiled", "drop"].includes(value);
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every(
    (entry) => typeof entry === "string" && entry.trim().length > 0 && Array.from(entry).length <= maxLength
  ) && new Set(value).size === value.length;
}

export function validTerm(dimension: "topics" | "forms" | "uses", value: string, activeOnly = true): boolean {
  return taxonomy[dimension].some((term) => term.id === value && (!activeOnly || term.active));
}

export function validateSelection(value: unknown, stored = false): Selection | null {
  if (!record(value) || !stringArray(value.topics, 3, 40) || typeof value.form !== "string" || typeof value.use !== "string") return null;
  const valid = (dimension: "topics" | "forms" | "uses", id: string) =>
    stored ? /^[a-z][a-z0-9_]{0,39}$/.test(id) : validTerm(dimension, id);
  if (value.topics.some((id) => !valid("topics", id)) ||
    (value.form !== "" && !valid("forms", value.form)) ||
    (value.use !== "" && !valid("uses", value.use))) return null;
  return { topics: value.topics, form: value.form, use: value.use };
}

export function validateClassification(value: unknown, stored = false): Classification | null {
  const selection = validateSelection(value, stored);
  if (selection === null || !record(value) || typeof value.why_suggestion !== "string" ||
    Array.from(value.why_suggestion).length > 200 || !stringArray(value.entities, 10, 80) ||
    typeof value.uncertainty !== "boolean" || typeof value.taxonomy_version !== "string" ||
    value.taxonomy_version.length > 64 || (!stored && value.taxonomy_version !== taxonomy.version) ||
    !stringArray(value.discarded_tags, 10, 80)) return null;
  return {
    ...selection,
    why_suggestion: value.why_suggestion.trim(), entities: value.entities,
    uncertainty: value.uncertainty || selection.topics.length === 0 || selection.form === "" || selection.use === "" || value.discarded_tags.length > 0,
    taxonomy_version: value.taxonomy_version, discarded_tags: value.discarded_tags
  };
}

export function storedClassification(raw: string | null, manual: string | null): Classification | null {
  let generated: Classification | null = null;
  try { generated = validateClassification(JSON.parse(raw ?? "null"), true); } catch { /* Invalid legacy data remains unclassified. */ }
  let selection: Selection | null = null;
  try { selection = validateSelection(JSON.parse(manual ?? "null"), true); } catch { /* Preserve the usable generated result. */ }
  if (selection === null) return generated;
  return {
    why_suggestion: "", entities: [], taxonomy_version: taxonomy.version, discarded_tags: [],
    ...generated, ...selection, uncertainty: false
  };
}

export function bookmarkSource(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "x.com" || host === "twitter.com") return "x";
    if (host === "mp.weixin.qq.com") return "wechat";
  } catch { /* Older rows may contain invalid URLs. */ }
  return "other";
}
