# 标签管理与合集自动收录

日期：2026-10-05。标签固定身份保持不变，显示名称与语义版本分开。源码目录保留为初始化种子，运行目录由数据库版本化保存。

- 网页与 Android 提供独立标签管理入口：搜索、使用次数、创建、改名、别名、定义、正反例、粒度、AI 开关、停用和恢复。新标签默认参与 Jev 独立判断，可单独关闭；人工打标不依赖 AI 开关。
- 定义变更保存不可变目录与操作记录，分类记录仍按原目录验证。显示变更不会要求重新推理。消费者自动载入新目录；变更默认只作用于待处理与新收藏，不自动付费重跑历史收藏。
- 合集由人类维护。合集可配置任一/全部标签匹配，按最终生效的标签精确判断，不使用关键词或名称猜测。规则默认作用于配置后新增收藏；已有收藏可预览后手动补收。
- 自动收录只加入，不删除已有归属；人工加入、备注和顺序保留。手动移出形成排除记录，除非人工重新加入，否则后台不再次加入。停用规则/合集不改变现有成员。
- 标签与合集的操作具有预期版本、稳定操作身份和冲突响应，网络重试不能重复变更。合集成员来源和匹配依据可查看。
- 自动规则由索引与有界持久队列执行，不调用模型；规则变更不影响正文/媒体缓存。Android 管理与规则信息参与本地缓存和同步。

验收：Worker 迁移、冲突/幂等、AI 开关、历史目录、手动排除、任一/全部、新收藏边界、补收和同步；Go 目录更新及现有付费预算保持；网页桌面/窄屏、Android 缓存/升级；原收藏与人工事实保持。发布 Worker 与 NAS 服务并提供签名 APK。

## 接口与更新

`GET /api/tag-catalog` 返回目录、全局 revision、使用次数和旧个人标签；`POST /api/tag-catalog/operations` 接收操作编号、预期 revision、类别和明确的人工意图；`GET /api/tag-catalog/history?dimension=topics&id=...` 查询定义变化。标签名称/别名最多80字符，含义1000字符，别名最多20个。新建细分主题自动补上基础判断边界与名称召回词，可再调整正反例。停用保留身份与历史；每个分类至少保留一个 AI 候选。

合集现有 operations 新增 `rule` 和 `backfill`。`rule` 保存启用状态、任一/全部、最多20个稳定标签引用，并以当前最大收藏ID记录新增边界。`GET /api/collections/:id/rules/preview` 返回可补收的前100条及版本；明确确认后 `backfill` 再检查最终标签、版本、排除和容量。继续补收时再次预览。规则配置与成员来源参与原合集增量同步。

0059 保存不可变目录和操作回执；0060 保存规则、人工排除和持久队列。分类或人工标签事务只标记受影响的收藏，后台每次有限处理，失败可续传。NAS每15秒唤醒；Worker的请求完成任务及原定时维护提供补偿。归属写入与合集/缓存 revision 同事务，正文缓存与模型账本不变。

Android `collections.db` 从2升级至3，单独保存当前账号的目录和一项待确认标签修改；原正文、媒体文件与游标继续复用。结果未知沿用原操作编号，明确拒绝后的意图不能因后续离线刷新而自动重提。

## 2026-10 重设计：规则 v2、标签合并与偏好

协议：合集接口接受 `X-Cairn-Collections: 1` 或 `2`，响应回显同一版本。v1 客户端行为不变，既看不到也不能修改 v2 字段；用 v1 修改规则时保留已有 v2 设置。

| 迁移 | 内容 |
|---|---|
| 0063 | `collections` 增加 `rule_exclude_tags`（排除标签，带任一个即不收）、`rule_admission`（`direct` 直接加入 / `review` 先进待审）、`rule_confirmed_only`（只认人工确认过的系统标签）；新表 `collection_rule_candidates` 保存待审候选，忽略过的不再提议 |
| 0064 | `tag_merges` 合并记录与 `tag_merge_queue` 逐条迁移队列 |
| 0065 | `preferences` 跨设备 AI 打标偏好（单行 + CAS + 幂等回执） |

接口（App 令牌走 `/api/...`；NAS 工作区用内部令牌走 `/api/v2/tag-catalog/...` 与 `/api/enrichment/...` 同名路径）：

