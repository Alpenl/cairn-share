# B05 / S2：单快照阅读接口（2026-09-29）

## 合同与实现

- `GET /api/enrichment/jobs/:id/reading` 仅接受 Enricher Token。一次 D1 `SELECT` 同时读取正文、当前有效选择、独立实体状态和五段缓存身份；不把 `links` 的来源缓存、租约或付费凭证带进查询结果。旧详情、选择和实体端点继续可用。
- `body_revision` 可选。与当前 `app_body_revision` 相同时，同一 SQL 用 `CASE` 省略原文和译文，响应标 `body_unchanged=true`；个人整理变化仍返回新的修订号、有效标签和实体状态。正文版本变化时返回完整正文。非法版本参数返回 400。
- 聚合选择复用原选择端点的同一映射函数。人工作用与实体状态均从这条快照计算，回执中的选择修订号和详情的 `personal_revision` 一致。

## 验证

- Worker 34 个文件、354 项测试通过；`tsc --noEmit` 和 Wrangler `deploy --dry-run` 通过。`enrichment-reading.test.ts` 覆盖 Enricher/App 权限、旧接口值等价、60k 字私人正文、正文版本相同的省略、个人状态变化、正文变化、非法参数和 404。
- 读取后立即由另一连接修改正文的夹具证明旧响应的正文与版本来自同一条 SQL，后续读取才看到新版本。真实本地 Wrangler/D1 与 Go 客户端的 `manualrestart` 场景验证跨进程读取及省略正文。

## 尚需验收

- D1 `rows_read` 和大历史下 SQL 耗时、Worker 内存、同负载前后端到端 p95 尚未测量；`.first()` 不提供本次语句的 `rows_read` 元数据，不能按零报告。
- 本次没有执行远端 D1 迁移、部署、付费调用或 14 天观察期。
