# B07：App 受限规则预览与零模型应用

本增量提供服务端合同，不代表 Android 交互或整个 B07 已验收。普通阅读、原三种 processing 动作及其费用说明保持；只有用户明确打开此功能才读取能力，明确操作才准备预览或应用。不新增模型调用、采集、摘要、消费者唤醒、迁移或自动全库重放。

## 权限与配置

Worker 对 App 精确开放以下同源路径，先验证现有 App token，再验证 `X-Cairn-App-Policy-Replay: 1`：

- `GET /api/bookmarks/:id/policy-replay/capabilities`
- `GET /api/bookmarks/:id/policy-replay/preview?preview_key=...&preview_hash=...`；恢复准备请求时可省 hash。
- `POST /api/bookmarks/:id/policy-replay/preview`
- `POST /api/bookmarks/:id/policy-replay/apply`

普通 processing 状态中的 `policy_replay.supported=false` 不作为此独立执行器的授权依据。此功能必须明确读取自己的 capabilities，不能用已有管理接口绕过鉴权。

可选 `CAIRN_POLICY_REPLAY_URL` 指向 Go 专用执行器的基址，默认不配置、返回明确 501。生产使用 HTTPS；HTTP 仅允许本机回环供隔离联调。禁止 URL 用户信息、query、fragment，不接收 App 指定的地址，不跟随跳转，整个响应限 256 KiB、请求限 4 KiB、代理限时 15 秒。

Worker 仅向固定 `/api/app-policy/bookmarks/:id/{capabilities|preview|apply}` 路径发送现有内部 `CAIRN_ENRICHER_TOKEN`；不转发调用者 token、Cookie 或任意头。Go 在启动时通过 `SetAppPolicyToken(cfg.CairnToken)` 为这些专用路径启用私密 Bearer 鉴权及能力头检查。原 Go 管理 HTTP 不是 App 鉴权面，部署时只代理专用路径，不将整个管理服务暴露给 App。

Go 的 `CAIRN_ALLOW_DECISION_WRITE=1` 单独允许新决定；关闭时仍可读取预览和确认已应用回执。没有配置或目标不受支持，不伪造可执行能力。当前上线配置、secret、flags 和生产数据没有变化。

## 准备

```json
{"version":1,"preview_key":"durably-saved-client-nonce"}
```

nonce 为 1–100 位 ASCII 字母、数字或 `._:-`。准备先按 nonce 查询既有不可变预览或已应用回执；有记录就返回，不用当前来源或规则重新计算原意图。

首次准备由 Go 读取权威目标，解析其已注册不可变题目规格，再向 Worker 精确声明规格、词表、策略和模型能力；不能用部分声明的 `supported=false` 推断权限，也不能直接将它改成 true。两次目标必须相同。

只选择同内容、同规格/语义哈希/请求模型的完整已存运行，使用其实际历史 policy 作为原基线，纯函数重放至本地明确支持且与目标一致的已部署 policy。当前为部署的默认 v5；不接收 App 的阈值、spec、model、automatic 或迁移参数，不以默认值伪造历史基线。缺运行/历史 policy/有效题目或无法完整重放时拒绝，不补调用。

Worker 复用已有决策的完整来源/运行/规格/模型/目标/人工/投影 CAS，在既有 `classification_operations` 的 `app-policy-preview:` 命名空间保存不可变预览。仅增加这条元数据，不写决定、队列、人工事实或 provider ledger。预览包含当时完整有效视图的 before/after、内容/人工/目标版本及不透明 hash；内部执行计划和 review hash 不发给 App。

review hash 绑定投影输入、偏好值及版本、前后有效视图。预览中的人工结果保留，不把自动结果冒充最终人工结果；准备和最终提交都在 SQL 边界检查偏好版本。

## 应用与恢复

```json
{"version":1,"preview_key":"durably-saved-client-nonce","preview_hash":"<64 lowercase SHA-256 characters>"}
```

App 只能确认已准备身份。Worker 从原记录读取原计划，经原完整决策校验应用，不能接受新 policy、标签或模型。来源、目标、人工、偏好或有效投影已变化时冲突；原预览保留供核对，不自动换版本/改 nonce 后重提。

决定键包含收藏、nonce 和预览 hash，同请求并发只提交一次。先查已保存决定回执，再检查可变状态；所以提交已成功但响应丢失后，即使来源/人工/写开关变化或预览元数据被清理，也能核对原回执，不重新读取模型、不覆盖新编辑。决定原始运行仍不可变，人工覆盖和媒体/阅读内容不动。

只有与当前目标 policy 完全一致的决定可以满足对应队列目标；不重置预算、断路器或启动消费者。整个功能 `model_calls=0`。缺回执、损坏记录、未标记/不匹配/过大响应、连接错误或禁写时未确认的旧请求均保持未知，不自动重发，也不宣称原请求从未执行。收藏删除后不恢复来源/计划/决定。

客户端需先持久化原意图；准备丢响应按原 nonce 恢复，应用丢响应按原 nonce/hash 核对。打开、刷新、旋转和进程恢复只读取，不自动 POST。Android 完整交互、草稿/删除/账号隔离和设备验证仍待配套增量完成。

## 验证入口与边界

- Worker `optimization-contracts.test.ts`：11 项新增真实 D1 预览/幂等/回执/偏好与人工竞态、损坏记录及原合同回归；最终完整 74 文件/702 项通过，typecheck 与部署 dry-run 通过。
- Worker `policy-proxy.test.ts`：18 项鉴权、精确代理、私密凭据隔离、禁止管理参数、未知回执、跳转和 chunked 上限检查；错误条件从有效 applied 回执逐项变异。
- Go `internal/cairn/policy_preview_test.go` 与 `internal/dashboard/app_policy_test.go`：真实 HTTP、严格响应、无跳转/无 POST 自动重试、私有鉴权、部署策略、历史基线、写开关与丢响应恢复。
- `tests/local-integration/run.sh` 新增第 50 个 `appreplay` 场景，原 49 个 ordinal/分片归属保留。真实 App Worker → 私密 Go → Worker/D1/R2，真实提交后丢响应；更改来源/人工、禁写及删除预览元数据后恢复同回执，模型调用不增加、媒体/阅读/人工/ledger 保留。只初始建运行用本地 TypeSafe 合同替身，不是真实供应商质量或费用证据。

首轮真实协商因只声明 policy 而被 Worker 明确拒绝，未发生预览/应用；现先读取解析题目，再声明完整四项能力，原场景实际通过。早期定向测试的 401/403 预期和简化 selection/完整 view 比较差异、MIME 解析编译错误均保留在受限验收日志中。最终准确提交、完整 CI/设备/浏览器及 50 场景结果另按代码 PR 核对，不把局部通过签成全部原任务或独立复审完成。
