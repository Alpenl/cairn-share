# B07 / Android 接入与跨版本读写兼容

状态：待实现。总计划 https://github.com/Alpenl/cairn-x-enricher/pull/3 。base B05 #26；交互语义依赖 https://github.com/Alpenl/cairn-x-enricher/pull/6 （B06）。覆盖R03/R06/R23/R26–R30/R37/R39。

## 范围与准备

先检索`android/app/src`实际网络DTO、JSON解析、repository/cache、ViewModel、Compose阅读/编辑/列表和test文件，记录路径与基线。不要凭名字猜文件位置，不顺手升级Gradle/Android/Compose所有依赖。Worker已由B05提供v2与v1投影，本批实现Android的真实消费与交互，并补完整旧新组合测试，不是只改文档“兼容”。

## 任务

- [ ] B07-T01 读取B05共享v1/v2 fixture和B06操作语义，定义Kotlin DTO与解析：单值旧form/use、多选v2、字段状态、origin、revision、候选、实体状态。未知可选字段安全处理，不把未知状态映射成已确认；无v2时保留旧读取行为。
- [ ] B07-T02 按API能力/版本显式请求v2，列表summary与详情按需加载。缓存按representation+revision隔离；登录/服务器切换、schema变化、分类/curation更新失效正确。不把旧缓存反序列化成v2并丢字段。
- [ ] B07-T03 阅读页展示有效多维结果、AI候选和人工来源；默认最多3topic仅视觉折叠，详情能展开全部。carrier与内容功能分开，潜在用途不伪装用户真实意图。合法空/未运行/失败/过期分开。
- [ ] B07-T04 实现逐字段/tag accept/reject/set-empty/reset，operation ID和expected revision贯穿请求/缓存/重试。仅保存why/status不带分类，不自动确认初次加载的AI。整组legacy选择来源不升级为已验证人工gold。
- [ ] B07-T05 并发与离线：网络失败保留草稿，重复提交幂等；Web已修改后Android旧revision不能覆盖，显示冲突并让用户明确重应用。离线队列只存用户动作，不把旧完整对象反写服务器，账号/服务器切换不误发队列。
- [ ] B07-T06 分开来源/阅读处理、分类处理、人工状态，提供与权限相符的只分类重试/策略重放动作。App Token不能调用内部任意spec/模型/迁移管理；若接口能力不提供某动作则明确不可用，不绕过鉴权。普通阅读不隐式触发付费处理。
- [ ] B07-T07 多维过滤、标签显示、搜索与Markdown分享/导出保留完整有效分类、why、source和partial说明；实体not_run/failed/stale正确显示，不将失败视为没有实体。引用证据只引用服务端真实block ID/URL，安全打开外链。
- [ ] B07-T08 保存状态恢复、导航返回、分页、快速搜索、屏幕旋转/进程恢复不丢选择或重复提交。UI具有可访问label、合理触控区域、大字体/小屏布局；现有图片/译文阅读不退化。
- [ ] B07-T09 编写旧App→新Worker、新App→旧Worker、新App→新Worker测试；覆盖v1的classification:null、空use、已有第四topic/隐藏v2功能、人工reject和source过期。确保新数据不会被旧完整PATCH无声清空。无法表达的旧操作按B05明确冲突或范围适配，不能猜意图。
- [ ] B07-T10 运行仓库CI等价Android门禁、Worker完整测试和契约测试；设备/模拟器可用时运行真实UI操作并记录环境；无设备时标BLOCKED_EXTERNAL，不用compileDebugAndroidTestKotlin冒充设备测试。提交evidence/B07.md与锁定SHA给B10。

## 兼容矩阵必须填写实际结果

| 客户端 | 后端 | 必须保证 |
|---|---|---|
| 旧App六字段 | 新Worker | 原shape、原鉴权、旧缓存规则兼容 |
| 旧App enrichment v1 | 新Worker已有v2结果 | 合法投影、写入不抹隐藏值/拒绝 |
| 新App v2 | 旧Worker/flag off | 明确降级或只读，不崩溃、不伪造字段 |
| 新App v2 | 新Worker | 字段操作、revision、三状态、实体与分面正常 |
| Android/Web并发 | 新Worker | CAS冲突，动作幂等，人工优先 |
| 旧缓存/离线草稿 | schema/来源变化 | 不自动把旧快照全量写回 |

## 测试与证据

基线CI使用JDK17和仓库指定SDK；先核对实际CI再执行：

```text
./gradlew --no-daemon --dependency-verification strict testDebugUnitTest lintDebug assembleDebug compileDebugAndroidTestKotlin
```

Worker目录`npm test`、`npm run typecheck`、`npm run deploy:dry-run`。遵循仓库shell包装要求。新增UI测试target必须实际存在才记录命令。测试SC03/07/13–16/19/23–25/28，包含返回JSON解析、网络请求体、operation去重、缓存key和冲突状态断言。

交付证据必须区分unit/lint/build/instrumentation/device；真实UI测试用合成收藏，截图与日志不含私人原文/凭据。签名发版APK、发布到商店、修改生产配置均不在授权内。

## 回滚

v2功能受能力协商控制，可回到v1读视图；服务端v2数据与人工事件保留。客户端不通过“降级存储schema”删除服务端值。若新协议只读fallback，给明确提示，不能显示保存成功却没实际写入。
