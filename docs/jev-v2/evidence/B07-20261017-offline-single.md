# B07 局部验收：离线单值 A→B→A 与正式状态恢复

日期：2026-10-17（Asia/Shanghai）。对应 [#31](https://github.com/Alpenl/cairn-share/issues/31)
的 R3-07 / R3-04；[Draft PR #86](https://github.com/Alpenl/cairn-share/pull/86)。
基线 `c541e2f2d9e2db1c4ec0c01610ca83b48ceef76c`，受测源码
`a397df9f70ebebf5f6f9a9a2fa3b087ca2488cf7`。只修改 instrumentation 测试；
Android/Worker 运行逻辑、依赖与迁移保持不变。

## 场景与断言

已有真实服务夹具覆盖多动作、丢响应和两次冲突，本批补齐单值连续替换：

1. 同收藏离线保存七条不同 operation key 的意图：主题 accept/reject、载体
   `single → external_article → single`、潜在用途 `set_empty`、主题 `reset`。
   检查 DataStore 顺序、前序依赖及离线草稿仅有最终载体 `single`。
2. 第一条真实提交成功但丢失响应，结束进程后以原 key 重放确认。
3. 第二条提交前，独立授权客户端写入真实 Worker/D1，触发 CAS 冲突；明确重应用时
   再发生一次独立写入并再次冲突。随后恢复，第三条之前断网，剩余五条仍持久保存。
4. 再恢复后，七条意图加两次独立写入得到 revision 9；服务端载体严格为 `[single]`，
   主题和潜在用途为空。草稿/冲突清除后，App 正式 selection 也必须是 revision 9
   和同样结果。其他账号动作仍保留且未被发送。

业务响应来自真实授权 Worker/D1；故障代理只控制传输与独立写入时机，不是假 Repository。
独立客户端使用真实 HTTP 人工接口，**未执行浏览器 Web UI**。

## 实际执行

| 门禁 | 结果 |
| --- | --- |
| 严格 debug / androidTest APK 构建 | 通过 |
| `testDebugUnitTest lintDebug connectedDebugAndroidTest`，本地 API26 | 131 unit、66 普通设备测试通过，0 失败 |
| `connectedDebugAndroidTest`，本地 API35 | 66 普通设备测试通过，0 失败 |
| `tests/android-worker/run.sh`，本地 API26 / API35 | 各 18 阶段全部通过，每阶段为独立 Android 进程 |
| [准确提交的完整 CI](https://github.com/Alpenl/cairn-share/actions/runs/38964143113) | 四项通过；Worker 67 文件 / 607 测试 |
| [同提交远端 API26 / API35 矩阵](https://github.com/Alpenl/cairn-share/actions/runs/38964176292) | 两平台各 66 普通设备测试、18 真实 Worker 阶段通过；下载原始 JUnit 与阶段日志逐项复核 |

普通 connected 的 JUnit XML 各为 84 条：66 通过、18 个专用方法因没有 Worker 地址跳过。
专用 harness 随后逐一执行这 18 个方法，各有 `OK (1 test)`。不将普通任务的 skip 当成
执行证据，也不重复累计 Gradle 进度行。

本地为 Linux x86_64 / JDK21.0.10 / Node22.22.2 / SDK37 编译，专用模拟器分别为
Android 8.0 / Android 15；远端工作流用 JDK17。两本地平台均实测 Wi-Fi 为 VALIDATED
且 NOT_METERED，没有关闭网络约束或用本地 204 冒充公网检测。

首轮 API26 的首个 `/__test/control` 请求返回 502，尚未进入业务场景。修正专用模拟器的
系统代理回环排除并重启后，原测试提交全部 18 阶段通过；随后加入正式状态断言并在
两个平台完整重跑。失败原始记录保留，没有改应用代码或放宽断言。

## 边界与收尾

新增模型调用 0，无生产访问、收费、部署、远端迁移、签名或版本发行。本地仅使用合成
收藏、独立 D1/R2 及原有专用测试 AVD；设备和回环服务均已停止，AVD/数据/日志保留。
原始 JUnit、逐阶段日志/SHA、APK 摘要及收尾记录在受限运维证据目录
`backups/cairn-b07-offline-single-20261017/`，不复制到本仓。

本批补齐单值替换与正式状态一致性的明确测试，**不签收完整 R3-07/R3-04 或 B07**。
真实 App/Web UI 竞争、全部新旧客户端/Worker/flags 组合、其他开放任务和最终独立复审
继续按原 issue 保留。PR 保持 Draft，不自动 merge、Ready、发布或关闭 issue。
