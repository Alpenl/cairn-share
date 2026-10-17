# B07-T07：实体来源片段的只读定位增量

2026-10-17（Asia/Shanghai）。Share 运行代码与测试：
dddf8c60b9c2437dd0fcf5a94f36a35f726d09bc；
Go companion：4cfa133b73ba508101c6a3f037584e341f96a659。
后续60d0d46a3d01684ee8f2049f026a5d08714d801d仅拆分既有标签恢复测试的断言诊断；
e3b12fc75ee4d53ac17b89e7fa7c34ae5b9dd4c5增加该测试的实际丢响应屏障。
两者均未改变App/Worker运行代码或移除断言/放宽期限；下表按受测源码分别记录。

[Share Draft #88](https://github.com/Alpenl/cairn-share/pull/88) 叠加于
[Draft #87](https://github.com/Alpenl/cairn-share/pull/87)，基线
296fda0e46fca0e7fd918daa2c51a0add2656133；
[Go Draft #53](https://github.com/Alpenl/cairn-x-enricher/pull/53) 基线
c2710d28e1f8f962b3071607bb7f37344621d0df。
Go 的 stack-contract 固定上述 Share 源码及已有迁移0068；本批没有新迁移。

## 行为与协议

实体记录增加“查看来源片段”，只在显式点击后读取当时保存的原文，并高亮对应文字、
标明原帖/引用等角色、旧来源版本和不完整材料。只读结果不进入离线编辑队列或正文缓存。

- App：GET /api/bookmarks/:id/entity-evidence。
- Go 内部读取：GET /api/v2/links/:id/entity-evidence。两入口分别执行既有 App/内部权限，
  不增加通配代理、可指定上游地址或管理权限。
- 参数恰为 snapshot_id、content_revision、block_id、start、end，各一次；
  数字为规范形式的安全整数。span 用 Unicode code point，最多2048；左右上下文各最多480。
- Worker 单次 D1 读取绑定仍存在的收藏、不可变快照、版本和块；不以当前正文替换缺失引用。
  不抓取外链、不调用模型、不写业务状态。响应保持 no-store。
- X-Cairn-Entity-Evidence:1 确认协议。未确认404为旧端 unsupported；已确认404为原片段不可用；
  已确认409为引用版本不符。未知协议、权限、网络和畸形响应也分别处理，不显示为成功。
- Android 保留并核对快照 ID、来源版本、区间、原词和上下文，严格 UTF-8，响应最多32KiB。
  Go 同样限制大小并核对引用身份。客户端不接受任意服务端片段冒充点击的记录。
- 关闭/重试使用请求身份；账号及会话代次变化、收藏删除会取消读取并拒绝迟到响应；
  已关闭旧弹窗的清理不能关闭新请求。“刷新依据”只刷新已存 selection，不启动分类。

## 实际验证

| 层次 | 命令/范围 | 结果 |
| --- | --- | --- |
| Worker | npm run typecheck；npm test；npm run deploy:dry-run | 612 tests通过；dry-run成功，未部署 |
| Android JVM/静态构建 | strict dependency verification；testDebugUnitTest、lintDebug、assembleDebug、assembleDebugAndroidTest | 137 unit及其余任务通过 |
| Go | make verify（vet、完整golangci、race测试、前端检查、build） | 通过 |
| Go/实际 Worker | CAIRN_INTEGRATION_CASE=entitysource，tests/local-integration/run.sh | 实际 D1、HTTP client和Go代理通过 |
| API35 新功能定向 | 两个实际页面HTTP用例、关闭/账号A→B→A/删除的三个实际ViewModel/DataStore/HTTP用例 | 5通过 |
| API35 完整设备 | connectedDebugAndroidTest；tests/android-worker/run.sh | 72普通通过；18需服务阶段在普通任务skip，随后18独立进程实际执行通过 |
| API26 完整设备 | connectedDebugAndroidTest；tests/android-worker/run.sh | 72普通通过；普通任务18 skip随后18独立进程实际执行通过 |
| Share 远端 CI | ci 38973412053 | 准确运行源码的worker/android/design-tokens/browser-extension四项均成功 |
| Share 初轮远端设备，dddf8c6 | device 38973412021 | API26的72普通+18实际阶段通过；API35原有标签恢复用例失败，71普通通过/18 skip，实际Worker阶段未执行；两平台新增5项均通过 |
| 标签用例诊断，60d0d46 | API35实际本地用例连续10次；ci 38974526072；device 38974520652 | 本地10/10及四CI通过；远端两平台各72普通+18真实Worker阶段通过，原始XML/日志已核对 |
| 标签用例丢响应屏障，e3b12fc | API35实际本地用例连续3次；[ci 38975247852](https://github.com/Alpenl/cairn-share/actions/runs/38975247852)；[device 38975573531](https://github.com/Alpenl/cairn-share/actions/runs/38975573531) | 本地3/3及四CI通过；远端两平台各72普通+18真实Worker阶段通过，原始XML/逐阶段日志已核对 |
| Go 远端，4cfa133 | [CI 38973502426](https://github.com/Alpenl/cairn-x-enricher/actions/runs/38973502426) | lint/test、44个独立真实Worker/D1场景、浏览器回归及真实栈浏览器、amd64/arm64容器构建全部成功 |

环境：Linux amd64、Go1.26.2、Node22.22.2、JDK21.0.10；
Android 编译SDK37.0，专用API26/35模拟器。远端环境由工作流固定。

共享 entity-source-evidence-v1 fixture 是合成的编解码参照，不是质量金标。
Worker 用真实 POST 保存快照并验证实际计算的身份；Go 实服务同样经正常快照入口读取。
Android 专用 Worker 阶段的实体状态由已有合成 SQL 夹具种入，
实际执行 App HTTP 客户端读取三种来源块、缺块和错误账号；
完整 App 页面及迟到响应测试使用 MockWebServer，不冒充真实模型推理或完整跨端浏览器流程。

## 失败与修正记录

- 来源单测初版误用了不存在的 provider_attempts 表名，已按真实表名修正。
  既有统一响应层补 private,no-store；断言按 no-store 指令语义检查，保留私有缓存保护。
- 首次完整 Worker 有611条通过，但插件合同套件因新 worktree 未装插件依赖无法加载，
  因而该轮不算完整通过；正常 npm ci 后完整612通过。未删套件或断言。
- 首轮API35的 legacy http_proxy 设置清空了本地排除项，导致本机HTTP服务连接失败；
  中止并保留该轮记录，恢复现代代理设置及localhost排除，重启同一专用AVD。
  真实公共Wi-Fi仍要求VALIDATED/NOT_METERED，没有伪造204、改约束或放宽测试期限。
  随后5个定向及完整72普通/18实际阶段通过，未修改产品代码或测试断言以绕过环境问题。
- 初轮远端API35在既有TagManagerUiInstrumentedTest的最终组合断言失败。
  原行同时检查AI模式、操作key唯一和至少两次POST，日志不能区分具体条件，完整失败保留；
  不是PR87的旧系统返回超时。新增来源5项在两平台均通过，但该矩阵整体失败。
  拆分诊断后本地连续10次通过，未复现。
  代码检查另外发现“待同步”可早于首个POST，旧测试可能在真正模拟丢响应前就恢复连接；
  现等待服务选定DISCONNECT_AFTER_REQUEST，若还未发送则保持离线手动重试，再恢复连接。
  所有原断言与期限保持，增加屏障后本地连续3次通过。
  此修正保证场景确实发生丢响应，尚不能把首轮未细分的失败根因签收为已确认修复。
  仅增加诊断的60d0d46以及增加屏障的e3b12fc随后均在远端双平台完整通过；
  不把这些通过改写成业务代码曾被修复的证明。
- 原始日志、XML、HTTP服务阶段记录保存在本地受限的
  cairn-source-blocks-20261017 证据目录。AGP进度计数不当作真实用例数，以上按JUnit XML与独立阶段逐一核对。

## 边界

这是来源块定位增量；完整 B07 的人工实体操作、历史导出、人工补材料、
真实App/Web UI竞争、全部旧新组合及独立复审仍开放。不把已有其他 Draft 的离线队列增量算入本分支。
此前PR87两条旧系统返回超时原因未确认，本批不以通过一次回归宣称其根因已修复。

本批付费模型调用0；没有生产访问或数据写入、远端迁移、启用flags、合并、Ready、
签名发布、部署、force-push或删除分支。开源发布仍须用户另行同意。
