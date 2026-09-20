# B01 / Worker P0：权威目标、消费者隔离与局部失效

状态：待实现。总计划：https://github.com/Alpenl/cairn-x-enricher/pull/3 。先读总计划分支 `docs/jev-v2/{REVIEW,README,EXECUTION}.md`。本批覆盖 R01、R19、R22、R25、R38；不可把本文提交视为修复。

## 目标、范围、依赖

基线 share `5cf3b0d45c8fbae07d0fb5be1772e7d747c69b4b`。先于B02；与B03共享目标规格设计，但本批只做能独立验证的安全修复，不实施全部v2领域表。预期文件：`worker/src/classification.ts`、`worker/src/index.ts`、新增迁移（读取现有目录选择下一号，**不修改0009**）、Worker测试、内部契约fixture。

成功标准：版本不一致不会令消费者轮流把已完成任务重跑；note-only变更不丢原文；旧/新租约及重复完成安全；不改公共App字段。

## 分步任务

- [ ] B01-T01 检索实际claim/complete/fail/retry/sourceRoute、触发器和URL/note更新路径，记录文件与行号。先用真正Worker测试构造：同词表，A用policy-v2完成，B用policy-v1再claim，再A claim；证明基线可交替。SQLite最小复现只能补充，不作为D1行为唯一证据。
- [ ] B01-T02 冻结最小目标契约fixture：server desired spec（spec_id或hash、pinned/requested model、policy、generation）与consumer capabilities。目标来自受控服务器配置/管理操作，不接受claim的任意policy作为新目标。目标默认明确，不启动即全库换版本。
- [ ] B01-T03 新增迁移保存目标与job所绑定generation/spec。保留现有pending/processing/completed等生命周期，不把已完成历史自动全量入队。回滚目标用新的generation指向旧spec，不复用旧generation。已有job按明确兼容规则登记，不伪造历史审计。
- [ ] B01-T04 实现原子claim：只领取自身支持且属于服务器目标的任务，不能改变全局或其它job目标。旧consumer请求没有新字段时：在legacy模式只领取legacy目标；切到v2后返回明确不支持/空闲且不给v2租约。不能仅修改Go客户端而让旧二进制仍能复现循环。
- [ ] B01-T05 对complete/fail增加target generation/spec及input revision检查。target切换、URL/内容变更、lease过期、重复token都不能覆盖有效结果；未完成旧租约可保留失效审计但不产生当前classification。失效不消耗新目标的attempt。
- [ ] B01-T06 区分retry现有目标与主动重新分类到新目标。普通retry不改变server目标；支持显式ID/有界选择范围，不提供默认全库重排。活跃lease不被随意抢占；冲突返回可解析reason code，不包含内容。
- [ ] B01-T07 找到note更新导致source/reading清空的所有路径，拆URL变化与note-only变化。note-only保留enrichment_sources、正文、译文、图片；当前legacy含note的分类可以失效，B03/B04后进一步仅失效personal维度。URL变化仍使源文过期并正确等待source，人工curation/why/status保留。
- [ ] B01-T08 给重复完成定义幂等响应。相同operation key与payload的已提交结果可查且可返回；相同key不同payload冲突。事务中不能出现links已更新但job未完成、或反之。协议在B02客户端实现前先存fixture。
- [ ] B01-T09 定义错误码：capability_mismatch/target_changed/input_changed/lease_expired/already_completed/configuration_error/transient_error等，映射HTTP语义；不要只剩通用409。对于legacy接口保留原shape或使用协商，避免旧strict decoder误解。
- [ ] B01-T10 更新Worker文档、迁移说明及与B02的握手兼容表。所有配置先本地，远端迁移和部署不执行。提交 `docs/jev-v2/evidence/B01.md`。

## 契约不变量

```text
claim -> job(input_revision, target_generation, spec_id, lease_token, expiry)
complete guard = same job + same input + same target + valid lease + expected state
consumer declares supported specs; consumer NEVER chooses global desired spec
```

目标变更来源必须可审计，只能由已授权管理途径或部署配置触发，不能暴露给App token。D1 batch/trigger中的比较必须与同一事务内状态一致。避免在事务外先读目标、之后无条件写入的TOCTOU。job历史版本不直接决定是否再次入队，入队由显式目标/输入事件决定。

## 必须新增的验收用例

| 用例 | 断言 |
|---|---|
| A/B交替20轮 | 完成目标只执行一次；旧consumer无法变更generation或重置attempt |
| 两个兼容consumer并发claim | 同一任务最多一个有效租约 |
| claim后改目标 | 旧complete不改links.classification，新目标可正常处理 |
| claim后改note/URL | revision处理符合当前协议，旧结果被拒绝，note-only原文仍在 |
| lease过期后新consumer完成 | 旧lease不能回写，new attempt有界 |
| complete响应丢失后重试 | 相同结果幂等，分类/事件不重复；不同payload冲突 |
| active lease下retry | 不抢占或按明确策略冲突，不能创建双有效lease |
| 无历史source、drop记录 | 不隐式全库回填，自动队列仍尊重drop |
| 目标兼容开关off/on | 原有请求可用；v2开启时旧consumer被安全隔离 |
| 源文/人工整理保护 | URL修改保留人工数据，note修改不触发重新抓取 |

对应总场景 SC01、SC02、SC05、SC11、SC12、SC23、SC25、SC30。

## 执行与证据

先`npm ci`，运行精确新增Worker测试观察基线失败；修复后`npm test`、`npm run typecheck`、`npm run deploy:dry-run`。新增迁移分别在空本地库和已应用0009的fixture库测试，保留数据计数、关键字段和rollback-app兼容结果。不存在的target先实现，不记录虚构命令。

提交建议：①失败回归与目标fixture；②迁移和claim/complete；③局部失效及错误/幂等；④全回归和文档。证据包括两仓SHA、测试命令退出码、目标切换序列的脱敏状态、模型调用0、未部署声明。

## 回滚与不能做的事

保留新增表/列，回滚应用走明确legacy模式，不能回滚到允许旧consumer抢新任务的混合配置。无人工批准不启用生产目标迁移。不得靠加attempt上限掩盖来回重跑、不得每次claim无条件改policy、不得取消revision/lease检查换取通过。B03后续可能扩展数据，但本批安全不变量必须持续通过。
