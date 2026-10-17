# B07-T07：按需读取与导出已存分类记录

2026-10-17（Asia/Shanghai）。Share运行/测试源码
656f52250bebad124c8d8f7f4441e32ae29199c6，叠加于人工实体测试d9ce1ac；
Go配对源码1a1a80766d61d261b8fcf9a760976f9ee1e85cea，叠加于f8e84e3。
[Share Draft90](https://github.com/Alpenl/cairn-share/pull/90) /
[Go Draft55](https://github.com/Alpenl/cairn-x-enricher/pull/55)保持Draft。
Go stack-contract固定上述Share与既有0068迁移；本批不增加迁移或改写历史。

## 结果与范围

- 阅读页显式打开分类记录后才读取摘要，每页最多50条；选中一条才取完整记录。
  更早页替换当前页，不把所有历史载荷累积到内存。历史状态不表示当前有效标签，
  partial/failed/expired与未知模型保持原义，resolved_model缺失不以requested_model替代。
- 单条导出包含服务器已保存的回答、策略、请求/实际模型、用量、原始判断和来源元数据；
  原null、空字符串及缺字段保持，不以当前配置或当前来源补造历史。
  这是分类run历史，不是全部人工事件、实体操作或原始快照的完整导出。
- 原始JSON仅按需预览前16384字符并明确提示；完整JSON通过CreateDocument选择位置，
  用ContentResolver写文件，不走剪贴板、不上传、不在saved state保存大载荷。
- 每个账号会话代次和收藏有独立Compose作用域，迟到读取、旧回调及文件选择结果不能
  更新另一作用域。读取与导出各绑定请求代次，关闭/切换记录取消操作和清理载荷；
  旧导出完成状态不会覆盖新记录，写入期间不允许重复导出。

## 后端与权限

Worker提供精确App GET `/api/bookmarks/:id/run-history[/:run]`，
内部配对GET `/api/v2/links/:id/run-history[/:run]`复用同一个处理函数，鉴权分别保持。
Go仅代理这个明确合同，既有Web紧凑`/runs`诊断接口仍省略原始元数据。

`X-Cairn-App-Run-History:1`及响应version=1显式协商；收藏/记录身份、
倒序游标推进、未知/重复查询、UTF-8及128KiB摘要/5MiB单条预算均检查。
不会退回旧版一次加载所有完整历史的接口。旧端404/405/501或无声明表示不支持；
有声明的记录缺失为不可用，归档缺失/损坏报错，不替换成最新记录或成功空结果。

来源是既有classification_runs和过期tombstones；私有R2归档继续核对字节数及digest。
读前检查收藏存在，详情SQL同时绑定收藏和run；删除后两个入口均不可读。
所有响应使用Cache-Control:no-store，App Token不能访问任意内部路径、运行提交、policy replay或spec管理。
读取不调用模型、不预留预算、不写分类或人工整理。

## 实际验证

| 范围 | 已核对结果 |
| --- | --- |
| Worker | 70文件617 tests、typecheck和deploy:dry-run通过；无部署 |
| Android | 147 JVM、严格依赖、lint、应用/测试APK通过；无依赖升级 |
| 本地API26/API35 | 各98条XML=78普通通过+20专用skip；随后各20个实际鉴权Worker/D1独立进程阶段通过 |
| 新页面/HTTP设备检查 | 按需加载、分页、partial/未知、16KiB预览、完整文件写入；401/403、404有无声明、410、501、503、缺声明/版本、非法UTF-8、超限chunk及302不跟随均覆盖 |
| 准确Share代码CI | [38989509133](https://github.com/Alpenl/cairn-share/actions/runs/38989509133)，656四项均成功 |
| 准确远端设备 | [38989508590](https://github.com/Alpenl/cairn-share/actions/runs/38989508590)，656 API26/API35各78普通+20真实阶段全部通过，原XML与逐阶段日志已下载核对 |
| Go | 最终make verify通过；新合同测试覆盖身份/游标/上限/旧端/空页及未知字段；既有紧凑诊断回归继续通过 |
| 实际Go/App Worker/D1 | 新第46个场景通过；55条持久合成记录、50+5分页、显式完整记录、未知模型、两入口删除后不可读；未构造分类器/供应商 |
| Go完整远端CI | [38989529249](https://github.com/Alpenl/cairn-x-enricher/actions/runs/38989529249)，准确1a三项全部成功；46独立真实场景、179浏览器检查、55真实栈检查及amd64/arm64 build-only，push:false；原始日志已核对，子用例不重复累计 |

文件选择结果由Instrumentation.ActivityMonitor受控返回，随后实际ContentResolver写入
自有临时JSON；核对17000字符的原始字段未受预览截断、null/false/用量保留，finally删除。
这不是系统文件选择器界面或物理设备验收。页面HTTP来自MockWebServer；20专用阶段是真实
授权Worker/D1，分类AI状态是合成夹具，不冒充人工金标或模型质量。

首轮Worker夹具把未知模型写成NULL，触发现有NOT NULL约束，修正为现有空字符串表示；
不改数据库约束。Go新测试曾误用不存在的删除客户端方法及留未使用导入，严格构建失败已修正，
未删断言。新隔离目录最初漏装浏览器扩展合同依赖，616用例通过但一套导入失败；
复用同锁安装后完整617通过，再按最终路由完整复验通过。
这些失败日志保留，不以单个定向绿灯替代完整门禁。

本机JDK21/SDK37，远端JDK17/API26与35。专属模拟器全部停止，仅清理本轮临时导出，
未停adb server或其他设备。原始证据保留于受限cairn-manual-entities-20261017，
包含逐平台XML、20阶段服务日志、HTTP边界、初次失败和准确CI原始输出。

## 未完成与权限边界

全实体操作/人工事件历史、完整来源快照导出、补材料与细分重试、真实App/Web UI竞争、
全旧新/flags组合和最终独立复审仍开放。未关闭整个B07或其他issues。
本批模型付费0，无生产访问/写入、远端迁移、flags、merge、Ready、签名、Release、
镜像推送、部署或开源发行；开源须用户另行明确同意，整个issues目标保持active。
