# B01 人工来源领取：本地 D1 查询计划

范围：`worker/test/claim-plan.test.ts` 在 workerd D1 中建立 2,000 条待处理 X 收藏，运行与来源领取相同的资格筛选和排序。此数据集用于检查查询计划与 `rows_read`；尚未代表生产 D1 的负载或延迟。

| 查询 | `EXPLAIN QUERY PLAN` | `rows_read` |
| --- | --- | ---: |
| 状态索引，`ORDER BY manual_priority DESC, id ASC` | `SEARCH links USING INDEX links_enrichment_queue_idx (enrichment_status=?)`，`USE TEMP B-TREE FOR ORDER BY` | 4,003 |
| 显式使用部分优先级索引，同一资格条件和排序 | `SCAN links USING INDEX links_manual_priority_idx` | 1 |
| 2,000 条均完成，显式使用部分优先级索引 | 同上 | 1（结果 0 条） |

生产 SQL 在同一候选查询中保留 `enrichment_status IN ('pending', 'failed', 'processing')`、来源资格和优先排序，并显式选用部分索引。回归测试检查查询计划不使用临时排序，且上述两种负载读取均少于 20 行。远端迁移尚未执行；生产负载的查询计划、`rows_read` 和响应时间仍需在部署前后的正式验收中记录。

## 付费阶段前的来源租约准入

`0033_source_paid_stage.sql` 为来源租约增加 `enrichment_paid_stage_started`。已在处理的历史租约和未声明新协议的旧 Go 客户端都按“可能已付费”处理；新 Go 领取时声明 `X-Cairn-Source-Lease-Admission: 1`。新 Go 在启动来源调度前必须通过内部 `GET /api/enrichment/source-lease-capability` 握手，因此滚动升级顺序为先 Worker、后 Go；旧 Worker 不会被新 Go 消耗任务 attempt。Worker 的 `POST /api/enrichment/jobs/:id/lease-admit` 在每次付费抓取或阅读调用前，检查租约令牌及覆盖请求时限和提交余量的剩余时间。

时间不足时，Worker 仅按当前令牌有条件地放回待执行队列。从未准入付费阶段的租约退还这次领取增加的 attempt；已经准入的租约保留 attempt。过期且未准入的租约被另一进程领取时同样不重复计数。旧客户端和迁移时的在途租约保守计数，避免把未知供应商调用误作零次。令牌已更换时不修改新租约。

`source-lease-admit.test.ts` 覆盖准入、短租约释放、退还与保留 attempt、最后一次尝试的过期重领、旧客户端、迁移时在途租约和旧令牌竞争。Go 侧在抓取与阅读前分别准入，释放后不启动该阶段，也不把此次领取报为完成或失败；`REQUEST_TIMEOUT` 的读取角色上限为 14 分钟，另留 30 秒提交余量。领取 SQL 的查询计划回归已同步新条件。

本地真实 Worker HTTP/D1 与 Go 客户端/处理器联调由 `CAIRN_INTEGRATION_CASE=sourcelease tests/local-integration/run.sh` 执行；抓取与阅读使用本地夹具，没有付费调用。它覆盖握手、领取、两次准入、来源/证据持久化与阅读完成。首次夹具缺少必填来源和阅读字段，Worker 分别以 `invalid_source`、`invalid_enrichment` 拒绝；补齐夹具后整条链路通过。

成本边界：每个实际付费阶段增加一次 Worker 请求和一次 D1 条件更新；同负载下的端到端延迟与 D1 用量仍须按 #20 第 0 组测量。供应商调用结果未知时的跨重启账本与自动恢复上限尚未实现，不能由此准入标记推断供应商未计费。未执行远端迁移或部署。
