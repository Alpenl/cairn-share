# OBS-03：Worker 日志策略刷新故障（2026-09-29）

Worker 的策略缓存原先在 D1 刷新失败后立即改为 off，即使该 isolate 已经读到一个有效策略。现在保留最近一次已确认的策略，5 秒后重试；响应同时标 `X-Cairn-Observability-Status: unavailable`，并继续报告已确认版本，不把旧版本冒充新版本。还没有成功读取过策略时仍按 off 处理。收到新的持久策略后恢复正常状态。

临时 diagnostic 仍按 `diagnostic_until` 在本地到期，随后使用原定的 basic/off 回落模式；D1 故障不能延长诊断窗口。测试覆盖已确认 diagnostic → D1 读取失败 → 到期回落 basic → D1 恢复并读到 off。日志输出、版本与失联标记逐项断言；首次读取失败继续有原有回归。

本地 Worker 完整测试 35 文件、361 项，TypeScript 类型检查和 Wrangler 部署 dry-run 通过。仅修改应用策略缓存，没有增加业务请求的 D1 读取或持久写入。

这解决的是已确认策略在短暂控制面故障中的运行行为。故障期间如果管理员在别处改为 off，该 isolate 无法获知新版本，因此状态必须显示 unavailable；实际切换仍以 D1 恢复后的读回为准。跨 isolate 的端到端开关时限、采集器、指标和链路独立开关、完整事件覆盖及观察期尚未验收。
