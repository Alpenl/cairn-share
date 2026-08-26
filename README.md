# Cairn Share

Cairn Share 是一个开源 Android 分享入口：从系统分享菜单接收完整的 HTTP(S)
链接和可选备注，直接写入 Cloudflare Worker 与 D1。

生产 API 当前部署在：

```text
https://cairn-share-api.yangyuyang91.workers.dev
```

## 范围

- 保留 Android `ACTION_SEND` 的文本分享入口和完整 URL，不删除 query 或 fragment。
- 分享时允许填写可选备注，再由应用直接提交到 Cloudflare。
- 后端只使用 Cloudflare Worker 与 D1，不依赖 Cairn、WebTag 或其他自托管服务。
- 应用和 HTTP API 都不做登录、令牌、账号、会话或权限鉴别。
- API 的读写接口面向所有人开放，存储的数据也按公开数据处理。

## API

所有接口都不需要认证。

```bash
curl -X POST https://cairn-share-api.yangyuyang91.workers.dev/api/links \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com/a?x=1#fragment","note":"later"}'
```

可用接口：

- `GET /health`
- `POST /api/links`
- `GET /api/links?limit=50&before_id=123`
- `GET /api/links/:id`
- `OPTIONS *`

`POST /api/links` 只接受 `application/json`。`url` 必须是有 host、无 userinfo 的
HTTP(S) URL，最长 8192 个 UTF-16 code unit；`note` 可省略，最长 2000 个 UTF-16
code unit。D1 使用参数化查询，MVP 允许重复链接，不做抓取、去重、删除或修改。

## Android

Android app 位于 `android/`，application id 是 `com.alpenl.cairn.share`，用户可见
名称是 `链接收集`。Manifest 只声明 `INTERNET`、桌面启动入口和系统分享入口。

分享流程：

1. 接收 `Intent.ACTION_SEND` + `text/plain`。
2. 从 intent data、ClipData URI、`EXTRA_TEXT` 和 ClipData text 中提取 HTTP(S) URL。
3. 单链接自动选中但不自动提交；多链接先让用户选择。
4. 用户填写可选备注后点击“保存”。
5. App 直接通过 Android/Java 原生 HTTPS API POST 到 Cloudflare Worker。
6. 成功后关闭；失败留在当前界面，用户可手动重试。

直接从桌面打开 App 时，不会提交任何数据，只显示使用说明和公开 API 风险提示。

没有账号、token、server 设置页、本地队列、Room、WorkManager、Keystore、Todo、
Reader、旧 Cairn/WebTag endpoint 或后台同步。

## 本地构建

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

本机运行模拟器需要当前用户具备 `/dev/kvm` 权限；GitHub Actions 的 `device.yml`
会在 runner 上启用 KVM 并分别跑 API 26 和 API 35。

## Cloudflare 部署

Cloudflare 配置位于 `worker/wrangler.jsonc`：

- Worker：`cairn-share-api`
- D1：`cairn-share`
- D1 binding：`DB`
- D1 database id：`08f52f6c-4f94-4e51-bd1c-596fdeac295c`

本地部署：

```bash
cd worker
npm run migrate:remote
npm run deploy
```

GitHub Actions 的 `deploy-worker.yml` 使用 `production` Environment，并需要以下
repository/environment secrets：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

API token 应使用最小权限，只授予部署该 Worker 和迁移该 D1 所需能力。不要提交
Wrangler OAuth 文件、Cloudflare token、`.dev.vars` 或 GitHub secret 值。

## Android 发布

`release-android.yml` 只响应稳定 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

workflow 会验证 tag 提交位于 `main`，从 tag 注入 `versionName`，用
`major * 10000 + minor * 100 + patch` 推导 `versionCode`，重新运行 Android 门禁，
构建 unsigned release APK，然后在 `RUNNER_TEMP` 解码 keystore、zipalign、签名、
`apksigner verify`，并校验证书 SHA-256。

需要配置这些 repository secrets：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `ANDROID_CERT_SHA256`

GitHub Release 只上传 APK 和 `SHA256SUMS`。本项目不自动上传 Google Play。

## 非目标

- 不抓取、解析、摘要或分类网页内容。
- 不提供 Reader、待办、账户、跨设备同步或离线持久队列。
- 不包含 iOS 客户端、Web 管理界面或应用商店自动上传。

## 数据公开边界

该项目刻意不提供鉴权。提交的链接和备注将能够被公开 API 枚举和读取，不应提交私密
链接、一次性签名 URL、访问令牌或其他敏感内容。输入校验、长度限制和基础滥用防护不会
改变 API 对所有人开放的产品边界。

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
