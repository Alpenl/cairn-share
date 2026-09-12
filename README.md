# Cairn Share

Cairn Share 是一个开源 Android 分享入口：从系统分享菜单接收完整的 HTTP(S)
链接和可选备注，先保存到设备上的持久队列，再写入 Cloudflare Worker 与 D1。

生产 API 当前部署在：

```text
https://share.alpenl.com
```

## 项目组成

本仓库包含三个目录，另有一个紧密关联但独立发布的伴随服务：

| 组成 | 位置 | 说明 |
| --- | --- | --- |
| Android 客户端 | `android/` | 系统分享入口和完整应用壳，随 GitHub Release 分发 APK |
| Cloudflare 后端 | `worker/` | 唯一的线上后端：Worker `cairn-share-api`、D1 `cairn-share`、R2 图片桶 |
| 界面设计基线 | `design/` | Android 界面原型，不参与运行 |
| X 增强服务 | [`cairn-x-enricher`](https://github.com/Alpenl/cairn-x-enricher)（独立仓库） | 自托管 Go 服务，通常以 Docker 跑在 NAS 上，通过内部接口回写 X 收藏的增强内容 |

Android 客户端只依赖 Cloudflare 后端。增强服务是可选的：不部署它时，App 的功能和
API 契约完全不变，只是链接不会带上 AI 标题、译文和图片。详见
[X 增强伴随服务](#x-增强伴随服务)。

## 范围

- 保留 Android `ACTION_SEND` 的文本分享入口和完整 URL，不删除 query 或 fragment。
- 分享时允许填写可选备注，先持久化到本机，再由应用提交到 Cloudflare。
- App 的在线后端只使用 Cloudflare Worker 与 D1；可选的独立 X Enricher 服务通过内部
  Worker API 写回 AI 标题、双语原文、摘要和相关链接，并把图片保存到 R2；该服务不进入
  Android 安装包。新版 App 通过显式的增强读取接口展示同一份内容。
- 应用和 HTTP API 不做账号、会话或多用户权限，只使用一个部署侧访问 Token 保护读写接口。
- Android 本地保存访问 Token、分享偏好、筛选、搜索词、上次打开页面和待上传任务。

## API

`/api/links` 相关接口需要 `Authorization: Bearer <token>`。`GET /health` 和 API 调试台
页面不需要认证；调试台会把填写的 Token 保存到当前浏览器的 `localStorage`。新收藏的
链接默认是未学习状态。

```bash
curl -X POST https://share.alpenl.com/api/links \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com/a?x=1#fragment","note":"later","client_id":"3f55e9e8-4d52-4f45-a33d-89be8ef7ab45"}'
```

可用接口：

- `GET /` 和 `GET /debug`：同源 API 调试台。
- `GET /health`
- `POST /api/links`
- `GET /api/links?limit=50&before_id=123&learned=false&q=keyword`
- `GET /api/links/:id`
- `GET /api/links?include=enrichment`：轻量摘要、分类和整理状态。
- `GET /api/links/:id?include=enrichment`：完整双语正文及归档图片引用。
- `GET /api/taxonomy`：共享的版本化词表。
- `GET /api/images/:key`：使用 App Token 读取归档图片。
- `PATCH /api/links/:id/curation`：更新收藏原因、整理状态、人工分类或恢复自动分类。
- `PATCH /api/links/:id`
- `DELETE /api/links/:id`
- `OPTIONS *`

Worker 另提供不属于 App 公共契约的内部接口：

- `GET /api/enrichment/jobs`
- `POST /api/enrichment/jobs/claim`
- `GET /api/enrichment/jobs/:id`
- `POST /api/enrichment/jobs/:id/claim`
- `POST /api/enrichment/jobs/:id/images`
- `POST /api/enrichment/jobs/:id/complete`
- `POST /api/enrichment/jobs/:id/fail`
- `GET /api/enrichment/images/:key`

它们只接受独立的 `CAIRN_ENRICHER_TOKEN`，用于可选的
[`cairn-x-enricher`](https://github.com/Alpenl/cairn-x-enricher) 服务。App 的
`CAIRN_API_TOKEN` 无权调用这些内部任务接口。默认公开链接响应保留六个原始字段；
`include=enrichment` 在独立的 `enrichment` 对象内返回阅读和整理信息，不暴露租约、模型或内部错误。
图片上传只接受 `pbs.twimg.com/media`，经过响应类型和大小校验后写入绑定为
`ENRICHMENT_IMAGES` 的 R2 bucket；D1 只保存 R2 对象引用。

`POST /api/links` 只接受 `application/json`。`url` 必须是有 host、无 userinfo 的
HTTP(S) URL，最长 8192 个 UTF-16 code unit；`note` 可省略，最长 2000 个 UTF-16
code unit。`client_id` 也可省略；Android 待上传队列会传入 UUID v4，同一个
`client_id` 的重试会返回第一次创建的记录，不会重复写入。创建成功后的记录会包含：

```json
{
  "id": 1,
  "url": "https://example.com/a?x=1#fragment",
  "note": "later",
  "created_at": "2026-08-26T00:00:00.000Z",
  "learned": false,
  "learned_at": null
}
```

`GET /api/links` 支持 `learned` 和 `q` 查询参数：

- 不传或传 `learned=all`：返回全部链接。
- `learned=false` 或 `learned=0`：只返回未学习链接。
- `learned=true` 或 `learned=1`：只返回已学习链接。
- `q` 会在链接和备注中做大小写不敏感的模糊查询，最长 200 个 UTF-16 code unit。

指定 `include=enrichment` 后，`q` 同时查询原文、译文、AI 标题、摘要、实体和收藏原因；
支持 `topic`、`form`、`use`、`source=x|wechat|other`、`curation_status=inbox|kept|compiled|drop`、
`uncertain=true` 与 ISO 时间 `since` 组合筛选。列表只返回摘要和 `content_loaded=false`，
单条详情返回完整正文及 `content_loaded=true`。URL/备注编辑后应重新读取详情。

人工分类使用 `{"classification":{"topics":["llm"],"form":"tool","use":"try"}}`，
`{"classification":null}` 恢复模型分类；`why` 和 `curation_status` 可单独修改。
这些操作与局域网阅读页共享 D1 中的同一条记录，不触发模型处理。

手动修改链接：

```bash
curl -X PATCH https://share.alpenl.com/api/links/1 \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com/updated","note":"updated note","learned":true}'
```

`PATCH` 可单独或组合修改 `url`、`note`、`learned`。再次传 `{"learned":false}` 可以
把已学习链接改回未学习。删除链接：

```bash
curl -X DELETE https://share.alpenl.com/api/links/1 \
  -H 'Authorization: Bearer <token>'
```

D1 使用参数化查询；不同创建任务仍允许相同链接，同一个 `client_id` 的网络重试则保持
幂等。不做抓取或内容去重。直接打开
`https://share.alpenl.com/` 会显示一个 API 调试台。填写访问 Token 后，可以从浏览器
手动创建、查询、搜索、修改和删除链接。

## Android

Android app 位于 `android/`，application id 是 `com.alpenl.cairn.share`，用户可见
名称是 `链接收集`。Manifest 声明 `INTERNET`、`REQUEST_INSTALL_PACKAGES`、桌面启动
入口、系统分享入口和用于 APK 安装的 `FileProvider`。界面设计基线在
`design/cairn-links-app.html`，当前 Android 客户端按该原型实现完整应用壳和系统分享
弹层。

桌面启动入口打开完整应用壳：

- 底部导航包含“链接库”“待学习”“设置”三个主页面，主页面之间切换不累积返回历史。
- “链接详情”“编辑链接”“检查更新”“API 调试台”“关于”是独立下钻页面，应用栏返回和
  系统返回逐级退出。
- “链接库”提供总览、搜索、筛选、周进度、链接详情入口和手动添加 FAB。
- “整理筛选”提供主题、形态、用途、来源、整理状态、待确认和近 7/30 天条件。
- 详情展示 AI 标题、摘要、原文/译文切换、归档图片和相关链接；支持填写收藏原因、确认分类和恢复自动分类。
- “待学习”只展示未学习链接，按收藏时间先进先读，并支持批量标记已学习。
- “待上传队列”展示尚未同步的本地链接，支持逐条重试、全部重试和移除。
- “设置”展示只读服务器地址、访问 Token、分享偏好、更新入口、API 调试台入口和关于入口。
- 系统 `ACTION_SEND` 不进入应用壳，而是打开透明 Activity 上的 Material bottom sheet。

分享流程：

1. 接收 `Intent.ACTION_SEND` + `text/plain`。
2. 从 intent data、ClipData URI、`EXTRA_TEXT` 和 ClipData text 中提取 HTTP(S) URL。
3. 单链接自动选中但不自动提交；多链接先让用户选择。
4. 用户填写可选备注后点击“保存”。默认保留完整 URL；设置中关闭“保留完整链接”后，
   提交前会移除 query 与 fragment 并在 UI 中展示实际提交值。
5. App 先把链接和稳定的客户端 UUID 写入本地 DataStore 队列，再通过 Android/Java
   原生 HTTPS API POST 到 Cloudflare Worker。
6. 上传成功后移除本地任务；断网、超时、服务异常或 Token 不可用时保留任务，不显示
   “保存失败”。下次打开主应用会自动重试，也可以在设置中手动重试。
7. 默认在链接已上传或已安全写入本地队列后关闭；设置中关闭“保存后立即关闭”后，状态会
   保留在弹层里。

直接从桌面打开 App 时，会自动重试本地待上传任务，但不会凭空创建新任务。链接库和
待学习页面共享同一份云端数据；
列表每返回一页就显示一页，最多加载 5000 条并明确提示上限；详情页通过链接 ID 调用
`GET /api/links/:id?include=enrichment` 按需补齐正文。文本按段落延迟组合，图片按可见区域读取并限制解码尺寸与内存缓存。打开、复制、学习
状态切换、编辑和删除都是真实网络操作；删除前必须确认，删除后不会伪造撤销。

应用内更新：

1. 桌面打开 App 时会检查 GitHub Release 最新稳定版本。
2. 发现新版后，检查更新页面会展示该 Release 的版本号和更新说明。
3. 用户确认后，App 内部下载 APK 到自身 cache。
4. 下载完成后通过 `FileProvider` 把 APK 授权给 Android 系统安装器。
5. Android 8+ 如果尚未允许“安装未知来源应用”，会先打开系统权限设置；授权后回到 App
   会继续打开安装器。

普通 Android 应用不能静默安装 APK，最终确认安装仍由系统安装器完成，这是系统安全边界。

仍然没有账号体系、可编辑 server、多服务器切换、Room、WorkManager、Keystore、
旧 Cairn/WebTag endpoint 或后台同步。设置页中的服务器地址只读，生产用户不能切换到
任意 API 主机；API 调试台也被限制在当前配置服务器下。

## 本地构建

全仓行为消融及原始结果见 [ablation/README.md](ablation/README.md)，包含 Worker、Android
和新增阅读功能的设备对照。实验使用当前工作区的临时副本，不操作生产 D1。

Worker：

```bash
cd worker
npm ci
npm run typecheck
npm test
npm run deploy:dry-run
```

Android：

```bash
cd android
./gradlew --no-daemon --dependency-verification strict \
  testDebugUnitTest lintDebug assembleDebug compileDebugAndroidTestKotlin
```

本机如果没有 `ANDROID_HOME`，需要指向 Android SDK，例如：

```bash
ANDROID_HOME=/home/alpen/Android/Sdk ./gradlew --no-daemon testDebugUnitTest
```

设备测试：

```bash
cd android
./gradlew --no-daemon --dependency-verification strict connectedDebugAndroidTest
```

本机运行加速模拟器需要当前用户具备 `/dev/kvm` 权限；也可使用软件模拟器。GitHub Actions 的 `device.yml`
会在 runner 上启用 KVM 并分别跑 API 26 和 API 35。

## Cloudflare 部署

Cloudflare 配置位于 `worker/wrangler.jsonc`：

- Worker：`cairn-share-api`
- D1：`cairn-share`
- D1 binding：`DB`
- D1 database id：`08f52f6c-4f94-4e51-bd1c-596fdeac295c`
- Custom domain：`share.alpenl.com`
- Worker secrets：`CAIRN_API_TOKEN`、`CAIRN_ENRICHER_TOKEN`

发布包含 Worker 协议或 migration 的 Android 版本前，需要先手动运行 `deploy-worker.yml`；
它会先测试，再迁移 D1 并部署。也可以在本地手动部署：

本次 App 同步需要全部迁移，截至 `0008_invalidate_enriched_link_cache.sql`。
0007 提供分类和人工整理字段，0008 在富化或整理更新的同一事务内递增缓存版本。
先迁移并部署 Worker，再升级 Enricher 和 Android；现有记录、人工分类和上传队列会保留。

```bash
cd worker
npm run migrate:remote
npx wrangler secret put CAIRN_API_TOKEN
npx wrangler secret put CAIRN_ENRICHER_TOKEN
npm run deploy
```

GitHub Actions 的 `deploy-worker.yml` 使用 `production` Environment，并需要以下
repository/environment secrets：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Cloudflare API token 应使用最小权限，只授予部署该 Worker 和迁移该 D1 所需能力。
`CAIRN_API_TOKEN` 是应用访问 API 用的 Bearer token；`CAIRN_ENRICHER_TOKEN` 只供
伴随服务领取和提交增强任务。两者不得复用，均应通过 Wrangler secret 或 Cloudflare
Dashboard 配置。不要提交 Wrangler OAuth 文件、Cloudflare token、`.dev.vars` 或
GitHub secret 值。

## X 增强伴随服务

[`cairn-x-enricher`](https://github.com/Alpenl/cairn-x-enricher) 是本项目的伴随服务，
代码和发布都在独立仓库，用 Go 编写，正式镜像发布在
`ghcr.io/alpenl/cairn-x-enricher`，日常以 Docker Compose 自托管，作者的部署位于 NAS。

它做的事情：

1. 按轮询间隔调用 `POST /api/enrichment/jobs/claim` 领取尚未处理的 X 收藏，Worker 用
   原子更新和 15 分钟 lease 分发任务，允许多实例并发而不重复领取。
2. 用 Grok Responses API 和服务端 `x_search` 读取原帖及评论。
3. 通过 `POST /api/enrichment/jobs/:id/images` 归档图片，只接受
   `https://pbs.twimg.com/media/...`，由 Worker 校验响应类型和大小后写入 R2，D1 只保存
   对象引用。
4. 通过 `POST /api/enrichment/jobs/:id/complete` 或 `.../fail` 回写结果：AI 中文标题、
   原始语言全文、简体中文译文、摘要和内容相关链接。失败由 Worker 按
   `1m / 5m / 30m / 2h` 退避，最多尝试 5 次。

它同时在本机监听一个局域网页面（NAS 部署映射到 `8088`），提供收藏列表、独立阅读页和
手动触发处理。该页面会展示收藏内容并可以触发付费模型请求，只应开放在可信局域网，不要
做公网端口转发。

与本仓库的边界：

- 它只使用 `/api/enrichment/*` 内部接口和独立的 `CAIRN_ENRICHER_TOKEN`。App 的
  `CAIRN_API_TOKEN` 无权调用这些接口，两个 token 不得复用。
- 它不进入 Android 安装包。App 通过 `include=enrichment` 读取增强内容，通过公共 curation
  接口整理收藏；默认 `/api/links` 六字段响应及原有鉴权仍兼容旧客户端。
- 本仓库维护 D1 migration、两组独立鉴权的 API、R2 绑定和 Android 阅读/整理界面。
- App 修改链接的 URL 或备注时，已有增强结果会失效并重新入队。

部署顺序、环境变量和 NAS compose 清单以该仓库的 `README.md`、`docs/deployment.md` 和
`deploy/nas/compose.yaml` 为准，本仓库不重复维护。

## Android 发布

`release-android.yml` 只响应稳定 tag：

```bash
git tag v0.3.0
git push origin v0.3.0
```

workflow 会验证 tag 提交位于 `main`，从 tag 注入 `versionName`，用
`major * 10000 + minor * 100 + patch` 推导 `versionCode`，重新运行 Android 门禁，
构建 unsigned release APK，然后在 `RUNNER_TEMP` 解码 keystore、zipalign、签名、
`apksigner verify`，并校验证书 SHA-256。每个发布版本必须在 `CHANGELOG.md` 中有对应的
`## X.Y.Z` 小节，工作流会把该小节写入 GitHub Release，App 检查更新时会直接展示。

需要配置这些 repository secrets：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `ANDROID_CERT_SHA256`

GitHub Release 只上传 APK 和 `SHA256SUMS`。本项目不自动上传 Google Play。

## 非目标

- Android App 和公开 API 不抓取、解析、摘要或分类网页内容；可选伴随服务只处理 X 收藏，
  并通过独立鉴权的内部接口写回结果。
- 阅读已归档正文，不提供任意网页抓取 Reader、待办、账户或常驻后台同步。
- 不包含 iOS 客户端、带鉴权的 Web 管理后台或应用商店自动上传。

## 数据边界

该项目不提供账号体系，只有一个共享访问 Token。知道 Token 的客户端可以枚举、读取、
创建、修改和删除全部链接，因此不应提交私密链接、一次性签名 URL、访问令牌或其他敏感
内容。输入校验、长度限制、缓存和基础滥用防护不能替代完整权限模型。

## GitHub Actions

- `ci.yml`：Worker typecheck/test/dry-run，Android unit/lint/build/instrumentation 编译，
  上传 debug APK。
- `device.yml`：KVM emulator 上运行 API 26 和 API 35 的 `connectedDebugAndroidTest`。
- `deploy-worker.yml`：手动触发，受 `production` Environment 保护，先测试和 dry-run，
  再执行远程 D1 migration 和 Worker deploy。
- `release-android.yml`：稳定 `vX.Y.Z` tag 触发，签名、校验并发布 APK。
- `dependabot.yml`：维护 npm、Gradle 和 Actions 依赖更新。

所有 workflow 默认 `permissions: contents: read`，只有 Android release job 提升到
`contents: write` 用于创建 GitHub Release。

## 许可证

[MIT](LICENSE)
