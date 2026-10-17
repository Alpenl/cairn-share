# B07：独立处理状态与显式来源补录合同

Worker 合同及配对 Go 网关见 Draft #93 / Enricher Draft #59。Android 的 Repository / ViewModel / Compose、持久化处理动作与真实进程恢复见[客户端增量](evidence/B07-20261017-processing-actions.md)。完整 B07、策略重放交互和最终独立复审继续按原 issue 执行。没有部署、远程迁移、真实模型调用或版本发布。

## 读取

`GET /api/bookmarks/{id}/processing`，必须带 `X-Cairn-App-Processing: 1` 和 App 授权。内部网关使用相同合同 `/api/v2/links/{id}/processing` 及内部授权。只允许这一条精确路径，不能借 App token 访问目标、模型、问题规格或迁移管理。

响应 `version=1`、`Cache-Control: no-store`，包括：

- `fence`：所观察的来源、媒体、队列、目标、人工版本及付费结果状态的指纹。
- `content_revision`、可空 `evidence_snapshot_id/source_hash`、`target_generation`。
- `stages.source/reading/classification/human`，分别表示来源、阅读、分类与人工记录。队列状态与已有输出状态分开。
- `actions.save_primary/retry_reading/retry_classification`：`allowed`、准确的 `blocked_reason`、`queues`、`model_calls_now=0` 及 `may_call_model_later=true`。
- `max_text_bytes=100000`、`model_calls=0`。Worker 自身没有本地策略执行器，`policy_replay.supported=false`；不能冒充零模型重放已经实现。

仅详情明确打开状态区时读取；不新增首页请求、后台轮询、隐式重试或模型调用。服务器只能确认队列合同，不能证明某个 Go 消费者此刻在线。

阅读已有值没有可核对的完成记录时为 `unversioned`，不伪造来源版本。分类区分 `absent/unversioned/partial/current/stale/failed/unknown`；`current` 需要完整覆盖、相同来源快照、来源哈希、内容版本和目标。`result_unknown` 优先于普通队列状态。

## 写入

`POST` 同一路径、同一能力头。只接受以下六个必填字段；`save_primary` 额外要求 `text`，其他动作禁止 `text`：

```json
{
  "version": 1,
  "operation_key": "persisted-action-nonce",
  "fence": "<observed 64-character lowercase SHA-256>",
  "action": "retry_classification",
  "expected_content_revision": 3,
  "target_generation": 1
}
```

操作键为 1–200 位 ASCII 字母、数字或 `._:-`。正文需有效 Unicode、非空白且不超过 100000 UTF-8 字节；JSON 最多 128 KiB。目标代次 0 必须显式存在，不能以缺省代替。

### `save_primary`

仅在主正文缺失、当前没有已有 primary block、当前 v2 目标已注册且不存在活跃租约或未核对付费结果时可用。

保存**完整手工正文**作为唯一新 primary，标记人工来源；保留已有未知图片文字、上下文、截断标记及旧快照未知字段。旧的来源 checkpoint 若被替换，其原始 JSON 字节保留在新不可变快照中。旧图片、链接、标题、简介、译文、人工记录和历史运行均保留。历史 NULL / JSON null 外链列表仅在本次来源更新中归一化为 `[]`，避免后续阅读又制造一次来源变更。

在同一事务中保存原文、阅读 checkpoint、不可变来源快照、分类队列及回执。内容版本与分类输入版本只前进一次；兼容旧触发器的多次队列触发最终归并为一次队列 epoch。X / Twitter 进入现有阅读队列，其他站点只入分类队列，不虚报阅读支持。

按钮必须在用户确认前说明：**保存正文并排队处理，保存本身零模型调用，随后阅读或分类可能收费**。不能把它呈现为纯草稿保存，更不能在普通读取时自动执行。

### `retry_reading` / `retry_classification`

只重置指定阶段的队列，来源快照、其他阶段、历史结果与人工决定不变。活跃租约、已排队、无主来源、未注册 v2、已排除收藏或对应阶段结果未核对时拒绝。阅读仍受现有 X / Twitter 消费者范围和 100 项手工队列上限约束。排队不重置模型预算或断路器。

两个阶段的结果不明与活跃状态独立判断：阅读结果不明不阻止相同来源的独立分类重试，反之亦然。来源写入涉及输入变更，两个阶段都必须先核对。

## 回执、并发和失败

`classification_operations` 以独立 `app-processing:` 命名空间保存操作指纹和终态回执，沿用现有删除级联，无新增表或迁移。中间 `app_processing_applying` 标记仅在一个事务内存在；终态为 `app_processing`，不能被再次当作写入许可。

同键同请求先返回原回执，再检查当前来源和租约；同键不同请求冲突。新键带旧 fence 同样拒绝。事务内重新核对内容、媒体、来源 checkpoint、快照、目标、人工版本、队列租约/epoch、付费状态和容量。任意后续写入失败，来源、队列和回执一起回滚。

HTTP 成功不等于结果已入库。缺少调用结果、未知 HTTP / 用量，或成功调用没有匹配运行/完成回执，均先核对。正常 Go 完成键的精确回执或包含实际 reservation key 的成功运行才是已持久化的依据；不按相似时间、同名模型或另一代次的成功猜测。终态回执在运行归档后仍能证明正常完成。

客户端先持久化原意图再发送。超时、断线、未标记响应、损坏或不匹配回执都保留为未知，禁止自动重发或换键；仅用户确认后用完全相同请求核对。已知冲突保留正文，重新读取并明确采用新状态后才能创建新意图。换账号、删收藏、退出、旋转和进程恢复仍需实际 Android 路径验收。

Go 网关不跟随重定向、不自动重试 POST，验证能力、来源版本/目标、回执身份和响应体上限；仅首次确认的指定阶段入队才唤醒相应调度器。读取和回执重放不唤醒。

## 验收入口

Worker：`worker/test/processing.test.ts` 与 `manual-material.test.ts`，随后完整 Worker 回归、类型检查和部署 dry-run。

Go：客户端/网关竞态测试、`make verify`，以及 `tests/local-integration/run.sh` 的 `processing` 实际 Worker/D1/R2 场景。该场景通过真实网关丢弃提交后的 HTTP 响应，再确认原回执，执行实际阅读与分类消费者，核对媒体、人工优先、独立状态及没有重复入队。仅模型端点和阅读结果使用合同夹具，不能据此宣称真实模型质量已验收。
