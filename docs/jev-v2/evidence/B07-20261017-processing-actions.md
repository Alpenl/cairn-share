# B07：Android 独立处理状态与持久化请求

2026-10-17，Asia/Shanghai。关联 [Share #31](https://github.com/Alpenl/cairn-share/issues/31)、[跨仓验收 #16](https://github.com/Alpenl/cairn-x-enricher/issues/16)。
接入 [Worker Draft #93](https://github.com/Alpenl/cairn-share/pull/93) 的[处理合同](../processing.md)，配对网关为 [Go Draft #59](https://github.com/Alpenl/cairn-x-enricher/pull/59)。
Worker 固定 `a54a57ec2e9371bc2b923f6cad38f4e90d4adf62`，Go 固定 `f081b31725233f7fdcab867773de6136d3a901b8`。
本批不改 Worker/Go 运行代码，不新增迁移；最后迁移仍为 `0068_tag_deletion.sql`。

## 行为

- 详情中的独立处理区只在明确打开或刷新时读取，分别显示来源、阅读队列及输出、分类队列及输出、人工记录；不新增首页请求或轮询。
- 按服务端当前能力提供补录完整主正文、阅读重试、分类重试。新请求绑定所见 fence、内容版本及目标；旧服务明确不可用，不转向管理接口。
- 确认前说明后续模型可能收费。保存正文是保存并排队，不能伪装成纯草稿保存。普通读取零模型调用。
- 发送前持久化完整原意图。超时、未标记响应、错误能力或不匹配回执均保持未知，不自动重发。再次打开、刷新、旋转和进程重建不发送 POST。
- 用户确认后，未知请求只能按原键及原内容核对。已知拒绝可采用新状态、继续编辑或丢弃；新意图不能覆盖另一实例的未知意图。丢弃需 CAS 核对实际存储，失败不先清空界面。
- 来源变化保留编辑内容，须明确采用新状态。恢复页显示持久请求的实际正文，不能把另一份未提交文本当作待恢复内容。迟到的丢弃结果不清理另一请求的文本。
- 完整账号指纹、会话代次、收藏及读取代次隔离状态。A→B→A 不复用旧会话响应；发送前再检查账号和删除状态。确认删除与请求清理共用 DataStore 事务，迟到请求不能重建收藏或草稿。
- 沿用 `cairn_curation_actions` 私有文件和既有备份/迁移排除，不存 token；有界 20 项，正文/JSON 按 UTF-8 字节限制。损坏记录明确失败，不解释为空队列。编解码及存储在 IO 调度器执行。

## 验证路径

| 层次 | 要求 |
| --- | --- |
| JVM | 严格解析、UTF-8、完整账号、落盘先于发送、未知请求不 drain；本地 165 项通过，零失败或 skip |
| 实际 HTTP | `ProcessingHttpInstrumentedTest`：真实鉴权和请求字节、跳转目标零访问、错误回执保持未知；真实 DataStore CAS、其他账号保留、删除墓碑 |
| 实际 ViewModel | `ProcessingViewModelInstrumentedTest`：真实 Repository/DataStore/HTTP；发送后换账号、A→B→A、落盘后换账号、准备中删除、迟到响应 |
| 实际 Compose | `V2CurationInstrumentedTest` processing 场景：生产 Activity/VM、编辑确认、拒绝、刷新、旋转、原请求恢复、多实例丢弃冲突及正确待恢复正文 |
| Worker/D1/R2 | `tests/android-worker/run.sh`：原 22 阶段全部保留，新增 3 个实际独立进程阶段；普通任务的专用 skip 不算通过 |

新增三个阶段使用真实默认 VM/Repository/DataStore、授权 Worker、实际 D1/R2：

1. 保存超过 24,000 UTF-8 字节的手工正文，真实提交后代理丢弃响应；客户端保留未知请求。核对来源角色、旧截断和上下文、原文、图片字节及旧阅读输出。
2. 强制停止后只读取不重发；显式确认同键同正文得到回执。受控夹具将两个队列置为完成，再由用户只重试分类。D1 核对来源/输入/快照各 +1，队列 epoch 合计 +2，阅读/媒体/人工记录不变，provider ledger 均为零。
3. 再次强制停止后通过真实 VM 删除收藏；草稿清除，迟到旧请求为已标记 404，图片读取不可用，来源及操作记录不复活。

完整设备任务和 25 个阶段均纳入 API26/API35 固定工作流，上传 JUnit、阶段日志、代理轨迹、原始 D1 前后 JSON。候选结果以代码 PR 的准确 CI/设备运行和 checkout SHA 为准。首轮 API35 的 25 阶段已全部实际通过；最终 Compose 丢弃护栏的完整结果另记于 PR 验收，不把较早运行追认为较新源码的证明。

最终生产路径的八项针对性 API35 用例全部实际通过：HTTP/真实存储 2 项、真实 ViewModel/账号/删除 3 项、Compose 恢复/编辑/丢弃冲突 3 项。它们不是完整设备矩阵的替代品。

## 范围与限制

队列已完成不等于已有输出与当前来源匹配，HTTP 成功不等于付费结果已持久化。测试没有真实模型调用、外部抓取或生产操作；Android harness 的队列就绪由明确夹具推进，不伪称在其中执行消费者。

固定后端另有 [Share CI](https://github.com/Alpenl/cairn-share/actions/runs/39003217726) 673 Worker 检查及 [Go CI](https://github.com/Alpenl/cairn-x-enricher/actions/runs/39003276383) 49 真实隔离场景、179 合同浏览器/55 真实栈检查。这里未重复运行未变动的后端场景，也不将它们当作原生 UI 证据。

本地首轮完整 API35 为 117 XML：91 通过、1 失败、25 专用 skip；后续真实 Worker 阶段未启动。新增账号恢复测试在确认成功后刷新详情，夹具却返回 404，导致正常删除保护清理状态，等待成功提示超时。补齐该收藏的真实详情响应，并增加详情确实刷新、草稿清除及提示仍存在的断言；没有修改生产删除保护或放宽期限。原失败 JUnit/日志保留，最终结果按准确候选运行核对。

初始候选 `41d63ec45c27f3d54361d1f317651eb4e8124b77` 的四项源码 CI 全通过；本地完整 API35 92 普通检查及 25 真实 Worker/D1/R2 阶段通过。远端首轮 API35 却在既有分类历史场景中中止：104 XML 为 78 通过、1 失败、25 skip，余下 13 项未执行，Worker 专用阶段未开始。JUnit 最终为 SlotTable 数组越界；完整 logcat 更早记录 `CalledFromWrongThreadException`，实际 `cairn-read` 线程在 `TestMonotonicFrameClock` / `FrameDeferringContinuationInterceptor` 中应用界面变化。销毁时的数组错误是后续异常，不能只加销毁等待掩盖。

按 [Android 官方测试迁移说明](https://developer.android.com/develop/ui/compose/testing/migrate-v2)，将该类的测试环境从已弃用 v1 改为现有依赖提供的 v2 `createEmptyComposeRule`，使用标准排队调度，避免在网络完成线程内联推进测试帧。没有升级依赖、修改生产实现、跳过原检查或放宽期限；修正后的本地及双平台完整运行另按准确提交验收。其余历史偶发 Back/IME 失败也不能因此追认为已证明同一原因。

迁移后本地 API35 整个 `V2CurationInstrumentedTest` 的 20 项实际运行全部通过（41.362 秒）。运行时与初始 41 候选逐字节相同，修正只涉及该测试环境和证据文档；完整候选仍要求双平台固定工作流通过。

完整零模型策略重放、全部旧新 App/Worker/flags 组合、真实 Web/App 竞争向量及最终独立复审继续开放。不关闭整个 B07，不 merge、转 Ready、签名、发布、部署、远程迁移或付费调用。开源发布另需用户明确同意。
