# B01/B02：Worker 付费尝试凭证与预算护栏

日期：2026-09-29。关联 [Share #28](https://github.com/Alpenl/cairn-share/issues/28)、[Enricher #11](https://github.com/Alpenl/cairn-x-enricher/issues/11)、[验收 #16](https://github.com/Alpenl/cairn-x-enricher/issues/16)。实现位于 Draft PR #32，Go 配套位于 Draft PR #17。

## 本地已实现

- `0040_enrichment_provider_attempts.sql` 持久保存每次实际 xAI POST 的 operation、租约摘要、内容版本、阶段/变体、请求摘要、状态与可得用量。凭证 INSERT 的触发器在同一事务中标记可能已计费。删除收藏会删除其私人凭证；canary 独立记账。
- 私有 `reserve`、`settle`、`authorize-fallback` 和列表/汇总查询只接受 Enricher Token。单次预留按租约所有权、剩余时长、阶段、内容版本和同阶段已存在尝试原子判断。每日硬上限初值为全局 500、每条收藏 10、canary 4 次；占用以预留次数计，未知结果不退还。相同 operation 只回读，不再发放发送权。
- 新领取和付费准入要求 `X-Cairn-Provider-Attempt-Ledger: 1`，握手声明新能力；来源保存与阅读完成必须有对应已结算 HTTP 200 凭证。预算耗尽但尚未生成凭证时，`budget-defer` 原子退还租约/尝试并设下次 UTC 窗口；和并发预留竞争时由 D1 守卫保证只有一边成功。
- 管理汇总按需返回未决数量、最早时间/年龄以及当日各阶段次数。它不进入每个业务请求的查询路径；私人正文、prompt、原始租约和响应正文不写入凭证或平台日志。

## 验证

- Worker 32 文件、347/347 测试；TypeScript 类型检查与 Wrangler 部署 dry-run 通过。
- 测试覆盖同键重放、错误 operation、内容/租约失效、两种来源提示词的授权顺序、预算上限与拒绝、未决响应阻止重领、来源/阅读提交守卫、退还与预留竞争、隐私删除。旧夹具现通过真实私有凭证接口模拟已知供应商响应。
- 真实本地 Worker/D1 与 Go 的 `providerledger`、`sourcelease`、`lifecycle` 联调通过。只在临时本地 D1 应用迁移，未改远端 D1。

## 尚未验收

- 按权限记录的人工核对/恢复、供应商 response ID 查询、真实供应商用量核对及生产观察期仍待实现；未决凭证保持阻断。
- OBS 要求的跨端事件/关联、独立指标/链路开关、采集故障和开销对比尚未完成。汇总接口可对账，但不能代替完整的业务事件。
- 上线时须先停止并排空旧 Go，再迁移 Worker、启动新 Go；尚未获得生产迁移、部署或付费调用授权。原复选框保持不变。
