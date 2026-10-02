import type { Env } from "./index";
import { canonicalJSON } from "./domain";
import { normalizeTerm, taxonomyV2, validateTaxonomy, type Taxonomy, type TermDefinition } from "./taxonomy-v2";

export interface TopicProposalEvidence {
  link_id: number;
  content_revision: number;
  quote: string;
  source_hash: string;
}

export type TopicProposalValidation =
  | { ok: false; error: string; existing_terms?: string[] }
  | { ok: true; term: TermDefinition; evidence: TopicProposalEvidence[]; fingerprint: string };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const strings = (value: unknown, max: number, required = false): value is string[] =>
  Array.isArray(value) && value.length <= max && (!required || value.length > 0) && value.every(item => string(item, 160));
const digest = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, "0")).join("");

// A new content concept is a governed definition, not a free-form word silently
// turned into a tag. This validates a draft only; it never mutates the catalog,
// runs a model, accepts a bookmark association or infers human confirmation.
export async function validateTopicProposal(
  payload: unknown, env: Pick<Env, "DB">, catalog: Taxonomy = taxonomyV2()
): Promise<TopicProposalValidation> {
  if (!object(payload) || !object(payload.term)) return { ok: false, error: "topic_definition_required" };
  const value = payload.term;
  if (!string(value.id, 40) || !/^[a-z][a-z0-9_]{0,39}$/.test(value.id) ||
      !string(value.label, 40) || !string(value.description, 800) ||
      !strings(value.aliases, 12) || !strings(value.includes, 12, true) || !strings(value.excludes, 12, true) ||
      !strings(value.recall_terms, 24) || !["broad", "specific"].includes(String(value.granularity)) ||
      typeof value.navigation !== "boolean") return { ok: false, error: "invalid_topic_definition" };
  const names = new Set([value.id, value.label, ...value.aliases].map(normalizeTerm));
  const duplicates = catalog.topics.filter(term => [term.id, term.label, ...term.aliases].some(name => names.has(normalizeTerm(name))));
  if (duplicates.length) return { ok: false, error: "existing_topic", existing_terms: duplicates.map(term => term.id) };
  // A topic plus a resource is a query combination, not a new concept. Only
  // exact catalog names are used here: related meanings are never auto-merged.
  const label = normalizeTerm(value.label).replace(/[\s+×·/_-]/gu, "");
  for (const topic of catalog.topics.filter(term => term.active && !term.deprecated)) {
    for (const resource of catalog.resource_kinds ?? []) {
      for (const topicName of [topic.label, ...topic.aliases]) {
        for (const resourceName of [resource.label, ...resource.aliases]) {
          const combined = normalizeTerm(topicName + resourceName).replace(/[\s+×·/_-]/gu, "");
          if (label === combined || label === `ai${combined}`) {
            return { ok: false, error: "use_topic_resource_combination", existing_terms: [topic.id, resource.id] };
          }
        }
      }
    }
  }
  const relations: NonNullable<TermDefinition["relations"]> = [];
  if (value.relations !== undefined) {
    if (!Array.isArray(value.relations) || value.relations.length > 16) return { ok: false, error: "invalid_topic_relations" };
    for (const relation of value.relations) {
      if (!object(relation) || typeof relation.id !== "string" || relation.kind !== "related" ||
          !catalog.topics.some(term => term.id === relation.id && term.active && !term.deprecated)) {
        return { ok: false, error: "invalid_topic_relations" };
      }
      if (!relations.some(item => item.id === relation.id)) relations.push({ id: relation.id, kind: "related" });
    }
  }
  const term: TermDefinition = {
    id: value.id, label: value.label.trim(), description: value.description.trim(),
    aliases: value.aliases.map(item => item.trim()), includes: value.includes.map(item => item.trim()),
    excludes: value.excludes.map(item => item.trim()), recall_terms: value.recall_terms.map(item => item.trim()),
    granularity: value.granularity as "broad" | "specific", navigation: value.navigation,
    relations, active: true, status: "active", definition_version: 1, display_revision: 1,
  };
  if (validateTaxonomy({ ...catalog, topics: [...catalog.topics, term] }).length) return { ok: false, error: "invalid_topic_definition" };
  if (!Array.isArray(payload.evidence) || payload.evidence.length < 1 || payload.evidence.length > 5) {
    return { ok: false, error: "topic_evidence_required" };
  }
  const evidence: TopicProposalEvidence[] = [];
  const seen = new Set<number>();
  for (const item of payload.evidence) {
    if (!object(item) || !Number.isSafeInteger(item.link_id) || Number(item.link_id) <= 0 ||
        !Number.isSafeInteger(item.content_revision) || Number(item.content_revision) < 0 || !string(item.quote, 1000) ||
        seen.has(Number(item.link_id))) return { ok: false, error: "invalid_topic_evidence" };
    seen.add(Number(item.link_id));
    const row = await env.DB.prepare("SELECT content_revision, original_text FROM links WHERE id = ?")
      .bind(item.link_id).first<{ content_revision: number; original_text: string | null }>();
    if (!row || row.content_revision !== item.content_revision) return { ok: false, error: "stale_topic_evidence" };
    if (!row.original_text || !row.original_text.includes(item.quote)) return { ok: false, error: "unsupported_topic_evidence" };
    evidence.push({ link_id: Number(item.link_id), content_revision: Number(item.content_revision), quote: item.quote,
      source_hash: await digest(row.original_text) });
  }
  evidence.sort((a, b) => a.link_id - b.link_id);
  return { ok: true, term, evidence, fingerprint: await digest(canonicalJSON({ term, evidence })) };
}
