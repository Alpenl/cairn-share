# Cairn Share

Cairn Share 是一个正在开发的开源 Android 分享入口：从系统分享菜单接收完整的
HTTP(S) 链接和可选备注，直接写入 Cloudflare Worker 与 D1。

> 当前仓库只完成项目初始化，尚无可安装或可部署的实现。完整开发计划与验收标准见
> [Issue #1](https://github.com/Alpenl/cairn-share/issues/1)。

## 范围

- 保留 Android `ACTION_SEND` 的文本分享入口和完整 URL，不删除 query 或 fragment。
- 分享时允许填写可选备注，再由应用直接提交到 Cloudflare。
- 后端只使用 Cloudflare Worker 与 D1，不依赖 Cairn、WebTag 或其他自托管服务。
- 应用和 HTTP API 都不做登录、令牌、账号、会话或权限鉴别。
- API 的读写接口面向所有人开放，存储的数据也按公开数据处理。

## 非目标

- 不抓取、解析、摘要或分类网页内容。
- 不提供 Reader、待办、账户、跨设备同步或离线持久队列。
- 不包含 iOS 客户端、Web 管理界面或应用商店自动上传。

## 数据公开边界

该项目刻意不提供鉴权。提交的链接和备注将能够被公开 API 枚举和读取，不应提交私密
链接、一次性签名 URL、访问令牌或其他敏感内容。输入校验、长度限制和基础滥用防护不会
改变 API 对所有人开放的产品边界。

## 许可证

[MIT](LICENSE)
