# Worker 应用日志控制

Go 的 `observe set-log` 先把带单调版本的策略存到私有卷，再用独立 Enricher Token 发给 Worker 的 `POST /api/internal/observability`。只有 Go 控制面应调用这个接口；App Token 无权写入。Worker 的 `0038_observability_policy.sql` 必须先在测试环境及获批的部署流程中迁移，Go 才能获得持久确认。响应丢失后，Go 重发相同版本和内容；不同内容的同版本或旧版本返回 409。

Worker isolate 首次业务请求读取配置，健康时缓存最多 30 秒；D1 读取失败时暂时关闭应用日志，5 秒后重试。`X-Cairn-Observability-Version` 是本次请求所用的版本；`X-Cairn-Observability-Status` 仅在未配置或读取失败时出现。诊断模式最长由 Go 限制为 1 小时，Worker 在到期时立即回落到原模式，不依赖下一次 D1 读取。

应用事件目前只有有界的 HTTP 摘要：固定路由模板、方法、状态、耗时、可得的响应大小和配置版本。缺少 D1 meta 时 `d1_stats` 为 `unavailable`；不会重跑 SQL 凑统计。每个 isolate 每分钟最多输出 120 条 basic 或 600 条 diagnostic 事件；若有丢弃，下一个分钟窗口出现可记录事件时输出上个窗口的丢弃数。完整的业务阶段事件、跨端 trace、D1 查询统计、可删除的私人事件存储和指标仍按两仓 issue 的 OBS-01–05 实现和验收。应用模式 off 不会更改 `wrangler.jsonc` 的 Cloudflare 平台采集开关。
