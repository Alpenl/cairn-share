import { canonicalJSON, normalizeField } from "./domain";
import { record } from "./curation";

type Question = Record<string, unknown>;
export type CandidateSelection = { selected: Set<string>; omitted: Array<Record<string, unknown>> };
const sortedUnique = (value: unknown): value is string[] => Array.isArray(value) &&
  value.every((id, index) => typeof id === "string" && (index === 0 || value[index - 1] < id));

// Metadata 1 means complete coverage of the full frozen spec. Metadata 2 means
// complete coverage of an explicit bounded selection, never negative evidence
// for the omitted terms. The manifest remains bound to that same spec/state.
export async function validateCandidateManifest(raw: Record<string, unknown>, questions: Map<string, Question>): Promise<CandidateSelection | null> {
  const manifest = raw.candidate_manifest;
  if (!record(manifest) || questions.size > 128 || Object.keys(manifest).some(key => ![
    "version", "policy_version", "spec_hash", "state_hash", "max_questions", "selected_question_ids",
    "omitted_question_ids", "omitted", "selection_hash"
  ].includes(key)) || manifest.version !== 1 || manifest.policy_version !== "topic-recall-v1" ||
    manifest.spec_hash !== raw.spec_hash || manifest.state_hash !== raw.evidence_hash ||
    !Number.isSafeInteger(manifest.max_questions) || Number(manifest.max_questions) < 1 || Number(manifest.max_questions) > 128 ||
    !sortedUnique(manifest.selected_question_ids) || !sortedUnique(manifest.omitted_question_ids) ||
    manifest.selected_question_ids.length > Number(manifest.max_questions) ||
    manifest.selected_question_ids.length + manifest.omitted_question_ids.length !== questions.size ||
    !Array.isArray(manifest.omitted) || manifest.omitted.length !== manifest.omitted_question_ids.length) return null;
  const selected = new Set(manifest.selected_question_ids), omittedIDs = new Set(manifest.omitted_question_ids);
  let mandatory = 0;
  for (const [id, question] of questions) {
    if (selected.has(id) === omittedIDs.has(id)) return null;
    if (question.granularity !== "specific") { mandatory++; if (!selected.has(id)) return null; }
  }
  if (mandatory > Number(manifest.max_questions) || [...selected, ...omittedIDs].some(id => !questions.has(id))) return null;
  const omitted: Array<Record<string, unknown>> = [];
  for (let index = 0; index < manifest.omitted.length; index++) {
    const descriptor = manifest.omitted[index], id = manifest.omitted_question_ids[index], question = questions.get(id)!;
    if (!record(descriptor) || Object.keys(descriptor).some(key => !["question_id", "dimension", "term_id", "granularity", "reason"].includes(key)) ||
      descriptor.question_id !== id || descriptor.dimension !== question.dimension ||
      (descriptor.term_id ?? "") !== (question.term_id ?? "") || descriptor.granularity !== question.granularity ||
      !["not_recalled", "candidate_limit"].includes(String(descriptor.reason)) ||
      normalizeField(question.dimension) !== "topics" || question.kind !== "noul") return null;
    omitted.push(descriptor);
  }
  const { selection_hash, ...identity } = manifest;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(identity)));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return selection_hash === hash ? { selected, omitted } : null;
}

// A policy may recompute multiple compatible runs. An omission only remains
// unknown when none of those runs actually judged that question.
export function validCandidateAutomatic(raw: unknown, automatic: unknown, additionallyJudged = new Set<string>()): boolean {
  if (!record(raw) || raw.metadata_version !== 2) return true;
  if (!record(raw.candidate_manifest) || !Array.isArray(raw.candidate_manifest.omitted) || !record(automatic)) return false;
  const omitted = raw.candidate_manifest.omitted.filter((item: unknown) => record(item) && !additionallyJudged.has(String(item.question_id))) as Array<Record<string, unknown>>;
  if (record(automatic.assessment) && Array.isArray(automatic.assessment.decisions)) {
    for (const decision of automatic.assessment.decisions) {
      if (record(decision) && ["not_recalled", "candidate_limit"].includes(String(decision.reason)) &&
        !omitted.some(item => normalizeField(item.dimension) === normalizeField(decision.dimension) && item.term_id === decision.term_id)) return false;
    }
  }
  if (!omitted.length) return true;
  if (!record(automatic.assessment) || !Array.isArray(automatic.assessment.decisions)) return false;
  for (const item of omitted) {
    const dimension = normalizeField(item.dimension);
    if (!dimension || (Array.isArray(automatic[dimension]) && automatic[dimension].includes(item.term_id))) return false;
    const matches = automatic.assessment.decisions.filter((decision: unknown) => record(decision) &&
      normalizeField(decision.dimension) === dimension && decision.term_id === item.term_id);
    if (matches.length !== 1 || matches[0].verdict !== "abstained" || matches[0].reason !== item.reason ||
      matches[0].probability !== undefined) return false;
  }
  return true;
}
