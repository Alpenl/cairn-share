import type { Env } from "./index";
import { record } from "./curation";
import { canonicalJSON } from "./domain";

const hashShape = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Legacy absence is honest unknown, not an invented provenance certificate.
// A supplied versioned record must bind the immutable spec, typed answers and
// actual bounded state. Reuse references may only point to this link's runs.
export async function validRunProvenance(env: Env, linkId: number, raw: unknown, expected: {
  specId: string; specHash: string; requestedModel: string; resolvedModel: string;
  coverage: string; answers: Record<string, unknown>; usage: unknown;
}): Promise<boolean> {
  if (raw === undefined || raw === null || (record(raw) && raw.metadata_version === undefined)) return true;
  if (!record(raw) || raw.metadata_version !== 1 || raw.spec_id !== expected.specId ||
      raw.spec_hash !== expected.specHash || raw.requested_model !== expected.requestedModel ||
      raw.resolved_model !== expected.resolvedModel || raw.coverage !== expected.coverage ||
      typeof raw.batch_semantics !== "string" || !raw.batch_semantics ||
      typeof raw.wire_state !== "string" || new TextEncoder().encode(raw.wire_state).length > 48 * 1024 ||
      !hashShape(raw.evidence_hash) || await hash(raw.wire_state) !== raw.evidence_hash ||
      !record(raw.judgments) || !record(raw.question_hashes)) return false;
  let state: unknown;
  try { state = JSON.parse(raw.wire_state); } catch { return false; }
  if (!record(state) || typeof state.primary !== "string" || !state.primary ||
      Object.keys(state).some(key => !["primary", "context", "coverage", "truncated"].includes(key)) ||
      raw.evidence_coverage !== state.coverage || (raw.truncated === true) !== state.truncated) return false;
  const specRow = await env.DB.prepare("SELECT spec_hash,payload FROM question_specs WHERE spec_id=?")
    .bind(expected.specId).first<{ spec_hash: string; payload: string }>();
  if (!specRow || specRow.spec_hash !== expected.specHash) return false;
  const spec = JSON.parse(specRow.payload) as { questions: unknown };
  if (!Array.isArray(spec.questions)) return false;
  const questions = new Map<string, Record<string, unknown>>();
  for (const question of spec.questions) {
    if (!record(question) || typeof question.id !== "string") return false;
    questions.set(question.id, question);
  }
  if (Object.keys(raw.judgments).length !== Object.keys(expected.answers).length ||
      Object.keys(raw.question_hashes).length !== Object.keys(raw.judgments).length) return false;
  for (const [id, judgment] of Object.entries(raw.judgments)) {
    const question = questions.get(id), answer = expected.answers[id];
    if (!question || !record(judgment) || !record(answer) || judgment.question_id !== id ||
        judgment.kind !== question.kind || judgment.dimension !== question.dimension ||
        (judgment.term_id ?? "") !== (question.term_id ?? "")) return false;
    const expectedHash = await hash(canonicalJSON({ id, kind: question.kind, instructions: question.instructions, criteria: question.criteria }));
    if (raw.question_hashes[id] !== expectedHash) return false;
    const normalized: Record<string, unknown> = { type: judgment.kind };
    if (judgment.confidence !== undefined) normalized.confidence = judgment.confidence;
    if (judgment.kind === "noul") normalized.noul = judgment.noul;
    else if (judgment.kind === "choice") { normalized.choice = judgment.choice; normalized.probabilities = judgment.probabilities; }
    else if (judgment.kind === "score" && Array.isArray(judgment.levels)) {
      normalized.score = judgment.score; normalized.probabilities = judgment.probabilities;
      normalized.legend = Object.fromEntries(judgment.levels.map((level, index) => [String(index), level]));
    } else return false;
    if (canonicalJSON(normalized) !== canonicalJSON(answer)) return false;
  }
  const complete = expected.coverage === "complete";
  if (complete && (raw.missing !== undefined && (!Array.isArray(raw.missing) || raw.missing.length !== 0))) return false;
  if (complete && (raw.alias_drift === true) !== (expected.requestedModel !== expected.resolvedModel)) return false;
  const expectedUsage = raw.usage_missing === true ? { missing: true } : raw.usage;
  if (canonicalJSON(expectedUsage) !== canonicalJSON(expected.usage)) return false;
  const calls = raw.calls ?? [], reused = raw.reused ?? [], sources = raw.reused_from ?? {};
  if (!Array.isArray(calls) || !Array.isArray(reused) || !record(sources) || calls.length > questions.size || reused.length > questions.size) return false;
  const covered = new Set<string>();
  let input = 0, output = 0, usageMissing = false;
  for (const call of calls) {
    if (!record(call) || !hashShape(call.request_hash) || call.state_hash !== raw.evidence_hash ||
        call.requested_model !== expected.requestedModel || !Array.isArray(call.question_ids) || !call.question_ids.length ||
        (complete && (call.resolved_model !== expected.resolvedModel || call.http_status !== 200))) return false;
    const usage = call.usage;
    const known = record(usage) && Number.isSafeInteger(usage.input_tokens) && Number(usage.input_tokens) >= 0 && Number.isSafeInteger(usage.output_tokens) && Number(usage.output_tokens) >= 0;
    if ((call.usage_missing === true) === known) return false;
    usageMissing ||= !known;
    if (known && record(usage)) { input += Number(usage.input_tokens); output += Number(usage.output_tokens); }
    for (const id of call.question_ids) {
      if (typeof id !== "string" || !questions.has(id) || covered.has(id)) return false;
      covered.add(id);
    }
  }
  const priorRuns = new Map<number, { resolved_model: string; coverage: string; raw_judgments: string | null }>();
  for (const id of reused) {
    if (typeof id !== "string" || !questions.has(id) || covered.has(id) || !Number.isSafeInteger(sources[id]) || Number(sources[id]) <= 0) return false;
    const sourceID = Number(sources[id]);
    let old = priorRuns.get(sourceID);
    if (!old) {
      const stored = await env.DB.prepare("SELECT resolved_model,coverage,raw_judgments FROM classification_runs WHERE id=? AND link_id=? AND status='succeeded'")
        .bind(sourceID,linkId).first<{ resolved_model: string; coverage: string; raw_judgments: string | null }>();
      if (!stored) return false;
      priorRuns.set(sourceID, stored); old = stored;
    }
    if (!old.raw_judgments || old.resolved_model !== expected.resolvedModel || old.coverage !== "complete") return false;
    const prior: unknown = JSON.parse(old.raw_judgments);
    if (!record(prior) || prior.metadata_version !== 1 || prior.evidence_hash !== raw.evidence_hash || prior.batch_semantics !== raw.batch_semantics ||
        !record(prior.question_hashes) || prior.question_hashes[id] !== raw.question_hashes[id] || !record(prior.judgments) ||
        canonicalJSON(prior.judgments[id]) !== canonicalJSON(raw.judgments[id])) return false;
    covered.add(id);
  }
  if (Object.keys(sources).length !== reused.length || (raw.usage_missing === true) !== usageMissing) return false;
  if (!usageMissing && (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || !record(raw.usage) || raw.usage.input_tokens !== input || raw.usage.output_tokens !== output)) return false;
  return !complete || (covered.size === questions.size && Object.keys(raw.judgments).length === questions.size);
}
