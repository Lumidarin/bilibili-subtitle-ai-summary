<p align="center">
  中文 · <a href="README.md">English</a>
</p>

# B站 AI 字幕总结

Chrome 扩展（Manifest V3）：抓取 B 站视频字幕，调用任意 OpenAI 兼容接口生成 Markdown 总结。

## 功能

- **带时间戳字幕** — 自动抓取视频字幕轨（优先中文），保留时间戳
- **AI 总结** — 生成「核心观点 + 带时间戳大纲」，支持任意 OpenAI 兼容接口（默认 DeepSeek）
- **全文附在文末** — 字幕原文自动拼到 Markdown 末尾，不消耗 AI token
- **本地历史** — 每份总结存入 IndexedDB，随时回看、搜索、重新下载
- **悬浮球** — B 站页面上的可拖动粉色小球，左键一键总结，无需打开弹窗

## 安装

1. 打开 `chrome://extensions`，开启右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择本目录
3. 右键扩展图标 → 选项，填写 API Key（默认 DeepSeek `https://api.deepseek.com/v1`，模型 `deepseek-chat`），点「测试连接」确认可用

## 使用

1. 打开任意 B 站视频页（`www.bilibili.com/video/...` 或番剧页）
2. 点扩展图标 → 「一键生成 AI 总结」；**或直接点页面右上角粉色悬浮球**（左键开始，可拖动换位置）
3. 任务在后台执行，**无需一直开着弹窗**；完成后自动打开查看页
4. 随时在弹窗 → 「历史记录」回看、搜索、删除、重新下载

## 配置

| 设置 | 说明 |
| --- | --- |
| API 接口地址 | OpenAI 兼容地址，例如 `https://api.deepseek.com/v1` |
| API Key | 调用 AI 必需 |
| 模型 | 服务商提供的模型名，例如 `deepseek-chat` |
| 下载目录 | Chrome 默认下载目录下的 `.md` 存放子文件夹 |
| 分片字符数 | 字幕分片长度；长视频自动分片总结再合并 |
| 温度 | AI 采样温度（0–2） |
| 完成后自动打开 | 完成后在新标签页打开总结 |

任意 OpenAI Chat Completions 兼容服务均可：DeepSeek / Kimi / Qwen / GLM / OpenAI / 本地 Ollama —— 只需修改接口地址和模型。中国大陆网络下国内服务直连可用，OpenAI 等需代理。

## 开发

```bash
node --check background.js
node --check content.js
node --check db.js
```
