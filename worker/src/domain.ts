// B03 domain contracts: replayable evidence, runs, decisions and human
// overrides. Everything here is shared by the Worker route handlers and the
// cross-language golden vectors, so the canonicalisation rules live in one
// place and Go can be checked against the same bytes.
import { record, taxonomy, validTerm } from "./curation";

export const CONTENT_HASH_ALGORITHM = "sha256";
export const MAX_BLOCK_TEXT = 100_000;
export const MAX_BLOCKS = 64;
export const MAX_SPEC_BYTES = 64 * 1024;

export type BlockRole =
  | "primary"
  | "author_continuation"
  | "quoted"
  | "external_article"
  | "third_party"
  | "legacy_unknown";

export const BLOCK_ROLES: BlockRole[] = [
  "primary", "author_continuation", "quoted", "external_article", "third_party", "legacy_unknown"
];

export interface EvidenceBlock {
  id: string;
  role: BlockRole;
  text: string;
  url?: string;
  /** Why this block has the role it has; never inferred silently. */
  relation?: string;
  acquired?: string;
}

export interface EvidenceSnapshot {
  blocks: EvidenceBlock[];
  fetched_at: string;
  retrieval: string;
  truncation: { truncated: boolean; reason?: string };
}

export type Completeness = "complete" | "partial" | "truncated" | "empty";

export function validBlock(value: unknown): value is EvidenceBlock {
  if (!record(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 64) return false;
  if (!BLOCK_ROLES.includes(value.role as BlockRole)) return false;
  if (typeof value.text !== "string" || value.text.length === 0 || value.text.length > MAX_BLOCK_TEXT) return false;
  if (value.url !== undefined && (typeof value.url !== "string" || value.url.length > 8192)) return false;
  if (value.relation !== undefined && (typeof value.relation !== "string" || value.relation.length > 500)) return false;
  if (value.acquired !== undefined && (typeof value.acquired !== "string" || value.acquired.length > 64)) return false;
  return true;
}

export function validSnapshot(value: unknown): value is EvidenceSnapshot {
  if (!record(value) || !Array.isArray(value.blocks) || value.blocks.length > MAX_BLOCKS) return false;
  if (!value.blocks.every(validBlock)) return false;
  if (new Set(value.blocks.map((block) => (block as EvidenceBlock).id)).size !== value.blocks.length) return false;
  if (typeof value.fetched_at !== "string" || typeof value.retrieval !== "string") return false;
  if (!record(value.truncation) || typeof value.truncation.truncated !== "boolean") return false;
  return true;
}

// Canonical JSON: object keys are sorted, so two structurally equal documents
// hash identically regardless of key order in the wire payload. Arrays keep
// their order because block order is semantic.
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return "{" + entries.map(([key, entry]) => JSON.stringify(key) + ":" + canonicalJSON(entry)).join(",") + "}";
}

export async function contentHash(snapshot: EvidenceSnapshot): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(snapshot)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Completeness is derived from the snapshot so a caller cannot claim "complete"
// for a truncated or empty retrieval.
export function snapshotCompleteness(snapshot: EvidenceSnapshot): Completeness {
  if (snapshot.blocks.length === 0) return "empty";
  if (snapshot.truncation.truncated) return "truncated";
  return "complete";
}

// Personal state never enters the content hash: a note edit is not new evidence.
export function objectivePayload(snapshot: EvidenceSnapshot): string {
  return canonicalJSON({
    blocks: snapshot.blocks.map((block) => ({
      id: block.id, role: block.role, text: block.text, url: block.url ?? "",
      relation: block.relation ?? "", acquired: block.acquired ?? ""
    })),
    fetched_at: snapshot.fetched_at,
    retrieval: snapshot.retrieval,
    truncation: { truncated: snapshot.truncation.truncated, reason: snapshot.truncation.reason ?? "" }
  });
}

export interface QuestionSpec {
  spec_id: string;
  spec_version: number;
  questions: unknown;
  display_only?: boolean;
}

