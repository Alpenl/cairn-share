# B05/S2：轻量阅读身份的局部交付

日期：2026-09-29。关联 [Share #30](https://github.com/Alpenl/cairn-share/issues/30)、[Enricher #13](https://github.com/Alpenl/cairn-x-enricher/issues/13) 与 [性能 #20](https://github.com/Alpenl/cairn-x-enricher/issues/20)。实现位于 Draft PR #32，Go/Web 配套位于 Draft PR #17。

Worker 详情 `/api/enrichment/jobs/:id?include_cache_identity=1` 原已返回版本；本批新增仅限 Enricher Token 的 `/api/enrichment/jobs/:id/cache-identity`。它用单条 SQL 读取内容、正文、个人整理、最新决定和实体版本，以及处理状态与更新时间；响应不含原文、译文、备注或模型正文。前端可在详情持续可见时按小响应检查，版本变后再请求正文。数据库查询成本仍须按 #20 基线测量，不能因为响应小就视为零开销。

测试用 6 万字符私人正文验证身份响应小于 500 字符、没有正文，版本与完整详情一致；个人整理变化可见，App Token 无权读取，未知 ID 返回 404。Worker 33 文件、352/352 测试、类型检查和 dry-run 通过；临时本地 Worker/D1 的 Go `manualrestart` 联调也读取并比较两种身份。无远端迁移、部署或付费调用。

S2 的正文、有效标签和实体状态单快照聚合接口尚未实现；本接口只负责轻量版本校验，不能据此勾选 S2 或 B05 最终验收。
