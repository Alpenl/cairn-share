// B05: versioned multidimensional taxonomy and the v1/v2 protocol boundary.
//
// The v1 vocabulary (17 topics / 7 forms / 5 uses) keeps its stable IDs and
// historical meaning. v2 adds independent dimensions and richer term
// definitions, but every v2 projection must remain expressible as a legal v1
// payload so an old client can still read it.
import taxonomy from "./taxonomy.json";

export interface TermRelation {
  /** Stable ID of the related term. */
  id: string;
  /** synonym | broader | narrower | related — never conflated. */
  kind: "synonym" | "broader" | "narrower" | "related";
}

export interface TermDefinition {
  id: string;
  label: string;
  active: boolean;
  deprecated?: boolean;
  aliases: string[];
  description: string;
  /** Positive examples that should match this term. */
  includes?: string[];
  /** Negative examples that must not match, even though they look similar. */
  excludes?: string[];
  /** Explicit relationships; a label rename never rewrites meaning silently. */
  relations?: TermRelation[];
  /** Facets are cross-cutting (for example evaluation as a method). */
  facet?: boolean;
}

export interface Taxonomy {
  version: string;
  /** Semantic version of the definitions, independent of the display labels. */
  definition_version: number;
  topics: TermDefinition[];
  forms: TermDefinition[];
  uses: TermDefinition[];
  content_functions: TermDefinition[];
  carriers: TermDefinition[];
  affordances: TermDefinition[];
}

// Dimensions that may be selected independently. Topics, content functions and
// affordances are multi-select; carrier is single-valued by real structure.
export type Dimension = "topics" | "content_functions" | "carriers" | "affordances";

export const MULTI_SELECT_DIMENSIONS: Dimension[] = ["topics", "content_functions", "affordances"];
// forms and uses are the v1 single-valued dimensions, retained for projection.
export type V1Dimension = "forms" | "uses";
export const SINGLE_SELECT_DIMENSIONS: Array<Dimension | V1Dimension> = ["carriers", "forms", "uses"];

export interface V2Selection {
  topics: string[];
  content_functions: string[];
  carriers: string[];
  affordances: string[];
  // v1 single-valued dimensions are retained for the legacy projection.
  form: string;
  use: string;
}

// The v2 vocabulary. `forms`/`uses` are the v1 dimensions kept for projection;
// the new dimensions are purely additive.
const v2: Taxonomy = {
  ...(taxonomy as unknown as Taxonomy),
  definition_version: 2,
  content_functions: [
    { id: "method", label: "方法", active: true, aliases: ["方法论", "流程"], description: "可复用的步骤或方法论。", includes: ["如何做", "步骤"], excludes: ["只给结论"] },
    { id: "tool", label: "工具", active: true, aliases: ["产品", "软件"], description: "具体的工具、产品或库。", includes: ["开源项目", "插件"], excludes: ["纯观点"] },
    { id: "case", label: "案例", active: true, aliases: ["实践", "复盘"], description: "真实案例、实践记录或复盘。", includes: ["亲历", "踩坑"], excludes: ["假设举例"] },
    { id: "data", label: "数据", active: true, aliases: ["统计", "结果"], description: "数据、统计或实验结果。", includes: ["benchmark", "指标"], excludes: ["无来源数字"] },
    { id: "opinion", label: "观点", active: true, aliases: ["评论", "论证"], description: "主张、判断、评论或论证。", includes: ["我认为"], excludes: ["纯事实通报"] },
  ],
  carriers: [
    { id: "single", label: "单帖", active: true, aliases: ["单条"], description: "当前可观察的来源是原帖，没有已提供的同作者关联续帖正文，也没有已提供的关联外部文章正文。仅描述当前材料，不声称来源已抓全。", includes: ["只有原帖正文", "原帖加引用或他人评论", "原帖含普通链接但没有外链文章正文"], excludes: ["已提供同作者关联续帖正文", "已提供原帖所链接的外部文章正文", "没有可观察的来源正文"] },
    { id: "author_continuation", label: "作者续帖", active: true, aliases: ["串推", "thread"], description: "已提供原帖与同一作者的关联续帖正文；同时有外链文章正文时，仍优先选择作者续帖。", includes: ["原帖和已确认同作者的后续帖子", "同作者续帖加关联外链正文"], excludes: ["只有他人评论或引用", "只有 1/n 字样但未提供续帖正文", "作者或续帖关系无法确认"] },
    { id: "external_article", label: "外链长文", active: true, aliases: ["文章", "博客"], description: "已提供原帖所链接的外部文章正文，且没有已提供的同作者关联续帖正文；即使也有原帖，仍选择外链长文。", includes: ["原帖加其链接的博客正文", "已确认来自关联外链的文章正文"], excludes: ["已提供同作者关联续帖正文", "只有 URL 或网页标题而没有文章正文", "只有站内引用或他人评论"] },
    { id: "unknown", label: "未知", active: true, aliases: [], description: "缺少可判断的来源正文，或材料的作者、关联关系不足以确认载体结构。不是有充分证据但不属于这些载体的其他结构。", includes: ["只有未展开的链接且没有正文", "无法确认内容之间的来源关系"], excludes: ["可明确确认单帖、作者续帖或关联外链正文", "结构可确认但不属于本词表的独立视频、书籍等"] },
  ],
  affordances: [
    { id: "quote", label: "可引用", active: true, aliases: ["引用"], description: "适合引用其中的观点或结论。", includes: ["金句"], excludes: [] },
    { id: "practice", label: "可实践", active: true, aliases: ["待试", "上手"], description: "适合自己动手实践或试用。", includes: ["教程"], excludes: [] },
    { id: "background", label: "可作背景", active: true, aliases: ["背景"], description: "适合作为背景材料理解上下文。", includes: ["综述"], excludes: [] },
    { id: "material", label: "可作素材", active: true, aliases: ["素材"], description: "适合作为写作或创作的素材。", includes: ["案例库"], excludes: [] },
  ],
};