export function validQuestionSpec(value: unknown): value is QuestionSpec {
  if (!record(value)) return false;
  if (typeof value.spec_id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.spec_id)) return false;
  if (!Number.isSafeInteger(value.spec_version) || (value.spec_version as number) < 1) return false;
  if (!record(value.questions) && !Array.isArray(value.questions)) return false;
  if (value.display_only !== undefined && typeof value.display_only !== "boolean") return false;
  return canonicalJSON(value).length <= MAX_SPEC_BYTES;
}

export type OverrideField = "topic" | "form" | "use" | "entity";
export type OverrideAction = "accept" | "reject" | "set_empty" | "reset";

export const OVERRIDE_FIELDS: OverrideField[] = ["topic", "form", "use", "entity"];
export const TERM_FIELDS: OverrideField[] = ["topic", "form", "use"];
export const OVERRIDE_ACTIONS: OverrideAction[] = ["accept", "reject", "set_empty", "reset"];

// A field cannot be set empty or reset a specific term at the same time; the
// distinction matters because `set []` is an explicit empty and `reset` returns
// to the automatic suggestion.
export function validOverride(field: OverrideField, action: OverrideAction, term: string): boolean {
  if (!OVERRIDE_FIELDS.includes(field) || !OVERRIDE_ACTIONS.includes(action)) return false;
  if (action === "set_empty") return term === "";
  if (action === "reset") return term === "" || TERM_FIELDS.includes(field);
  if (action === "accept" || action === "reject") {
    if (term === "") return false;
    if (field === "topic") return validTerm("topics", term, false);
    if (field === "form") return validTerm("forms", term, false);
    if (field === "use") return validTerm("uses", term, false);
    return term.length > 0 && term.length <= 80;
  }
  return false;
}

export interface Override {
  field: OverrideField;
  term: string;
  action: OverrideAction;
  source: "human" | "legacy_unknown";
  confirmed: boolean;
  revision: number;
}

// Resolve the effective tags for a field from automatic suggestions and
// overrides. `reset` removes overrides of that field from scope; `reject`
// survives a policy replay because it is applied after the automatic value.
export function resolveField(automatic: string[], overrides: Override[]): { value: string[]; empty: boolean } {
  let value = [...automatic];
  let empty = false;
  for (const override of overrides) {
    switch (override.action) {
      case "accept":
        if (!value.includes(override.term)) value.push(override.term);
        empty = false;
        break;
      case "reject":
        value = value.filter((term) => term !== override.term);
        break;
      case "set_empty":
        value = [];
        empty = true;
        break;
      case "reset":
        if (override.term === "") {
          value = [...automatic];
          empty = false;
        }
        break;
    }
  }
  return { value, empty };
}

export interface EffectiveView {
  topics: string[];
  form: string;
  use: string;
  entities: string[];
  empty: { topics: boolean; form: boolean; use: boolean };
  reviewed: boolean;
}

// Build the effective view. Human overrides win over automatic suggestions, and
// legacy override groups are marked reviewed because their confirmation
// behaviour is unknown rather than because they were confirmed.
export function effectiveView(automatic: { topics: string[]; form: string; use: string; entities: string[] }, overrides: Override[]): EffectiveView {
  const byField = (field: OverrideField) => overrides.filter((override) => override.field === field);
  const topics = resolveField(automatic.topics, byField("topic"));
  const form = resolveField(automatic.form ? [automatic.form] : [], byField("form"));
  const use = resolveField(automatic.use ? [automatic.use] : [], byField("use"));
  return {
    topics: topics.value,
    form: form.value[0] ?? "",
    use: use.value[0] ?? "",
    entities: resolveField(automatic.entities, byField("entity")).value,
    empty: { topics: topics.empty, form: form.empty, use: use.empty },
    reviewed: overrides.length > 0
  };
}

export function taxonomyVersion(): string { return taxonomy.version; }
