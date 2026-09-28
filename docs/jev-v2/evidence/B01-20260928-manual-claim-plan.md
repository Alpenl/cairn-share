# B01 人工来源领取：本地 D1 查询计划

范围：`worker/test/claim-plan.test.ts` 在 workerd D1 中建立 2,000 条待处理 X 收藏，运行与来源领取相同的资格筛选和排序。此数据集用于检查查询计划与 `rows_read`；尚未代表生产 D1 的负载或延迟。

| 查询 | `EXPLAIN QUERY PLAN` | `rows_read` |
| --- | --- | ---: |
| 状态索引，`ORDER BY manual_priority DESC, id ASC` | `SEARCH links USING INDEX links_enrichment_queue_idx (enrichment_status=?)`，`USE TEMP B-TREE FOR ORDER BY` | 4,003 |
| 显式使用部分优先级索引，同一资格条件和排序 | `SCAN links USING INDEX links_manual_priority_idx` | 1 |
| 2,000 条均完成，显式使用部分优先级索引 | 同上 | 1（结果 0 条） |

生产 SQL 在同一候选查询中保留 `enrichment_status IN ('pending', 'failed', 'processing')`、来源资格和优先排序，并显式选用部分索引。回归测试检查查询计划不使用临时排序，且上述两种负载读取均少于 20 行。远端迁移尚未执行；生产负载的查询计划、`rows_read` 和响应时间仍需在部署前后的正式验收中记录。