- `rule` 操作新增 `exclude_tag_refs`、`admission`、`confirmed_only`（v2）。`backfill` 在待审模式下写入候选而非直接加入。
- `GET /api/collections/:id/rules/candidates?status=pending|ignored|accepted`、`GET /api/collections/review-summary`；操作 `review_accept` / `review_ignore`（`link_ids`）。合集列表多返回 `pending_review_count`，预览返回 `counts`（将加入、待审、已忽略、被排除标签挡住）。
- 列表筛选新增统一标签参数：`tags=system/topics/x,custom/default/<id>`、`tags_mode=any|all`、`tags_children=1`（上级主题同时匹配所有下级）。参数进入缓存键。
- 主题定义可写 `relations`：一个 `broader`（上级主题）和若干 `related`；拒绝环。`synonym` 只由合并写入。
- `POST /api/tag-catalog/merges`（`kind=system` 仅主题，需目录 revision；`kind=custom` 合并个人标签），`GET /api/tag-catalog/merges/:key`，`POST /api/tag-catalog/merges/:key/undo`。合并时来源标签停用并以同义关系指向目标、别名移到目标、规则引用改写；已有收藏逐条走普通标签操作（`replace` 或 detach+attach），每条都有自己的历史与撤销回执。撤销恢复目录与未被再次修改的规则，并对每条收藏调用它自己的撤销；合并后被人工改过的收藏保持人工结果。队列在请求后、写请求完成后和定时任务中分批处理。
- `GET /api/tag-catalog/usage`：每个标签的收藏数、最近使用时间、引用它的合集规则，以及最近 20 次合并。
- `GET /api/links/lookup?url=`：只读判断网页是否已收藏（按 URL 身份），返回标题、收藏原因、图片数和所在合集，供插件弹窗与安卓分享面板显示「已收藏」。
- `GET /api/preferences`、`POST /api/preferences/operations`：`ai_suggestion_limit`（1–8，默认 3）、`ai_confirm_before_apply`（默认关，保持现有直接生效）、`ai_low_confidence_review`（默认开）。分类流水线读取这些偏好在 cairn-x-enricher E4 中接入。
- `GET /api/links/legacy-dropped`：旧「整理状态 = 不要」的收藏数。界面已去掉整理状态，这些收藏依旧不进待读、AI 打标和规则，设置页只读提示。


## 2026-10-13：永久删除与停用分离（0068）

- 内置标签：`POST /api/tag-catalog/operations` 新增 `type: "delete"`，仍使用 UUID 操作编号、目录 `expected_revision`、`dimension`（`forms` / `uses` 使用复数）与 `id`。允许删除停用项，最后一个有效 AI 候选仍受保护。冲突不覆盖他人修改，同一操作重放不重复改变关系或修订。
- 同一 D1 事务移除当前目录定义及指向它的关系、清理有效标签索引，记录受影响文章的标签历史与个人修订。不可变目录快照、原文、笔记、分类运行/判断、人工操作历史、媒体和模型账本保留。历史目录仍能解释旧判断。
- 删除回执构成永久的身份屏蔽策略。0068 为回执增加部分索引并更新权威 SQL 视图；JS 折叠使用同一删除列表，计算提交时校验删除版本。旧客户端写入、重置、撤销或按旧词表完成的任务不能使该身份重新生效。无需逐篇 HTTP 请求、付费重判或后台全库重算。
- 引用该标签的合集规则在事务中移除引用并停用，清除未决规则候选。已有成员、备注、顺序保留。系统标签删除回执保存修改前的规则配置。后续规则写入和合并撤销再次检查删除身份，避免竞态复活。
- 自定义标签：新版 `DELETE /api/custom-tags/:id` 显式传 `permanent: true`，并按需传 `detach_all: true`。删除后从目录、工作区和新选择中移除；定义墓碑与审计 FK 保留，原名称可用新 ID 重建。未传 `permanent` 的旧客户端 DELETE 仍表示可恢复的停用，保持现有 8088/Android 协议。
- 发布先做完整 D1 导出/SQLite 恢复、0068 副本演练与原表哈希/权威索引对照，再应用迁移、发布兼容 Worker，最后发布独立 8089 UI。0068 未执行删除时不改写已有业务行；旧 8088 容器及配置不需要变动。发生删除后优先前向修复，勿回退到不执行 JS 删除屏蔽的旧 Worker；保留新增结构与用户后续写入，禁止用旧全库覆盖回滚。
