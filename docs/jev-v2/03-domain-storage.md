# B03 / 数据与内部契约：证据、运行历史、纯策略投影和人工事件

状态：待实现。总计划 https://github.com/Alpenl/cairn-x-enricher/pull/3 。base为B01分支；依赖B01安全实现，与B02握手fixture对齐。覆盖R01/R08/R09/R15/R16/R18–R21/R25/R28–R30/R37/R38。

## 范围与阶段边界

本批在Worker/D1新增可重放领域模型和v2内部API，B04据此实现Go evaluator/policy，B05负责可执行词表/公共投影。不能等B05完成才定义接口造成循环；先用冻结fixture使B04可独立实现。新增迁移、`worker/src`内按职责拆模块、测试/合成fixture及契约文档。表和端点名称可在设计提交中定稿，随后不能静默漂移。

保留旧links投影和旧内部协议作为受控兼容适配。按新增迁移落实，不改已发布0009；没有全库付费回填。

## 任务

- [ ] B03-T01 在实现前提交领域ADR与共享fixture：EvidenceSnapshot、QuestionSpec、Run、Decision、Override、CurationEvent、CurrentProjection。列出JSON schema、枚举、大小上限、null/空/未运行区别和错误码；锁定可复制的Go/TS golden vectors。
- [ ] B03-T02 拆content revision与personal/curation revision。客观证据只含原文和有来源角色的辅助块；note/why/status分开存。note-only不改变content hash，curation更新不使来源/阅读失效；URL/content变更保留人工历史并标当前适用来源已变化。
- [ ] B03-T03 证据快照支持block ID/role/text/source URL/关系依据/取得方式/时间/完整性/truncation。原文、作者续帖、引用、外链正文、第三方评论区分；旧context无法拆解时标legacy_unknown，不推断不存在的身份。store/retrieve可恢复同一评估输入。
- [ ] B03-T04 保存不可变问题规格与模型requested/resolved身份。hash定义符合EXECUTION；同hash不同字节拒绝。display metadata分开，改显示名不强迫重评。历史model未知时记录unknown，不填当前模型。B01target引用不可变spec。
- [ ] B03-T05 追加写入classification_runs：输入/问题引用、实际typed answers、usage、model、attempt、时间、idempotency key、coverage、结果状态。job只承载当前排队状态，不再承担唯一审计历史。失效不删除此前run；保留来源适用范围。
- [ ] B03-T06 独立decision记录绑定run(s)和policy版本，包含accepted/rejected/abstained及有依据的reason code。policy replay只追加decision和更新投影，不新建模型成功run、不修改source。partial run必须显式coverage，不允许缺答案伪装complete。
- [ ] B03-T07 原子提交run/decision/job/projection/cache invalidation。验证lease、input revision、target generation和spec；重复提交同key/payload返回既有结果，不同payload冲突。网络响应丢失可按operation ID查结果。旧job结果最多记录superseded，不改当前有效视图。
- [ ] B03-T08 实现字段/tag级覆盖及事件：accept/reject/set(empty可用)/reset。expected curation revision做CAS，唯一operation ID保证离线/重试幂等。why/status的PATCH不产生分类接受事件。人工reject在相同有效证据上的policy replay后保持；明确empty与未覆盖不同。
- [ ] B03-T09 定义legacy curation迁移：保留原整份选择，来源及确认行为标legacy_unknown，不据此生成可靠gold或替用户勾确认。旧接口能继续读写其可表达部分；旧写入不能清除v2隐藏字段，复杂映射B05补完但本批先建立保护测试。
- [ ] B03-T10 冻结并实现内部能力：读取target/spec、claim、提交/查询run结果、受控policy replay、取当前decision+overrides、提交curation operation、按cursor查询分类队列状态。端点version协商，旧strict clients不会被额外字段击穿；管理操作只允许内部权限。
- [ ] B03-T11 为B09准备通用扩展契约与实现：独立实体candidate/result生命周期，not_run/failed/completed_empty/completed_nonempty/stale；补证据块追加与revision更新；候选检索输入/返回授权边界；每条/全局预算与去重operation。无需本批实现Jev提取/重排，存储和API不能只留TODO。
- [ ] B03-T12 实现受控历史遍历/重放接口：显式ID或有界cursor、dry-run、最大条数、取消、目标spec、预算，默认不扫描付费队列。保存旧source以幂等方式登记但不自动调用模型；手动drop仍可按显式命令处理，自动任务不越权。
- [ ] B03-T13 私人数据生命周期：删除收藏级联/受控清理snapshots/runs/events/entity/caches；保留期清理不删除仍被当前decision引用的必要输入而造成假可复现。大快照大小与D1约束核实，必要时引用现有受控存储；权限隔离、脱敏日志、分页限制和JSON结构验证。
- [ ] B03-T14 本地迁移从空库和0009历史fixture演练；回滚旧应用读写兼容验证；Go/TS契约向量对齐。完成evidence/B03.md，给B04/B05固定companion SHA。

## 必须冻结的事件/失效矩阵

| 变化 | source/reading | objective run | personal/curation | projection |
|---|---|---|---|---|
| display label | 不动 | 复用 | 不动 | 重显 |
| decision阈值 | 不动 | 复用 | 不动 | 重放新decision |
| question含义 | 不动 | 新评估相应依赖闭包 | 不动 | 旧建议可标stale |
| source内容/URL | 新revision/按需获取 | 失效 | 保留并标适用来源变化 | 不让旧结果覆盖 |
| note/why | 不动 | 不动 | personal revision变化 | 更新相关维度 |
| 人工reject | 不动 | 不动 | CAS写event/override | deterministic resolve |
| 模型固定版本变化 | 不动 | 先评估、受控新run | 不动 | 人工批准后晋升 |

任何trigger可能同时触发两次revision的情况必须有测试，不能靠经验假定事务里调用顺序。source保存与classification队列注册应体现一次逻辑事件；非语义图片元数据变更是否影响state需要明确，而非每次写payload无条件重跑。

## 验收

总场景SC02/05–08/10–11/14–19/23–26/29–30。至少覆盖：两个相同并发complete只存一个run；source更新与complete交错；policy重放保持run和source计数；curation CAS冲突；reject和empty/reset；legacy unknown；删除隐私数据；空/历史库迁移；错spec/model/coverage被拒；正文大小与无效JSON边界；旧客户端不清v2字段。

执行Worker tests/typecheck/deploy:dry-run；添加能复现事务和触发器的集成测试。证据给出事务前后关键列、脱敏snapshot/spec fixture、跨语言hash向量、全部命令退出码与未执行项。禁止以mock数据库替代全部D1验证。

## 回滚

默认v2 opt-in关闭；应用回退仍读旧投影，新增runs与人工事件保留。停止新v2写入不等于删除历史，source始终保留。不能用破坏性down迁移删除新增用户内容；不可恢复的迁移必须先修成可兼容设计再继续。
