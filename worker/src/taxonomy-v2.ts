// B05: versioned multidimensional taxonomy and the v1/v2 protocol boundary.
//
// The v1 vocabulary (17 topics / 7 forms / 5 uses) keeps its stable IDs and
// historical meaning. v2 adds independent dimensions and richer term
// definitions, but every v2 projection must remain expressible as a legal v1
// payload so an old client can still read it.
import taxonomy from "./taxonomy.json";
import specificTopics from "./specific-topics.json";

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
  /** AI participation is independent from human selectability. */
  ai_enabled?: boolean;
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
  definition_version?: number;
  display_revision?: number;
  status?: "active" | "deprecated";
  /** Topic specificity guides display and selection, never inherited membership. */
  granularity?: "broad" | "specific";
  /** Whether this term is offered as a default navigation entry. */
  navigation?: boolean;
  /** Bounded retrieval clues; unlike aliases these do not assert equivalence. */
  recall_terms?: string[];
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
  resource_kinds?: TermDefinition[];
}

// Dimensions that may be selected independently. Topics, content functions and
// affordances are multi-select; carrier is single-valued by real structure.
export type Dimension = "topics" | "content_functions" | "carriers" | "affordances" | "resource_kinds";

export const MULTI_SELECT_DIMENSIONS: Dimension[] = ["topics", "content_functions", "affordances", "resource_kinds"];
// forms and uses are the v1 single-valued dimensions, retained for projection.
export type V1Dimension = "forms" | "uses";
export const SINGLE_SELECT_DIMENSIONS: Array<Dimension | V1Dimension> = ["carriers", "forms", "uses"];

