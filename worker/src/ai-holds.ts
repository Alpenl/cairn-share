// E4 confirm-before-apply: which automatic terms a new decision holds back.
// Pure so the Worker, tests and clients agree on one rule. Only the tag types
// people see as tags are affected (主题 / 资源类型 / 内容特征); carriers,
// affordances and legacy form/use keep their current behaviour.
import type { AutomaticView } from "./domain";
import type { PREFERENCE_DEFAULTS } from "./library-extras";
import type { Env } from "./index";

export type AiPreferences = typeof PREFERENCE_DEFAULTS;
export type HoldReason = "confirm" | "low_confidence" | "limit";
export interface Hold { field: HeldField; term: string; reason: HoldReason; probability: number | null }
export type HeldField = "topics" | "resource_kinds" | "content_functions";

export const HELD_FIELDS: HeldField[] = ["topics", "resource_kinds", "content_functions"];
// The suggestion limit counts the primary tags (主题 + 资源类型); 内容特征 is a
// small fixed vocabulary and is never cut by the limit.
const LIMITED_FIELDS: HeldField[] = ["topics", "resource_kinds"];
// Accepted terms this close to the policy's accept thresholds (topics 0.8,
// choices 0.65) count as low confidence.
export const LOW_CONFIDENCE_BELOW = 0.9;

function probabilityOf(automatic: AutomaticView, field: HeldField, term: string): number | null {
  const decisions = automatic.assessment?.decisions ?? [];
  const hit = decisions.find((d) => d.dimension === field && (d.term_id === term || d.value === term) && d.verdict === "accepted");
  return hit && typeof hit.probability === "number" && Number.isFinite(hit.probability) ? hit.probability : null;
}

export function computeHolds(automatic: AutomaticView, prefs: AiPreferences): Hold[] {
  const terms = HELD_FIELDS.flatMap((field) => (automatic[field] ?? []).map((term, order) => ({
    field, term, order, probability: probabilityOf(automatic, field, term) })));
  const holds = new Map<string, Hold>();
  const hold = (t: typeof terms[number], reason: HoldReason) => {
    const key = `${t.field}\u0000${t.term}`;
    if (!holds.has(key)) holds.set(key, { field: t.field, term: t.term, reason, probability: t.probability });
  };
  // Keep the most confident primary tags; unknown probability keeps classifier order.
  const primary = terms.filter((t) => LIMITED_FIELDS.includes(t.field))
    .map((t, index) => ({ t, index }))
    .sort((a, b) => (b.t.probability ?? -1) - (a.t.probability ?? -1) || a.index - b.index);
  const limit = Math.max(1, Math.min(8, Math.trunc(prefs.ai_suggestion_limit)));
  for (const { t } of primary.slice(limit)) hold(t, "limit");
  for (const t of terms) {
    if (prefs.ai_confirm_before_apply) hold(t, "confirm");
    else if (prefs.ai_low_confidence_review && t.probability !== null && t.probability < LOW_CONFIDENCE_BELOW) hold(t, "low_confidence");
  }
  return [...holds.values()];
}

/** Automatic terms with this decision's holds removed; the input is not changed. */
export function withoutHolds(automatic: AutomaticView, holds: Array<Pick<Hold, "field" | "term">>): AutomaticView {
  if (!holds.length) return automatic;
  const out = { ...automatic };
  for (const field of HELD_FIELDS) {
    const held = new Set(holds.filter((h) => h.field === field).map((h) => h.term));
    if (held.size && out[field]) out[field] = (out[field] as string[]).filter((term) => !held.has(term));
  }
  return out;
}

/** One statement, appended after the decision insert in the same batch. */
export function holdInsertStatement(env: Pick<Env, "DB">, decisionOperationKey: string, linkId: number, holds: Hold[], createdAt: string): D1PreparedStatement | null {
  if (!holds.length) return null;
  return env.DB.prepare(`INSERT INTO ai_suggestion_holds(decision_id,link_id,field,term,reason,probability,created_at)
    SELECT d.id,?,json_extract(h.value,'$.field'),json_extract(h.value,'$.term'),json_extract(h.value,'$.reason'),
      json_extract(h.value,'$.probability'),? FROM classification_decisions d,json_each(?) h
    WHERE d.operation_key=? AND d.link_id=? ON CONFLICT(decision_id,field,term) DO NOTHING`)
    .bind(linkId, createdAt, JSON.stringify(holds), decisionOperationKey, linkId);
}
