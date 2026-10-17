# B07-T07：人工整理实体名称与独立生命周期

2026-10-17（Asia/Shanghai）。Share 运行源码
0822dde5120752426d58cfa712529ef3605c7f68；
Go候选源码f8e84e30b2dcba3b5705b97b595b6877c7900697
（0797619后430ddf7补齐501透传，f8e84e3再统一Web输入上限）。
本报告为2026-10-17 08:02（Asia/Shanghai）的进度快照，最终远端门禁尚未签收。
Share166df83仅增加旧返回用例诊断，38883d6再补UI就绪同步，均未改App/Worker运行代码。
[Share Draft #89](https://github.com/Alpenl/cairn-share/pull/89)叠加于Draft #88；
[Go Draft #54](https://github.com/Alpenl/cairn-x-enricher/pull/54)叠加于Draft #53。
两者保持Draft，不签收整个B07。Go stack-contract固定上述Share运行源码与迁移0068；无新迁移。

## 最终行为

- Android可人工添加、保留、移除实体名称，明确留空，按名称或全部恢复自动。
  这是surface名称层的人工整理，同名记录一并受影响，不是canonical身份更正/合并。
  原始判断、来源和身份依据不改写；输入不会取得虚构身份或自动成功状态。
- 使用既有人工动作接口、事件日志、personal_revision CAS及原operation key回执。
  离线预览不修改服务器state；名字、自动基线、AI生命周期分别保存。
  基线缺失为未知，不用人工有效值倒推自动值；恢复结果不明时不假装留空。
- 实体合法自动名称原有上限为120个UTF-16单元，人工accept/reject原为80，
  导致长名称不可维护；本次两者统一为120。其他分类维度规则和旧reset载荷保持。
  实体动作跳过与其无关的词表校验读取，不新增模型或网络抓取。
- 编辑回调绑定渲染时账号及会话代次；切换账号和A→B→A均拒绝旧界面回调。
  编辑输入可在旋转后恢复，账号切换收起编辑区并隔离旧输入。
- 不支持写入时保留动作和原key，不当作成功或丢弃。App明确识别404/405/501；
  Go同样将旧Worker未实现映射为v2_unsupported，继续由客户端显示兼容状态。
- Go读取代理此前既未请求也未转发state，现在透传已保存的生命周期/人工来源/基线。
  旧Worker未提供state时继续省略，不能构造已完成或已留空；非法人工动作返回400，
  revision_conflict仍带当前版本返回409。
- Markdown展示实体的独立AI状态、确认来源及明确留空；未同步名字标注待同步，
  不将旧自动身份依据附在本地人工名字上。旧判断详情仍可读并标明是服务端记录。

## 验证范围

| 范围 | 实际结果 |
| --- | --- |
| Worker | typecheck、69文件614 tests、deploy:dry-run通过；未部署 |
| Android静态/JVM | 严格依赖、144 unit、lint、应用APK和测试APK构建通过 |
| 新增定向设备 | API35实际页面及ViewModel/DataStore/HTTP的4项通过 |
| API35完整设备 | XML 96条：76通过/0失败/20需真实服务而skip；随后20独立进程真实Worker/D1阶段全部通过 |
| API26完整设备 | XML同为76通过/0失败/20 skip；随后20独立进程真实Worker/D1阶段全部通过 |
| Go候选源码 | make verify（vet、完整golangci、race、前端检查、build）通过 |
| Go实际跨服务 | entityhuman场景通过：真实Go代理/client、正常鉴权HTTP、真实Worker/D1，无分类器 |
| Share代码CI | [38981759656](https://github.com/Alpenl/cairn-share/actions/runs/38981759656)，准确0822源码四项均成功 |
| 远端初轮设备 | [38981917323](https://github.com/Alpenl/cairn-share/actions/runs/38981917323)，首次0822：API26的76普通+20实际阶段通过；API35的74普通通过/2既有系统返回超时/20 skip，实际Worker未执行；新增4项两平台均通过，正在补只读诊断 |
| Go完整候选CI | [38983994236](https://github.com/Alpenl/cairn-x-enricher/actions/runs/38983994236)，准确f8源码仍执行，runner共45个独立真实D1场景；430的38982210317因新Web修复被自动并发规则取消，不算通过 |
| Share诊断代码CI | [38983073075](https://github.com/Alpenl/cairn-share/actions/runs/38983073075)，166源码四项成功 |
| Share候选门禁 | 388源码[代码38984250799](https://github.com/Alpenl/cairn-share/actions/runs/38984250799)与[设备38984247324](https://github.com/Alpenl/cairn-share/actions/runs/38984247324)仍执行 |

新增七个JVM用例覆盖独立基线、坏/缺元数据、未确认导出、清空/单名恢复、未运行/
失败/过期/已完成空保持、不支持队列、UTF-16边界。
新增两个真实Worker单测覆盖鉴权、长名称、幂等回放、模型尝试数为0、
人工留空和恢复不改自动版本、来源变更以及新失败结果不覆盖人工。

新增两个真实Worker设备阶段，在已有实体夹具上连续保存七个离线意图：
长名称添加、拒绝Acme、明确留空、单名恢复、再次添加/拒绝、全部恢复。
第一个真实提交后丢回执并转离线；强制结束App进程后恢复队列，
原key重放仅生效一次，后继CAS依次确认，最后名字Acme，
实体AI版本、状态和三个原身份记录均未改变，另一个账号的队列保持且未发出。
专用阶段实际使用HTTP鉴权、故障代理和D1；实体AI状态是合成SQL夹具，不冒充模型质量金标。
真实页面测试使用MockWebServer，不能宣称为完整实际App/Web UI并发。

Go真实场景另外核对120单元名称增删、旧版本同key回执、过长名称400、冲突409、
AI未运行仍未运行、明确留空的人工作用、单名/全部恢复及来源更新后仍stale。
旧端HTTP合同测试实际经过Go client和代理，404/405/501均分别为不支持，缺state仍未知。

## Web输入边界

后续核对发现既有Web实体输入仍maxLength80，已统一120。保持既有组件与样式，
没有增加抽象。原有浏览器用例改为真实键盘逐字输入120单元并核对实际HTTP动作和完整显示：
修复前178/179，仅此边界失败；修复后179/179通过，完整make verify同样通过。
既有chip的max-width及文字省略保留；没有更改其他输入或分类规则。
这份UI代码已随f8e84e3推送，完整远端CI仍在执行。

## 初次失败与环境记录

- 新JVM/Worker夹具最初误认实体origin带human_action，按实际服务字段修正；
  TypeScript配置不支持toSorted，改为复制后sort。没有扩大编译配置。
- 新Compose函数的表达式体推断为nullable Unit，D8拒绝；改为明确Unit块体后
  完整构建通过，没有换依赖或关闭严格检查。
- 重点设备首轮4项中2项失败：MockWebServer夹具错误强取允许省略的空term，
  使set_empty连接异常；另一个用例忽略切换账号会收起编辑区。
  按正常服务回执补齐term、明确重开新账号编辑区后4/4通过，
  保留旧失败XML/日志；没有删除产品断言或放宽期限。
- 501兼容测试初版有未使用的HTTP参数，严格lint失败，改为匿名参数后完整门禁通过。
- API26初次启动因本机磁盘不足退出，没有执行测试。释放8个旧隔离目录中
  可由npm ci重建的node_modules，保留源码、锁文件SHA、所有数据/模型及验收证据；
  同一专用AVD随后正常启动。真实Wi-Fi经系统确认VALIDATED/NOT_METERED，
  不伪造204、不放宽App网络约束。本轮自有设备已关闭。
- Worker测试运行时有存储reset内部警告；最终69文件614条完整成功，原始日志保留。
  AGP显示的中途进度计数不当作实际用例数，设备数取JUnit XML。
- 本地受限证据目录cairn-manual-entities-20261017保留原失败、最终原始XML、
  40个真实阶段日志/HTTP安全记录、APK SHA和清理清单。

## 远端初轮失败

准确运行源码0822的首次矩阵中，API35的AndroidUiRedesignInstrumentedTest
navigationUsesRealScreensAndSourceActionRemainsVisibleWhileReading在原241行，
moreMenuAndBothBackActionsProtectUnsavedEditsAndDeletionRequiresConfirmation在原271行，
分别系统返回后等待阅读页和未保存确认框20秒超时；与PR87先前同类失败分别保留，
不能据此断言根因相同或业务已修复。API26完整通过，新实体4项在两平台均通过。
API35整体失败，未运行其真实Worker20阶段，不能把编译/局部通过计作整个矩阵通过。
补充测试层的TestTag/原生窗口焦点/Activity生命周期标志诊断，
不记录可见文字、草稿、账号、凭据或正文；所有原事件、断言与期限不变。

### 带诊断的第二轮

166的远端38983069597中，API26仍为76普通+20真实阶段全部通过。
API35的两条既有系统返回及4项新增实体用例通过，但旧TopicNavigation用例
在设计选项的即时performScrollTo找不到节点，故为75通过/1失败/20 skip，
实际Worker35未执行。全量失败原始XML/日志完整保存；不因返回用例通过宣称初轮根因已确认。
新诊断在本地两条返回用例各5次全部通过。

388加入显式compose.waitForIdle作为真实按键的前置条件，避免同步依赖日志读取；
主题测试每次依赖前一筛选动作的新选项先用原有waitTag(15秒)确认就绪。
所有原业务断言、事件和原期限保留，没有改产品逻辑。该版本地首轮两条返回+主题共3通过，
主题再4次通过，合计7通过；等待远端全量复验。缺节点的精确时序根因仍不作超出证据的确认。

## 未完成范围与权限

完整实体操作历史与来源导出、人工补材料、细分阅读/分类能力及重试、
实际App/Web UI竞争、全部旧新/flags组合和独立复审继续开放。
本批只实现已有名称级人工合同，不增加新的身份操作或语义方案；
之前PR87/88既有偶发失败的根因仍按原记录未确认，不因本轮通过而宣称修复。

没有生产访问/写入、模型付费、远端迁移、flags启用、merge、Ready、签名、部署、
Release、force-push或删分支；开源发行须用户另行同意。整个issues目标仍active。
