# B07：已保留来源、实体与人工记录

2026-10-17，Asia/Shanghai。关联 [Share #31](https://github.com/Alpenl/cairn-share/issues/31) / [Enricher #16](https://github.com/Alpenl/cairn-x-enricher/issues/16)。
代码 [Share Draft #91](https://github.com/Alpenl/cairn-share/pull/91) / [Go Draft #57](https://github.com/Alpenl/cairn-x-enricher/pull/57)，分别叠加 #90 / #56。

| 身份 | 准确提交 |
| --- | --- |
| Worker / Android 运行代码 | `7a982de8fb7c793be2d7b524a37aca7cbb65705a` |
| 最终 Android 测试 | `303187fae360e1d1b1461e9d3d356f30a58851c2` |
| Go / 固定 Worker 合同 | `8a7ef5e46a850d56a017c3c97404c60768bd94cc` / 上述 7a |
| 最后迁移 | `0068_tag_deletion.sql`，本批无新增迁移 |

303 仅给既有分享测试增加原生窗口就绪前置条件；Worker 和 Android 主源码与 7a 逐字节一致。无生产部署、远端迁移、模型调用、merge、Ready、签名或发行；不签收完整 B07。

## 已实现范围

| 页面中的记录 | 既有权威存储 | 页序及内容 |
| --- | --- | --- |
| 来源快照 | `evidence_snapshots` | 不可变内容版本倒序；所选记录保留完整块结构、媒体引用、截断/完整性、来源 hash 和保存时间 |
| 实体结果 | `entity_operations` | 明确选择一个来源版本后，按不透明 operation key 的 SQLite BINARY 顺序分页；保留原始 payload、请求 hash、来源身份、outcome、applied |
| 标签决定 | `curation_overrides` | 自增 ID 倒序；保留 field/term/action/source/confirmed/revision 和操作身份 |
| 操作事件 | `curation_events` | 自增 ID 倒序；保留已有 why/status/其他动作及原始 payload，不用当前个人值重建旧事件 |

只读取仍保留的原始记录。缺失可能来自保留期或旧版本未记录，页面明确不能据此判断从未执行。人工决定与操作事件分别展示；旧 `legacy_unknown` / `confirmed=0` 显示来源不明、未确认，不升级为人工确认。`ignored_stale` 与原 `failed` 独立展示，不显示为 AI 成功。

App 与内部配套精确路径分别为 `/api/bookmarks/:id/saved-records/{sources|entities|overrides|events}` 和 `/api/v2/links/:id/saved-records/...`。两者复用同一只读处理器，分别保留 App / Enricher 鉴权；只允许 GET、显式 `X-Cairn-App-Saved-Records: 1` 与 version 1。

摘要最多 50 条、128 KiB，不读 payload；选中后只读取一个完整记录，来源上限 10 MiB、其他上限 2 MiB。keyset 翻页、重复/非法参数、收藏/来源/记录归属、UTF-8、响应界限严格校验。实体查询复用现有来源索引，无全库历史排序或新历史表。已删除收藏和错误来源拒绝读取；全部响应 no-store。旧服务明确 unsupported，不转向管理接口或全量历史备用路径。

## Android 与 Go

- 分类历史和新增四类记录共用浏览、取消、预览、文件导出组件，网络值保持原样，显示层转换已知状态。普通阅读不加载历史、不触发分类。
- 账号指纹、会话代次与收藏绑定组合生命周期；请求和导出有独立代次，关闭、切页、账号变化清除旧 payload/任务。未返回的文件选择器不能被新的 payload 复用。
- 原始预览明确限制 16,384 字符；用户显式导出所选完整 JSON，经实际 ContentResolver 写入。导出保存结构化原始内容与媒体引用，媒体二进制仍由原有私有读取链路管理。无复制剪贴板或自动上传。
- Go 精确代理同一版本/分页合同，保留 null/缺失值，不代填当前模型/来源；缺能力 501 与已知服务的不可用记录 404 分开。
- 历史 HTTP 读取曾跟随重定向。受控复现中两次读取都到达跳转目标；修正后目标零访问。分类和新增记录读取复用连接池、鉴权和计时，拒绝跳转，不修改共享 HTTP client。

## 准确验收

| 验证 | 实际结果 |
| --- | --- |
| Worker | 71 文件 / 620 测试、typecheck、dry-run 全通过；原数据/预算/运行计数不变，读取不发出 fetch |
| Android 本地工程 | 151 JVM、严格依赖校验、lint、两个 APK 全通过 |
| 最终本地针对性设备 | API35 四项实际 UI/HTTP 通过，覆盖四类记录、完整导出、未知/未确认、原分类历史与分页；API26 三轮既有分享双用例全通过 |
| 最终本地完整 API26 | 100 XML = 80 通过 + 20 专用 skip；之后 20 个独立 Android 进程 Worker/D1 阶段实际通过 |
| [准确 303 代码 CI](https://github.com/Alpenl/cairn-share/actions/runs/38994769509) | 四项全部成功 |
| [准确 303 设备矩阵](https://github.com/Alpenl/cairn-share/actions/runs/38994767857) | API26/API35 各 100 XML = 80 通过 + 20 专用 skip；各 20 个阶段随后实际执行通过，新增用例均在 XML 中 |
| [准确 8a Go CI](https://github.com/Alpenl/cairn-x-enricher/actions/runs/38994275775) | 五项全部成功；47 独立场景各一次（24+23），声明/完成标记/顶层 Go PASS 逐项匹配，嵌套用例未累加 |
| 浏览器与容器 | 179 浏览器检查、55 真实栈检查、独立 6/10/20 筛选/标签/性能检查完整各执行一次；amd64/arm64 build-only，push:false |

新真实联调覆盖 App Worker 与 Go 两条授权路径、50+5 分页、超过预览上限的原文、旧来源未确认、被忽略的实体结果、错误来源和删除后拒绝读取。文件选择器结果由 Instrumentation.ActivityMonitor 控制，实际 ContentResolver 写入临时文件并核对完整内容、null、false 后删除；这项证据覆盖写入链路，未验收系统选择器的交互界面或物理真机。

## 失败证据及解释边界

- 本地第一轮 API26 在既有大字体分享用例中点击后仍未选中：79 通过、1 失败、20 skip；实际 Worker 阶段未执行。三次保留原输入/断言的诊断复验均通过；诊断本身有同步/计时影响，已观察到的窗口有焦点、候选坐标与失败记录一致，不能认定唯一原因。最终仅增加 host 的 RESUMED/native focus 就绪检查，原点击、选中、保存/关闭断言与期限保持。
- 初轮 7a 远端 API26 完整通过；API35 的两个旧 systemBack 和一个旧 Topic IME 等待超时：77 通过、3 失败、20 skip，未执行该平台真实 Worker 阶段。303 全矩阵通过；本次没有将这些旧偶发故障追认为已证明唯一根因或永久消失。旧日志/JUnit/窗口安全标志和前后结果均保留，B07/OBS 稳定性继续跟踪。
- 较早本地 API35 广度运行也通过 80+20，发生在最终显示文案/导出护栏整理前，仅作过程证据；完整候选验收以上表准确远端提交为准。没有通过增加 skip、删除断言、改成语义回调或伪造网络条件获得通过。

原始日志、双平台 XML、20 阶段文件及逐项核对结果在受限验收目录，仓库只记录聚合结果和准确 CI 链接。原独立复审、全旧新/flags 组合、真实 App/Web 竞争、人工补材料与细分 retry/replay 能力仍开放；质量、物理设备、真实 OAuth 与开源/商业授权各自保留原门槛。
