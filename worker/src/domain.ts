// B03 domain contracts: replayable evidence, runs, decisions and human
// overrides. Everything here is shared by the Worker route handlers and the
// cross-language golden vectors, so the canonicalisation rules live in one
// place and Go can be checked against the same bytes.
import { personalUse, record, taxonomy } from "./curation";
import { validV2Term } from "./taxonomy-v2";

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

// The content hash covers the objective evidence only. `fetched_at` is
// deliberately excluded: a re-fetch that returns identical bytes must not
// create a new content revision, otherwise every refresh loop manufactures a
// new version and re-queues classification forever (R2-07).
export async function contentHash(snapshot: EvidenceSnapshot): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(objectivePayload(snapshot)));
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
    retrieval: snapshot.retrieval,
    truncation: { truncated: snapshot.truncation.truncated, reason: snapshot.truncation.reason ?? "" }
  });
}

export interface QuestionSpec {
  spec_id: string;
  spec_version: number;
  questions: unknown;
  score_enabled?: boolean;
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

export type OverrideField =
  | "topics" | "content_functions" | "carriers" | "affordances"
  | "form" | "use" | "entities";
export type OverrideAction = "accept" | "reject" | "set_empty" | "reset";

// The v2 dimension vocabulary. The legacy singular names are still accepted
// from old clients and normalized before they are stored, so one effective
// view exists regardless of which client wrote last (F04).
export const OVERRIDE_FIELDS: OverrideField[] = [
  "topics", "content_functions", "carriers", "affordances", "form", "use", "entities"
];
export const TERM_FIELDS: OverrideField[] = [
  "topics", "content_functions", "carriers", "affordances", "form", "use", "entities"
];
export const OVERRIDE_ACTIONS: OverrideAction[] = ["accept", "reject", "set_empty", "reset"];

const FIELD_ALIASES: Record<string, OverrideField> = {
  topic: "topics", content_function: "content_functions", carrier: "carriers",
  affordance: "affordances", entity: "entities",
  topics: "topics", content_functions: "content_functions", carriers: "carriers",
  affordances: "affordances", form: "form", use: "use", entities: "entities"
};

export function normalizeField(value: unknown): OverrideField | null {
  if (typeof value !== "string") return null;
  return FIELD_ALIASES[value] ?? null;
}

// A field cannot be set empty or reset a specific term at the same time; the
// distinction matters because `set []` is an explicit empty and `reset` returns
// to the automatic suggestion.
export function validOverride(field: OverrideField, action: OverrideAction, term: string): boolean {
  if (!OVERRIDE_FIELDS.includes(field) || !OVERRIDE_ACTIONS.includes(action)) return false;
  if (action === "set_empty") return term === "";
  if (action === "reset") return term === "" || TERM_FIELDS.includes(field);
  if (action === "accept" || action === "reject") {
    if (term === "") return false;
    if (field === "topics") return validV2Term("topics", term);
    if (field === "content_functions") return validV2Term("content_functions", term);
    if (field === "carriers") return validV2Term("carriers", term);
    if (field === "affordances") return validV2Term("affordances", term);
    if (field === "form") return validV2Term("forms", term);
    if (field === "use") return validV2Term("uses", term);
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

// fieldState is the deterministic per-tag override state shared with the Go
// resolver. Both sides are checked against the same golden vectors so a human
// decision can never mean one thing in the UI and another in replay (F11).
interface FieldState {
  action: Map<string, OverrideAction>;
  order: string[];
  // Single-valued fields replay actual actions: collapsing to the latest action
  // per term loses A -> B -> A and can revive A after rejecting the chosen B.
  history: Array<Pick<Override, "term" | "action">>;
  empty: boolean;
  /** set_empty suppresses automatic values until a per-tag reset re-admits one. */
  clearedAutomatic: boolean;
  readmit: Set<string>;
  origins: Map<string, Override>;
  emptyOverride?: Override;
}

function newFieldState(): FieldState {
  return { action: new Map(), order: [], history: [], empty: false, clearedAutomatic: false, readmit: new Set(), origins: new Map() };
}

function applyOverride(state: FieldState, override: Override): void {
  if (override.action === "accept" || override.action === "reject") state.origins.set(override.term, override);
  if (override.action === "set_empty" || (override.action === "reset" && override.term === "")) {
    state.origins.clear();
    state.emptyOverride = override.action === "set_empty" ? override : undefined;
  } else if (override.action === "reset") state.origins.delete(override.term);
  switch (override.action) {
    case "accept":
      state.history.push({ term: override.term, action: override.action });
      if (!state.action.has(override.term)) state.order.push(override.term);
      state.action.set(override.term, "accept");
      state.empty = false;
      break;
    case "reject":
      state.history.push({ term: override.term, action: override.action });
      if (!state.action.has(override.term)) state.order.push(override.term);
      state.action.set(override.term, "reject");
      state.empty = false;
      break;
    case "set_empty":
      state.action = new Map();
      state.order = [];
      state.history = [];
      state.empty = true;
      state.clearedAutomatic = true;
      state.readmit = new Set();
      break;
    case "reset":
      if (override.term === "") {
        state.action = new Map();
        state.order = [];
        state.history = [];
        state.empty = false;
        state.clearedAutomatic = false;
        state.readmit = new Set();
      } else {
        // A per-tag reset removes exactly that tag's override so the tag falls
        // back to the automatic value.
        state.action.delete(override.term);
        state.order = state.order.filter((term) => term !== override.term);
        state.history = state.history.filter((entry) => entry.term !== override.term);
        if (state.clearedAutomatic) {
          state.empty = false;
          state.readmit.add(override.term);
        }
      }
      break;
  }
}

// resolveMulti resolves a multi-valued field: accepts accumulate, rejects are
// removed and reset restores the automatic value.
export function resolveMulti(automatic: string[], state: FieldState): string[] {
  if (state.empty) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (term: string) => {
    if (term === "" || seen.has(term)) return;
    seen.add(term);
    out.push(term);
  };
  for (const term of automatic) {
    if (state.action.get(term) === "reject") continue;
    if (state.clearedAutomatic && !state.readmit.has(term)) continue;
    add(term);
  }
  for (const term of state.order) {
    if (state.action.get(term) === "accept") add(term);
  }
  return out;
}

// resolveSingle resolves a single-valued field. An accept replaces both the
// automatic value and a previous accept; a reject of the active value clears
// it; a reset restores the automatic value (F11).
export function resolveSingle(automatic: string, state: FieldState): string {
  if (state.empty) return "";
  let current = state.clearedAutomatic && !state.readmit.has(automatic) ? "" : automatic;
  for (const { term, action } of state.history) {
    if (action === "accept") current = term;
    else if (action === "reject" && current === term) current = "";
  }
  if (automatic !== "" && state.action.get(automatic) === "reject" && current === automatic) current = "";
  return current;
}

export interface AutomaticView {
  topics: string[];
  content_functions: string[];
  carriers: string[];
  affordances: string[];
  form: string;
  use: string;
  entities: string[];
  assessment?: Assessment;
}

export interface FieldDecision {
  dimension: string;
  term_id?: string;
  value?: string;
  candidate?: string;
  verdict: "accepted" | "rejected" | "abstained";
  reason: string;
  probability: number;
}

export interface Assessment {
  version: 1;
  decisions: FieldDecision[];
  incomplete: string[];
}

// Keep policy outcomes verbatim. Neither the Worker nor a reader re-runs a
// guessed threshold over probabilities to manufacture historical decisions.
export function validAssessment(value: unknown): value is Assessment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const boundedText = (entry: unknown, max: number) => typeof entry === "string" && entry.length <= max;
  return row.version === 1 && Array.isArray(row.incomplete) && row.incomplete.length <= 64 &&
    row.incomplete.every((entry) => boundedText(entry, 80)) && Array.isArray(row.decisions) && row.decisions.length <= 256 &&
    row.decisions.every((entry: unknown) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
      const decision = entry as Record<string, unknown>;
      return boundedText(decision.dimension, 80) && boundedText(decision.reason, 1000) &&
        (decision.term_id === undefined || boundedText(decision.term_id, 80)) &&
        (decision.value === undefined || boundedText(decision.value, 80)) &&
        (decision.candidate === undefined || boundedText(decision.candidate, 80)) &&
        ["accepted", "rejected", "abstained"].includes(String(decision.verdict)) &&
        typeof decision.probability === "number" && Number.isFinite(decision.probability) &&
        decision.probability >= 0 && decision.probability <= 1;
    });
}

// Validate only new automatic writes. Historical records remain unchanged and
// readable; explicit human overrides are governed by their separate contract.
export function objectiveUseAllowed(value: Record<string, unknown>): boolean {
  if (personalUse(value.use)) return false;
  if (value.assessment === undefined) return true;
  if (!validAssessment(value.assessment)) return false;
  return !value.assessment.decisions.some(decision =>
    normalizeField(decision.dimension) === "use" && decision.verdict === "accepted" &&
    [decision.value, decision.term_id, decision.candidate].some(personalUse));
}

export function effectiveOrigins(view: EffectiveView, overrides: Override[], automaticOrigin: "automatic" | "legacy_unknown") {
  const states: Record<string, FieldState> = {};
  for (const field of OVERRIDE_FIELDS) states[field] = newFieldState();
  for (const override of [...overrides].sort((a, b) => a.revision - b.revision)) {
    if (states[override.field]) applyOverride(states[override.field], override);
  }
  const origin = (override?: Override) => ({ origin: override?.source ?? automaticOrigin,
    confirmed: override?.source === "human" && override.confirmed === true, revision: override?.revision ?? null });
  return Object.fromEntries(OVERRIDE_FIELDS.map((field) => {
    const state = states[field];
    const values = typeof view[field] === "string" ? (view[field] ? [view[field] as string] : []) : view[field] as string[];
    return [field, {
      values: values.map((term) => ({ term, ...origin(state.action.get(term) === "accept" ? state.origins.get(term) : undefined) })),
      empty: state.empty ? origin(state.emptyOverride) : null,
      // Preserve active rejections and a cleared baseline even when no visible
      // label remains. Reset actions remove origins through the same fold.
      cleared_automatic: state.clearedAutomatic ? origin(state.emptyOverride) : null,
      actions: [...state.origins.values()].map((entry) => ({ term: entry.term, action: entry.action, ...origin(entry) }))
    }];
  }));
}

export const EMPTY_AUTOMATIC: AutomaticView = {
  topics: [], content_functions: [], carriers: [], affordances: [], form: "", use: "", entities: []
};

export interface EffectiveView extends AutomaticView {
  empty: {
    topics: boolean; content_functions: boolean; carriers: boolean;
    affordances: boolean; form: boolean; use: boolean;
  };
  reviewed: boolean;
  /** Latest human override revision the view incorporates. */
  revision: number;
}

// Build the effective view from the automatic proposals of the latest decision
// and the human override log. This is the only derivation of user-facing
// values; list, detail, filters and exports all read its projection.
export function effectiveView(automatic: AutomaticView, overrides: Override[]): EffectiveView {
  const ordered = [...overrides].sort((left, right) => left.revision - right.revision);
  const states: Record<string, FieldState> = {};
  for (const field of OVERRIDE_FIELDS) states[field] = newFieldState();
  for (const override of ordered) {
    const state = states[override.field];
    if (state) applyOverride(state, override);
  }
  const carrier = resolveSingle(automatic.carriers[0] ?? "", states.carriers);
  return {
    topics: resolveMulti(automatic.topics, states.topics),
    content_functions: resolveMulti(automatic.content_functions, states.content_functions),
    // Carrier is single-valued: an accept replaces the automatic carrier.
    carriers: carrier === "" ? [] : [carrier],
    affordances: resolveMulti(automatic.affordances, states.affordances),
    form: resolveSingle(automatic.form, states.form),
    use: resolveSingle(automatic.use, states.use),
    entities: resolveMulti(automatic.entities, states.entities),
    empty: {
      topics: states.topics.empty,
      content_functions: states.content_functions.empty,
      carriers: states.carriers.empty,
      affordances: states.affordances.empty,
      form: states.form.empty,
      use: states.use.empty
    },
    reviewed: Object.values(states).some((state) => state.action.size > 0 || state.clearedAutomatic || state.empty),
    revision: ordered.length > 0 ? ordered[ordered.length - 1].revision : 0
  };
}

export function taxonomyVersion(): string { return taxonomy.version; }

// semanticSpecHash is the cross-language identity of a question spec. It covers
// exactly the provider-visible semantics (type, instructions, criteria) plus
// the spec id, version and score flag — never internal handles or display
// metadata. The Go classifier computes the same hash over the same projection
// and both sides assert the same golden vectors, so a spec registered by the
// consumer verifies against the Worker's stored copy (F14).
export async function semanticSpecHash(spec: QuestionSpec): Promise<string> {
  const questions = Array.isArray(spec.questions)
    ? (spec.questions as Array<Record<string, unknown>>).map((question) => ({
        id: question.id,
        kind: question.kind,
        instructions: question.instructions,
        criteria: question.criteria
      }))
    : spec.questions;
  const payload = {
    spec_id: spec.spec_id,
    spec_version: spec.spec_version,
    score_enabled: spec.score_enabled === true,
    questions
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(payload)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
