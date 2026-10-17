import { objectiveUseAllowed, validAssessment, type AutomaticView } from "./domain";

export function validReplayPolicy(value: Record<string, unknown>): boolean {
  const allowed = ["version", "calibrated", "topic_accept", "topic_reject", "choice_accept", "choice_margin", "max_display_topics",
    "max_effective_topics", "allow_alias_drift", "block_personal_use", "min_primary_tags", "max_primary_tags", "function_support_accept", "prefer_specific_topics"];
  if (Object.keys(value).some(k => !allowed.includes(k)) || typeof value.calibrated !== "boolean" || typeof value.allow_alias_drift !== "boolean" ||
    value.block_personal_use !== true || !["topic_accept", "topic_reject", "choice_accept", "choice_margin"].every(k =>
      typeof value[k] === "number" && Number(value[k]) >= 0 && Number(value[k]) <= 1) ||
    Number(value.topic_reject) > Number(value.topic_accept) ||
    !["max_display_topics", "max_effective_topics"].every(k => Number.isSafeInteger(value[k]) && Number(value[k]) >= 1 && Number(value[k]) <= 64) ||
    Number(value.max_display_topics) > Number(value.max_effective_topics)) return false;
  const density = ["min_primary_tags", "max_primary_tags", "function_support_accept"].some(k => value[k] !== undefined && value[k] !== 0);
  if (value.prefer_specific_topics !== undefined && typeof value.prefer_specific_topics !== "boolean" ||
    ["jev-policy-v2", "jev-policy-v3", "jev-policy-v4"].includes(String(value.version)) && value.prefer_specific_topics === true ||
    value.version === "jev-policy-v5" && value.prefer_specific_topics !== true) return false;
  if (["jev-policy-v2", "jev-policy-v3"].includes(String(value.version)) && density) return false;
  return !(["jev-policy-v4", "jev-policy-v5"].includes(String(value.version)) || density) ||
    Number.isSafeInteger(value.min_primary_tags) && Number.isSafeInteger(value.max_primary_tags) && Number(value.min_primary_tags) >= 1 &&
    Number(value.max_primary_tags) >= 2 && Number(value.min_primary_tags) <= Number(value.max_primary_tags) && Number(value.max_primary_tags) <= 64 &&
    typeof value.function_support_accept === "number" && value.function_support_accept > Number(value.topic_reject) && value.function_support_accept <= Number(value.topic_accept);
}

export function normalizeAutomatic(value: Record<string, unknown>): AutomaticView | null {
  if (!objectiveUseAllowed(value)) return null;
  if (value.assessment !== undefined && !validAssessment(value.assessment)) return null;
  const list = (entry: unknown): string[] | null =>
    Array.isArray(entry) && entry.every((item) => typeof item === "string") ? entry as string[] : null;
  const topics = list(value.topics ?? []);
  const contentFunctions = list(value.content_functions ?? []);
  const carriers = list(value.carriers ?? []);
  const affordances = list(value.affordances ?? []);
  const resources = value.resource_kinds === undefined ? undefined : list(value.resource_kinds);
  const entities = list(value.entities ?? []);
  if (!topics || !contentFunctions || !carriers || !affordances || !entities) return null;
  if (resources === null || (resources && resources.length > 6)) return null;
  if (topics.length > 64 || contentFunctions.length > 8 || carriers.length > 1 || affordances.length > 8) return null;
  return {
    ...(value.assessment === undefined ? {} : { assessment: value.assessment }),
    topics, content_functions: contentFunctions, carriers, affordances, entities,
    ...(resources ? { resource_kinds: resources } : {}),
    form: typeof value.form === "string" ? value.form : "",
    use: typeof value.use === "string" ? value.use : ""
  };
}