export interface V2Selection {
  resource_kinds?: string[];
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
const legacyV2: Taxonomy = {
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

export function legacyTaxonomyV2(): Taxonomy { return legacyV2; }

// Historical completion validation uses the catalog its immutable run recorded.
export function classificationTaxonomy(version: string): Taxonomy | null {
  return [v2, previousDensityV2, previousTagV2, legacyV2].find(catalog => catalog.version === version) ?? null;
}

export function topicGranularityAware(request: Request): boolean {
  return request.headers.get("X-Cairn-Tag-System") === "1" && request.headers.get("X-Cairn-Topic-Granularity") === "1";
}

// Only metadata is negotiated. Stable IDs, meanings and exact memberships are
// identical for both client generations. Do not strip arbitrary run payloads.
export function termForTransport<T extends Record<string, unknown>>(definition: T, granularity: boolean): T {
  if (granularity) return definition;
  const { granularity: _granularity, navigation: _navigation, recall_terms: _recall, relations: _relations, ...legacy } = definition;
  return legacy as T;
}

const term = (id: string, label: string, description: string, excludes: string[]): TermDefinition =>
  ({ id, label, description, excludes, includes: [], aliases: [], active: true,
    definition_version: 1, display_revision: 1, status: "active" });

const previousTagV2: Taxonomy = {
  ...legacyV2, version: "2026-09-30.1", definition_version: 3,
  topics: [
    term("ai_coding", "AI编程", "AI 辅助开发、代码审查、调试、重构和专门的编程环境。", ["仅用 Codex 做图、写作或运行其他任务"]),
    term("agent_workflow", "Agent配置与自动化", "上下文、长期指令、工具接入、会话配置和任务自动化。", ["仅发布面向写作或生图的 Skill"]),
    term("image_creation", "图像生成", "生图、图像编辑、写真复拍、人物一致性和文章配图。", ["普通图片展示、网页 UI、视频动画"]),
    term("video_creation", "视频制作", "视频生成、动画、分镜、B-roll、录屏和剪辑。", ["网页加载动效、微交互组件"]),
    term("writing_creation", "写作与文风", "文章、小说、文风复用、去 AI 腔和表达方法。", ["材料仅是一篇长文、只涉及版式"]),
    term("ui_design", "界面设计", "网页和 App 的视觉、交互、设计规范、组件和微交互。", ["写真生成、普通产品发布"]),
    term("knowledge_workflow", "信息采集与知识库", "文章或聊天记录的采集、导出、归档、检索和复用。", ["单纯推荐社区入口、偶然提及 RAG"]),
    term("information_sources", "信息源", "持续信息来源、社区、站点、素材入口的筛选和导航。", ["单个工具发布、资料库的检索实现"]),
    term("model_practice", "模型训练与部署", "训练、微调、量化、部署和推理性能取舍。", ["普通云端 AI 使用、提示词文风蒸馏"]),
    term("creator_business", "内容运营与变现", "账号定位、选题增长、分发、商单和创作者接单。", ["一般写作技巧、软件星标致谢、证券投资"]),
    term("finance_resources", "投资理财", "行情、回测、资产配置、金融学习和金融平台开户资源。", ["接单收入、内容商单"]),
    term("document_layout", "文档与公文排版", "Word、WPS、DOCX、公文版式、模板和格式保真。", ["表达方法、网页 UI、训练用 PDF 提取"]),
    ...legacyV2.topics.map(t => ({ ...t, active: false, deprecated: true, status: "deprecated" as const,
      definition_version: 1, display_revision: 1 }))
  ],
  resource_kinds: [
    term("skill", "Skill", "明确介绍或提供可安装、可复用的 Agent 技能包。", ["只讨论 SKILL.md 配置文件、泛泛提到技能"]),
    { ...term("prompt", "提示词", "给出可复用指令、模板，或明确提供提示词集合入口。", ["只说 AI 可以完成某项工作"]), aliases: ["Prompt"] },
    term("software", "软件与服务", "可运行软件、CLI、插件、浏览器工具或 API 服务。", ["纯观点、单独 Skill、仅有开源链接"]),
    term("component", "代码组件", "可复用 UI、动画或交互代码组件和组件库。", ["普通设计图片、设计规范、视频动画"]),
    term("model", "模型资源", "模型权重、明确的训练实现、适配器或可运行模型项目。", ["仅介绍云端模型能力、仅引用模型名"]),
    term("reference", "参考资料", "明确可复用的规范、指南、模板、素材库或资源导航。", ["仅因为是一篇文章、泛泛认为值得参考"])
  ]
};

const previousDensityV2: Taxonomy = {
  ...previousTagV2, version: "2026-09-30.2", definition_version: 4,
  topics: [
    ...previousTagV2.topics,
    { ...term("clothing_style", "服饰与穿搭", "服饰品牌、款式、面料和穿搭选择的具体介绍、体验或评价。",
      ["只有价格或泛泛购物感想", "AI 生成服饰图片但不讨论服饰本身", "仅偶然提到穿着"]),
      includes: ["服饰品牌和款式评价", "面料体验", "穿搭选择"] }
  ]
};

const v2: Taxonomy = {
  ...previousDensityV2, version: "2026-10-02.1", definition_version: 5,
  topics: [
    ...previousDensityV2.topics.map(definition => ({ ...definition,
      granularity: "broad" as const, navigation: definition.active && !definition.deprecated, recall_terms: [] })),
    ...(specificTopics as TermDefinition[])
  ]
};

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
    ...(candidate.resource_kinds ? [["resource_kinds", candidate.resource_kinds] as [string, TermDefinition[]]] : []),
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
      if (term.granularity !== undefined && (name !== "topics" || !["broad", "specific"].includes(term.granularity))) {
        problems.push(`${name}: invalid granularity for ${term.id}`);
      }
      if (term.navigation !== undefined && (name !== "topics" || typeof term.navigation !== "boolean")) {
        problems.push(`${name}: invalid navigation for ${term.id}`);
      }
      if (term.recall_terms !== undefined && (name !== "topics" || !Array.isArray(term.recall_terms) ||
        term.recall_terms.length > 32 || term.recall_terms.some(clue => typeof clue !== "string" || clue.trim().length === 0 || clue.length > 120))) {
        problems.push(`${name}: invalid recall terms for ${term.id}`);
      }
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

export function findTerm(dimension: string, id: string, catalog: Taxonomy = v2): TermDefinition | undefined {
  const terms = (catalog as unknown as Record<string, TermDefinition[]>)[dimension] ?? [];
  return terms.find((term) => term.id === id);
}

export function validV2Term(dimension: string, id: string, catalog: Taxonomy = v2): boolean {
  const term = findTerm(dimension, id, catalog);
  // Legacy endpoints may preserve old manual values. New tag actions separately
  // enforce selectable status; no old meaning is mapped to a nearby new label.
  return term !== undefined && ((term.active && !term.deprecated) ||
    (dimension === "topics" && legacyV2.topics.some(t => t.id === id)));
}

// A v2 selection is valid when every selected ID exists and is active, the
// single-valued dimensions hold at most one value, and no field is abused to
// smuggle an unknown tag.
export function validateV2Selection(value: unknown, catalog: Taxonomy = v2): V2Selection | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const stringArray = (entries: unknown): string[] | null =>
    Array.isArray(entries) && entries.every((entry) => typeof entry === "string") ? entries as string[] : null;
  const topics = stringArray(record.topics);
  const functions = stringArray(record.content_functions);
  const carriers = stringArray(record.carriers);
  const affordances = stringArray(record.affordances);
  const resources = record.resource_kinds === undefined ? undefined : stringArray(record.resource_kinds);
  if (!topics || !functions || !carriers || !affordances) return null;
  if (resources === null) return null;
  const dimensions: Array<[string, string[], number]> = [
    ["topics", topics, 64], ["content_functions", functions, 8], ["carriers", carriers, 1], ["affordances", affordances, 8],
    ...(resources ? [["resource_kinds", resources, 6] as [string, string[], number]] : []),
  ];
  for (const [name, ids, max] of dimensions) {
    if (ids.length > max) return null;
    if (new Set(ids).size !== ids.length) return null;
    for (const id of ids) {
      if (!validV2Term(name, id, catalog)) return null;
    }
  }
  const form = typeof record.form === "string" ? record.form : "";
  const use = typeof record.use === "string" ? record.use : "";
  if (form !== "" && !validV2Term("forms", form, catalog)) return null;
  if (use !== "" && !validV2Term("uses", use, catalog)) return null;
  return { topics, content_functions: functions, carriers, affordances, form, use,
    ...(resources ? { resource_kinds: resources } : {}) };
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
    ...(existing.resource_kinds ? { resource_kinds: existing.resource_kinds.slice() } : {}),
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
