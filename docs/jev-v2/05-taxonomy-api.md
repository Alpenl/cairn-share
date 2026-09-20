# B05 / 标签 v2、兼容投影、分面检索与治理 API

状态：待实现。总计划 https://github.com/Alpenl/cairn-x-enricher/pull/3 。base B03 #25；使用B04 https://github.com/Alpenl/cairn-x-enricher/pull/5 的冻结问题契约。覆盖R03–R06/R08–R09/R13/R19/R26–R33/R37–R38。

## 范围

Worker词表、curation/分类v2校验、公共App与NAS协商读取、筛选/搜索/分页/导出数据、缓存、实体/重排/词表治理接口。沿用D1与现有鉴权，不把向量库/FTS升级设为前置条件；按实测数据决定索引，不能顺手重写所有API。预期文件`worker/src/taxonomy.json`、`curation.ts`、`classification.ts`、`index.ts`及新职责模块/迁移/测试。

## 词表设计冻结

| 维度 | 含义/基数 | v1处理 |
|---|---|---|
| topics | 内容领域，多选 | 展示投影取明确策略下的最多3个 |
| content_functions | 方法/工具/案例/数据/观点，可并存 | primary_form投影单个，语义选择规则固定 |
| carrier | 单帖/作者连续帖/外链文章/unknown，优先来源结构 | thread/longform仅在明确载体事实支持时映射 |
| affordances | 引用材料/实践参考/背景资料/创作素材，可并存 | primary_use兼容投影 |
| user intent/status/stance | 人工明确意图、整理流程及针对主张的立场 | 保留旧curation/why，不自动猜测 |
| facets | 评估等跨领域方法维度，受控多选 | eval旧ID保持历史可读，明确mapping |

首次改造不任意扩大词表。已有稳定ID不改义：llm/AI/agent等宽窄关系从aliases拆成真正同义/上下位/相关；eval迁移方案写明legacy语义、映射版本及查询兼容。若现有标签无法无损拆分，不自动补填新细标签。

## 任务

- [ ] B05-T01 基于现有17主题/7形态/5用途梳理每个term的定义、正例、反例、边界、同义/层级/相关关系。产出v1->v2显式mapping，记录保持、拆分、停用、不确定迁移；不得用当前显示名推断历史语义。
- [ ] B05-T02 实现versioned taxonomy v2 schema，definition/includes/excludes/examples/relations与display分离。校验ID稳定、别名无冲突、层级无环、引用term存在、active/deprecated规则。词表是唯一可执行来源，Go/Web/Android使用同一ID/版本合同。
- [ ] B05-T03 实现多维分类校验和局部状态；不再用缺form/use强制全局uncertainty。accepted/rejected/abstained、not_run/failed/stale、not_applicable/insufficient_evidence分清；依据不足时reason unknown可用，不能瞎归类。
- [ ] B05-T04 实现有效投影resolver，人工优先，区分unset/empty/reject/reset。保存why/status不动labels，不产生接受事件。每字段返回origin（AI/manual/legacy）、revision、decision引用及可选候选，原始大分布不塞进所有列表响应。
- [ ] B05-T05 新API显式opt-in/version协商，旧六字段和旧include=enrichment的key/type/行为保持。v1 compatibility projection把多维结果投为topics/form/use，保留稳定选择顺序；旧strict Go客户端不被新增字段破坏。拒绝不支持版本时错误契约清晰。
- [ ] B05-T06 实现v1写入适配：只影响其明确表达的旧维度/可见标签，不清空隐藏v2维度、第四个topic、拒绝或实体状态。用服务端当前v1 projection和expected revision判定差异；存在旧协议无法表达的歧义则保护数据并返回可操作冲突，不猜用户要删所有v2值。classification:null保持旧“恢复自动分类”范围，不删除why、事件历史或无关v2数据。
- [ ] B05-T07 列表/详情支持内容处理、分类处理、人工整理三种状态。字段弃权和队列失败分别筛选；提供仅分类重试/仅policy重放的受权限限制接口。列表采用有界summary，详情按需获取候选/依据/分布；分页cursor包含相关representation/排序约束。
- [ ] B05-T08 多维分面与关键词组合：同维OR/跨维AND（在合同明确冻结）或保留既有单值兼容语义；主题/功能/载体/潜在用途/人工状态可组合。查询参数校验、防LIKE通配符绕过、参数化SQL；无效/停用标签处理明确。统计与结果都按有效人工覆盖后分类计算。
- [ ] B05-T09 搜索覆盖原文/译文/摘要/标题/实体/备注/人工原因，来源版本与状态可解释。为B09重排提供有界候选接口（ID、受控文本块/摘要、来源角色、原排序和cursor/session信息），权限和过滤先完成；不得把未召回文档算作重排收益。
- [ ] B05-T10 接通B03实体独立状态与候选结果接口：not_run/failed不会写空覆盖同revision成功结果，新的completed_empty有明确成功来源；source改变标stale。surface entity与canonical entity区分，未知实体不自动认定同名人/项目，人工修正可持久化。
- [ ] B05-T11 给B09补证据/词表提案提供工作流接口：明确任务范围、source revision、预算/去重、pending/approved/rejected状态；提案不直接改可执行taxonomy。变更词表需明确批准、版本diff、受影响查询/问题集合、dry-run与回滚映射；display-only不触发模型。
- [ ] B05-T12 缓存按representation+content/decision/curation revision失效；App与NAS过滤/详情/搜索/导出一致。分类完成、人工修改、实体完成都触发恰当失效，但不会清空无关source。列表分页有稳定排序，重排若跨页应冻结session或清楚限定只重排当前候选集。
- [ ] B05-T13 更新Markdown导出数据契约：保留完整有效v2字段、人工原因、来源和未加载说明；partial export不冒充全库备份。v1旧导出仍可读，扩展字段明确标识AI建议/人工选择和stale。
- [ ] B05-T14 Go/TS共享fixture、旧新App/Go返回shape与PATCH矩阵、本地迁移/回滚、筛选性能基线、token权限/恶意payload测试。完成evidence/B05.md，向B06/B07/B09提供固定contract SHA。

## 关键验收组合

四topic底层保存而卡片显示3；tool+method+data与thread同时表达；已确认空use正常completed；只修改label零重评；停用term历史可读；eval旧筛选找到正确历史但不伪造新细分类；旧客户端保存why不带分类；v1修改一个可见tag不丢隐藏tag；v2 reject不被v1投影重建复活；source/decision/curation/entity更新正确清缓存；查询过滤与导出字段一致；候选接口不会越过权限/筛选；词表提案未批准不生效。

总场景SC03/06–08/13–16/19/21/23–25/29–30。完整`npm test`、typecheck、deploy:dry-run；只为当前变更新增必需索引并保留EXPLAIN/有界数据量测试。大库性能不得以十条fixture成绩宣称已解决。

## 回滚与禁止项

v2 API和新词表默认受控启用；旧public shape永远不是随意扩展口。回滚关闭新view并保留v2存储/人工事件，不把所有数据反向压平到v1。禁止删除旧term ID、隐式同义词扩张、自动生成大量标签、把contra当作者观点推断、用全局uncertainty掩盖未实现字段级决策。
