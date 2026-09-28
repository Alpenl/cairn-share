# B01/B02：Worker 付费尝试凭证与预算护栏

日期：2026-09-29。关联 [Share #28](https://github.com/Alpenl/cairn-share/issues/28)、[Enricher #11](https://github.com/Alpenl/cairn-x-enricher/issues/11)、[验收 #16](https://github.com/Alpenl/cairn-x-enricher/issues/16)。实现位于 Draft PR #32，Go 配套位于 Draft PR #17。

## 本地已实现

- `0040_enrichment_provider_attempts.sql` 持久保存每次实际 xAI POST 的 operation、租约摘要、内容版本、阶段/变体、请求摘要、状态与可得用量。凭证 INSERT 的触发器在同一事务中标记可能已计费。删除收藏会删除其私人凭证；canary 独立记账。
- 私有 `reserve`、`settle`、`authorize-fallback` 和列表/汇总查询只接受 Enricher Token。单次预留按租约所有权、剩余时长、阶段、内容版本和同阶段已存在尝试原子判断。每日硬上限初值为全局 500、每条收藏 10、canary 4 次；占用以预留次数计，未知结果不退还。相同 operation 只回读，不再发放发送权。
- 新领取和付费准入要求 `X-Cairn-Provider-Attempt-Ledger: 1`，握手声明新能力；来源保存与阅读完成必须有对应已结算 HTTP 200 凭证。预算耗尽但尚未生成凭证时，`budget-defer` 原子退还租约/尝试并设下次 UTC 窗口；和并发预留竞争时由 D1 守卫保证只有一边成功。
- 管理汇总按需返回未决数量、最早时间/年龄以及当日各阶段次数。它不进入每个业务请求的查询路径；私人正文、prompt、原始租约和响应正文不写入凭证或平台日志。
- Worker 应用请求日志用固定模板区分付费凭证预留、结算、降级授权和汇总查询；沿用 off/basic/diagnostic 热开关，不包含查询参数或请求正文。
- `0041_provider_reconciliations.sql` 新增人工核对审计。`POST /api/enrichment/provider-attempts/reconcile` 只能使用独立 `CAIRN_OPERATOR_TOKEN`，要求操作者、供应商账单或支持工单的外部证据编号，以及明确的 `confirmed_not_billed` 结论；普通 Enricher/App 凭据不能调用。仅当原尝试仍未结算、内容版本和租约均匹配、租约已过期时，原子记录审计并将收藏放回待处理队列。原尝试仍占用当日预算，同一 operation 永不能再次获准发送；失败路径保留租约身份供事后核对。缺少供应商证据时保持阻断，不因超时或 GET 404 自动释放。
- `0042_provider_daily_usage.sql` 把全局/启动自检及各阶段的每日发放次数保存在不含收藏身份的汇总表里。凭证 INSERT 在同一事务内增加次数；删除收藏清除私人凭证，但不退还已发放的全局额度。领取和预留读取单日汇总行，避免每次扫描当日全部凭证。每收藏额度仍从私人凭证按索引计算，收藏删除后相应私人计数一并消失。

## 验证

- Worker 32 文件、351/351 测试；TypeScript 类型检查与 Wrangler 部署 dry-run 通过。
- 测试覆盖同键重放、错误 operation、内容/租约失效、两种来源提示词的授权顺序、预算上限与拒绝、未决响应阻止重领、来源/阅读提交守卫、退还与预留竞争、人工核对权限/重放/过期守卫及事务失败回滚、删除私人凭证后额度仍占用及隐私删除。旧夹具现通过真实私有凭证接口模拟已知供应商响应。
- 真实本地 Worker/D1 与 Go 的 `providerledger`、`sourcelease`、`lifecycle` 联调通过。只在临时本地 D1 应用迁移，未改远端 D1。

## 尚未验收

- 人工核对解除未计费尝试的本地 Worker 路径已实现；仍需真实供应商证据、按 response ID 查询已保存响应、已计费但结果未落库的恢复、canary 对账和生产观察期。未决凭证保持阻断。
- OBS 要求的跨端事件/关联、独立指标/链路开关、采集故障和开销对比尚未完成。汇总接口可对账，但不能代替完整的业务事件。
- 上线时须先停止并排空旧 Go，再迁移 Worker、启动新 Go；尚未获得生产迁移、部署或付费调用授权。原复选框保持不变。
