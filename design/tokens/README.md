# Cairn 设计令牌

`cairn.tokens.json` 是网页工作区、浏览器插件和 Android App 共用的唯一配色与尺寸来源（Claude / Anthropic 色系：羊皮纸画布、沙色侧栏、陶土色主操作，fig / olive / cactus / sky 作点缀）。

```sh
node design/tokens/build.mjs          # 重新生成
node design/tokens/build.mjs --check  # CI：生成物与提交内容不一致时失败
```

生成物：

| 文件 | 用途 |
|---|---|
| `design/tokens/dist/tokens.css` | 网页工作区（cairn-x-enricher `internal/dashboard/web/tokens.css` 按钉住的 Worker 版本拷贝并校验） |
| `browser-extension/src/tokens.css` | 浏览器插件 |
| `android/app/src/main/java/com/alpenl/cairn/share/ui/theme/CairnTokens.kt` | Android Compose 主题 |

生成脚本会检查浅色、深色两套配色的文字对比度（正文 ≥ 7:1，次要文字 ≥ 4.5:1，辅助文字和陶土按钮上的白字 ≥ 3:1），不达标时直接失败。

`design/fonts/` 是自托管字体（DM Sans、Source Serif 4 的 Latin 可变字重子集，SIL OFL 1.1，许可证随附）。中文使用系统字体。
