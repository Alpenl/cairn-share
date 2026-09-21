// B05-T01: the explicit v1 → v2 mapping.
//
// The v1 vocabulary keeps its stable IDs and historical meaning. This table
// records, for every legacy term, whether v2 keeps it, splits it, deprecates it
// or cannot decide from the stored evidence — and which v2 term it corresponds
// to. Nothing here rewrites a historical label into a new meaning silently: an
// `uncertain` entry is a deliberate "do not guess" marker.
import taxonomy from "./taxonomy.json";
import { taxonomyV2, type TermDefinition } from "./taxonomy-v2";

export type MappingStatus = "keep" | "split" | "deprecate" | "uncertain";

export interface MappingRelation {
  dimension: "topics" | "content_functions" | "carriers" | "affordances" | "forms" | "uses";
  id: string;
  /** synonym | broader | narrower | related — never conflated. */
  relation: "synonym" | "broader" | "narrower" | "related";
}

export interface MappingEntry {
  legacy: { dimension: "topics" | "forms" | "uses"; id: string };
  status: MappingStatus;
  /** The legacy v1 dimension is still present in v2 for the v1 projection. */
  v1_kept: boolean;
  v2_related: MappingRelation[];
  note: string;
}

export const V1_V2_MAPPING: MappingEntry[] = [
  // Topics keep their IDs. `eval` is also a cross-cutting method facet, which
  // is recorded as a relation rather than by renaming the topic.
  ...["llm", "eng", "product", "design", "writing", "invest", "health", "psych", "manage", "media", "law", "edu", "history", "science", "city", "life"].map((id) => ({
    legacy: { dimension: "topics" as const, id },
    status: "keep" as const,
    v1_kept: true,
    v2_related: [],
    note: "v2 保留同一稳定 ID 与含义。"
  })),
  {
    legacy: { dimension: "topics", id: "eval" },
    status: "keep",
    v1_kept: true,
    v2_related: [{ dimension: "content_functions", id: "method", relation: "related" }],
    note: "评估既是领域主题，也是跨领域方法 facet；v2 保留 topic:eval，不把它改写成方法，也不新造细类。"
  },
  // v1 forms are kept as the v1 projection dimension; the content-function
  // counterparts are declared as synonyms where the meaning is identical.
  { legacy: { dimension: "forms", id: "opinion" }, status: "keep", v1_kept: true, v2_related: [{ dimension: "content_functions", id: "opinion", relation: "synonym" }], note: "观点功能与 v1 opinion 同义。" },
  { legacy: { dimension: "forms", id: "method" }, status: "keep", v1_kept: true, v2_related: [{ dimension: "content_functions", id: "method", relation: "synonym" }], note: "方法功能与 v1 method 同义。" },
  { legacy: { dimension: "forms", id: "case" }, status: "keep", v1_kept: true, v2_related: [{ dimension: "content_functions", id: "case", relation: "synonym" }], note: "案例功能与 v1 case 同义。" },
  { legacy: { dimension: "forms", id: "data" }, status: "keep", v1_kept: true, v2_related: [{ dimension: "content_functions", id: "data", relation: "synonym" }], note: "数据功能与 v1 data 同义。" },
  { legacy: { dimension: "forms", id: "tool" }, status: "keep", v1_kept: true, v2_related: [{ dimension: "content_functions", id: "tool", relation: "synonym" }], note: "工具功能与 v1 tool 同义。" },
  { legacy: { dimension: "forms", id: "thread" }, status: "keep", v1_kept: true, v2_related: [{ dimension: "carriers", id: "author_continuation", relation: "synonym" }], note: "串推对应真实载体“作者续帖”。" },
  {
    legacy: { dimension: "forms", id: "longform" },
    status: "uncertain",
    v1_kept: true,
    v2_related: [],
    note: "长文可能是站内长帖或外链长文；现有证据无法区分，v2 不猜，v1 longform 保留。"
  },
  // Uses map to affordances where the meaning is identical; `contra` is a
  // stance-like use with no v2 affordance equivalent.
  { legacy: { dimension: "uses", id: "quote" }, status: "keep", v1_kept: true, v2_related: [{ dimension: "affordances", id: "quote", relation: "synonym" }], note: "可引用同义。" },
  { legacy: { dimension: "uses", id: "try" }, status: "keep", v1_kept: true, v2_related: [{ dimension: "affordances", id: "practice", relation: "synonym" }], note: "待试对应可实践。" },
  { legacy: { dimension: "uses", id: "background" }, status: "keep", v1_kept: true, v2_related: [{ dimension: "affordances", id: "background", relation: "synonym" }], note: "背景同义。" },
  { legacy: { dimension: "uses", id: "material" }, status: "keep", v1_kept: true, v2_related: [{ dimension: "affordances", id: "material", relation: "synonym" }], note: "素材同义。" },
  {
    legacy: { dimension: "uses", id: "contra" },
    status: "uncertain",
    v1_kept: true,
    v2_related: [],
    note: "反对是立场/用途混合的旧值；v2 不提供等价 affordance，也不把它当成用户立场推断，保留 v1 可读。"
  }
];

// validateMapping checks the mapping against both vocabularies. It is used by
// the Worker test suite so a vocabulary change cannot silently orphan a legacy
// term.
export function validateMapping(entries: MappingEntry[] = V1_V2_MAPPING): string[] {
  const problems: string[] = [];
  const legacy = taxonomy as unknown as Record<string, TermDefinition[]>;
  const current = taxonomyV2();
  const currentDimensions = current as unknown as Record<string, TermDefinition[]>;
  const covered = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.legacy.dimension}:${entry.legacy.id}`;
    if (covered.has(key)) problems.push(`duplicate mapping for ${key}`);
    covered.add(key);
    const legacyTerms = legacy[entry.legacy.dimension] ?? [];
    if (!legacyTerms.some((term) => term.id === entry.legacy.id)) {
      problems.push(`mapping references unknown legacy term ${key}`);
    }
    if (entry.status === "uncertain" && entry.v2_related.length > 0) {
      problems.push(`uncertain mapping ${key} must not claim a v2 equivalent`);
    }
    for (const relation of entry.v2_related) {
      const terms = currentDimensions[relation.dimension] ?? [];
      const term = terms.find((candidate) => candidate.id === relation.id);
      if (!term) problems.push(`${key} maps to unknown ${relation.dimension}:${relation.id}`);
      else if (!term.active || term.deprecated) problems.push(`${key} maps to inactive ${relation.dimension}:${relation.id}`);
    }
  }
  for (const dimension of ["topics", "forms", "uses"] as const) {
    for (const term of legacy[dimension] ?? []) {
      if (!covered.has(`${dimension}:${term.id}`)) problems.push(`legacy term ${dimension}:${term.id} has no mapping`);
    }
  }
  return problems;
}
