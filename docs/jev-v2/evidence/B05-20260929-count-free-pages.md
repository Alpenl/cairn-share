# B05 / D2：不需要计数的列表页（2026-09-29）

`GET /api/enrichment/jobs` 接受 `counts=0|1`；不传和 `counts=1` 保持原有列表＋计数合同。`counts=0` 只执行列表 SQL，响应省略 `counts`，继续返回原有游标和过滤合同版本。非法值及重复参数返回 400。全量计数路径仍把列表和计数放在同一个 D1 batch，维持同一快照。

Worker 测试以真实本地 D1 和 SQL 记录器核对 `counts=0`：带有效标签筛选的第一页与下一页游标正确，只有一条 `FROM links` 列表 SQL，没有 `COUNT(*)` 语句；默认计数的原有测试继续通过。完整 Worker 34 文件、355/355 测试、类型检查和 Wrangler dry-run 通过；本地 Wrangler/D1↔Go 联调验证 Go 在重启后读取无计数页。

这是 D2 的局部交付。单查询 overview、generation 缓存、覆盖索引，以及同负载 `rows_read`/p95/内存尚未完成。未部署或迁移远端 D1。