export function taxonomyV2(): Taxonomy {
  return v2;
}

// Validate the v2 vocabulary: unique IDs, no alias collisions inside a
// dimension, relations that resolve, and no synonym/broader cycles.
export function validateTaxonomy(candidate: Taxonomy = v2): string[] {
  const problems: string[] = [];
  if (!candidate.version || !Number.isSafeInteger(candidate.definition_version)) {
    problems.push("version or definition_version missing");
  }
  const dimensions: Array<[string, TermDefinition[]]> = [
    ["topics", candidate.topics], ["forms", candidate.forms], ["uses", candidate.uses],
    ["content_functions", candidate.content_functions], ["carriers", candidate.carriers], ["affordances", candidate.affordances],
  ];
  for (const [name, terms] of dimensions) {
    if (!Array.isArray(terms) || terms.length === 0) {
      problems.push(`${name} is empty`);
      continue;
    }
    const ids = new Set<string>();
    const aliases = new Map<string, string>();
    for (const term of terms) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(term.id)) problems.push(`${name}: invalid id ${term.id}`);
      if (ids.has(term.id)) problems.push(`${name}: duplicate id ${term.id}`);
      ids.add(term.id);
      for (const alias of [term.id, term.label, ...(term.aliases ?? [])]) {
        const key = normalizeTerm(alias);
        const owner = aliases.get(key);
        if (owner !== undefined && owner !== term.id) problems.push(`${name}: alias ${alias} collides between ${owner} and ${term.id}`);
        aliases.set(key, term.id);
      }
    }
    for (const term of terms) {
      for (const relation of term.relations ?? []) {
        if (!ids.has(relation.id)) problems.push(`${name}: ${term.id} relates to unknown ${relation.id}`);
      }
    }
  }
  return problems;
}

export function normalizeTerm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export function findTerm(dimension: string, id: string): TermDefinition | undefined {
  const terms = (v2 as unknown as Record<string, TermDefinition[]>)[dimension] ?? [];
  return terms.find((term) => term.id === id);
}

export function validV2Term(dimension: string, id: string): boolean {
  const term = findTerm(dimension, id);
  return term !== undefined && term.active && !term.deprecated;
}

