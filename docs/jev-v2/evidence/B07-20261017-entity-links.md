# B07 局部交付：已存实体依据的安全外链入口

日期：2026-10-17（Asia/Shanghai）。对应 [#31](https://github.com/Alpenl/cairn-share/issues/31)
B07-T07；[Draft PR #87](https://github.com/Alpenl/cairn-share/pull/87)。基线
`c541e2f2d9e2db1c4ec0c01610ca83b48ceef76c`，受测源码
`32aeb1055ea584717be28a97c6104420267a49ae`。

## 行为

实体依据此前只有 URL 文字；现在来源链接及身份依据经现有 HTTP/HTTPS 校验后，提供
用户显式点击的按钮，并调用阅读页已有的外部浏览器处理入口。一个记录内相同来源/身份
URL 仅展示一次可点击入口，不跨记录合并同名身份。保留原身份、来源版本、过期/非有效
标记和块引用；查看页面不自动打开链接，也不发起推理或人工写入。

合同核对还发现旧 Android 把所有候选 surface 限为 120 字符，而 Worker 允许 2048
Unicode 码点，合法长来源 URL 因而会使整组依据不可用。现按 Worker 的候选上限解码；
URL 原有的 2048 长度、HTTP/HTTPS、无凭据等校验保持。新增上限/超限、补充平面字符
和非法 URL 控制，设备场景实际使用超过旧 120 上限的来源 URL。

没有新接口、模型调用、依赖、迁移或身份推测；未将 surface 名称改动当作 canonical
身份纠正。不存在可用 URL 的记录继续显示原依据文字，不臆造链接。

## 验证

| 检查 | 结果 |
| --- | --- |
| 严格 `testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest` | 133 unit、lint 与两 APK 构建通过 |
| 本地 API26 完整 `connectedDebugAndroidTest` | 67 普通设备测试通过，0 失败；18 个真实 Worker 专用方法无地址跳过 |
| 本地 API35 完整及定向 instrumentation | 67 普通设备测试通过；另 5 个定向场景通过（3 个导航、2 个既有系统返回），不重复累计为独立用例 |
| [准确源码完整 CI](https://github.com/Alpenl/cairn-share/actions/runs/38967735483) | 四项通过，含 607 Worker 测试 |
| [同源码远端 API26 / API35 完整矩阵](https://github.com/Alpenl/cairn-share/actions/runs/38967730059) | 两平台各 67 普通设备测试、18 个真实 Worker 独立阶段通过；下载原始 JUnit/阶段日志复核 |

三个实际 Launcher/Compose 场景涵盖当前实体依据、过期依据、来源链接与身份依据相同的
去重情况；每次均检查 Activity 重建后再操作。Instrumentation 捕获真实 `ACTION_VIEW`，
验证只在点击后发送、URL 正确、没有额外私有 Intent 参数；同时检查查看/点击不发出
POST 或分类请求。系统跳转被测试监视器拦截，未联网访问示例网站，不是浏览器网站验收。
原解析单测继续拒绝非法 scheme、不一致块来源及未知合同，不丢失普通标签读取。

本地 Linux x86_64 / JDK21.0.10 / Node22.22.2 / SDK37；API26 Android 8.0、API35
Android 15 专用 AVD，Wi-Fi 实测 VALIDATED / NOT_METERED，代理排除回环请求。
远端工作流使用 JDK17；普通任务 skip 的专用方法须由独立 Worker harness 实际执行，
不能从普通任务成功推断这些场景已通过。

## 初轮失败与限制

初版 `1c9fbd9` 的远端 API35 有两条既有系统返回场景超时：
`moreMenuAndBothBackActionsProtectUnsavedEditsAndDeletionRequiresConfirmation` 和
`navigationUsesRealScreensAndSourceActionRemainsVisibleWhileReading`。该次三个导航场景通过，
但完整平台未通过，未执行后续 Worker harness。原始失败 XML/logcat 完整保留。

长 URL 修正后的上述准确源码在本地五场景、带只读窗口焦点观察的本地完整套件及独立
远端完整矩阵均通过。有效完整观察包含 165 条焦点记录；先前定向观察选错输出段、
没有采到焦点字段，不作为诊断证据。没有修改系统返回实现、注入方式、原等待时间或
断言；**初轮超时原因尚未确认，不能宣称已修复或排除偶发问题**，继续留在 B07 验收范围。

## 保留范围

只新增外链入口，块正文定位、完整历史导出、人工实体纠正/补材料、真实 App/Web UI
竞争、全新旧版本/flags 组合及独立复审继续按原 issue 保留，不关闭整个 B07。
本地仅合成夹具和自有 AVD；无生产访问、付费、远端迁移、签名、部署或版本发行。
PR 保持 Draft，不自动 merge、Ready 或发布。

受限原始证据在运维目录 `backups/cairn-entity-evidence-navigation-20261017/`，含构建日志、
各自 JUnit XML、准确源码/制品摘要、模拟器网络状态及远端运行标识，不复制到本仓。