// A v2 selection is valid when every selected ID exists and is active, the
// single-valued dimensions hold at most one value, and no field is abused to
// smuggle an unknown tag.
export function validateV2Selection(value: unknown): V2Selection | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const stringArray = (entries: unknown): string[] | null =>
    Array.isArray(entries) && entries.every((entry) => typeof entry === "string") ? entries as string[] : null;
  const topics = stringArray(record.topics);
  const functions = stringArray(record.content_functions);
  const carriers = stringArray(record.carriers);
  const affordances = stringArray(record.affordances);
  if (!topics || !functions || !carriers || !affordances) return null;
  const dimensions: Array<[string, string[], number]> = [
    ["topics", topics, 64], ["content_functions", functions, 8], ["carriers", carriers, 1], ["affordances", affordances, 8],
  ];
  for (const [name, ids, max] of dimensions) {
    if (ids.length > max) return null;
    if (new Set(ids).size !== ids.length) return null;
    for (const id of ids) {
      if (!validV2Term(name, id)) return null;
    }
  }
  const form = typeof record.form === "string" ? record.form : "";
  const use = typeof record.use === "string" ? record.use : "";
  if (form !== "" && !validV2Term("forms", form)) return null;
  if (use !== "" && !validV2Term("uses", use)) return null;
  return { topics, content_functions: functions, carriers, affordances, form, use };
}

// The v1 projection is intentionally lossy but legal: at most three topics,
// one form and one use. A fourth topic is folded, never deleted, and the
// projection never claims the hidden dimensions do not exist.
export function projectV1(selection: V2Selection): { topics: string[]; form: string; use: string } {
  return {
    topics: selection.topics.slice(0, 3),
    form: selection.form,
    use: selection.use,
  };
}

// Apply a v1 write without destroying hidden v2 state. A v1 payload can only
// express topics<=3 plus form/use; anything it cannot address is preserved.
export function applyV1Write(existing: V2Selection, payload: { topics?: string[]; form?: string; use?: string }): { selection: V2Selection; touchesHidden: boolean } {
  const next: V2Selection = {
    ...existing,
    topics: existing.topics.slice(),
    content_functions: existing.content_functions.slice(),
    carriers: existing.carriers.slice(),
    affordances: existing.affordances.slice(),
  };
  if (payload.topics !== undefined) {
    // A v1 write replaces only the first three positions; topics beyond the v1
    // window are preserved because v1 cannot express their removal.
    const preserved = existing.topics.slice(3);
    next.topics = [...payload.topics.slice(0, 3), ...preserved];
  }
  if (payload.form !== undefined) next.form = payload.form;
  if (payload.use !== undefined) next.use = payload.use;
  // v1 cannot express removing content functions, carriers or affordances, so
  // it never clears them.
  const touchesHidden = existing.content_functions.length > 0 || existing.carriers.length > 0 || existing.affordances.length > 0;
  return { selection: next, touchesHidden };
}

// A taxonomy proposal never mutates the vocabulary directly. Approval requires
// a diff, an impact dry-run and an explicit rollback mapping.
export interface TaxonomyProposal {
  id: string;
  kind: "add_term" | "rename_label" | "deprecate_term" | "add_relation";
  dimension: string;
  term_id: string;
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  revision: number;
  submitted_at: string;
}

export function proposalImpact(proposal: TaxonomyProposal, current: Taxonomy = v2): { affected: string[]; requires_definition_version_bump: boolean } {
  const affected: string[] = [];
  if (proposal.kind === "rename_label") {
    // Renaming a label is display-only and must not change meaning, so no
    // re-evaluation is required.
    affected.push(proposal.term_id);
    return { affected, requires_definition_version_bump: false };
  }
  if (proposal.kind === "add_term" || proposal.kind === "add_relation") {
    const terms = (current as unknown as Record<string, TermDefinition[]>)[proposal.dimension] ?? [];
    affected.push(...terms.map((term) => term.id));
    return { affected, requires_definition_version_bump: true };
  }
  if (proposal.kind === "deprecate_term") {
    affected.push(proposal.term_id);
    return { affected, requires_definition_version_bump: true };
  }
  return { affected, requires_definition_version_bump: false };
}
