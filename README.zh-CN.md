# chat-demo

[English](README.md) | 简体中文

基于 DeepSeek API 的静态聊天示例。无需应用后端，浏览器直接请求配置的 API 服务。

点击 [在线体验](https://deepseek-ai.github.io/chat-demo/) 即可使用，也可以前往 [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases) 下载压缩包，解压后双击 `index.html` 在本地使用，无需安装或构建。首次使用时，请在设置中用手机号登录 DeepSeek 账号，或填写 API Key。

## 官方账号登录

设置 → 数据管理 → DeepSeek 账号 → 登录，会跳转到 DeepSeek 官方登录页，用手机号接收短信验证码完成登录，无需 API Key。登录得到的账号 token 与 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 使用同一套官方鉴权协议：

1. 页面用 PKCE（S256）发起 `auth_init`，拿到官方授权页地址；
2. 浏览器在官方页面完成手机号登录；
3. 官方页面回跳到本应用，`auth_exchange` 用 code 换取账号 token；
4. 之后的 Messages、Files、模型列表与语音请求都以 `x-dsh-auth-token` 头携带该 token。

登录后，设置里的账号区会显示**充值余额**与**赠金余额**，并提供「查询用量」「充值」入口。资料与余额各自独立读取：余额查询失败（30 秒超时或服务端报错）时资料照常展示，余额位置改为「前往开放平台查看」。余额字符串按 Platform Web 的规则格式化——向下截断到两位、千分位、小于 0.01 显示 `<¥0.01`，并保留服务端精度（如 `5.0000000000000000` 显示为 `¥5.00`）。赠金余额为 0 时该行不显示。

官方鉴权接口不返回 CORS 响应头，浏览器无法直接跨域调用，因此请求发往同源的 `/__auth` 前缀：

- `pnpm dev` 时由开发服务器代理到 `https://platform.deepseek.com`，开箱即用；
- 部署静态产物时，需要把一个反向代理挂在 `/__auth` 上，转发同样规则；没有代理时设置中会提示「当前部署未配置官方登录代理」。可用 `createConfig({ authOrigin, authUpstream })` 改成自定义的同源前缀与上游地址。
- 回跳地址固定为 `<origin>/oauth/callback`（与 harness 一致，Platform 登录成功后按此地址返回），静态服务器需要把它回落到 `index.html`。入口脚本会在加载资源前把地址还原到根路径，因此相对资源路径依然可用。

账号 token 与 API Key 同时存在时优先使用账号 token。token 没有过期时间，退出登录会在删除本地凭证后再调用官方登出接口。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## Android APK

`android/` 是一个不依赖 Gradle 的 WebView 外壳，直接用 SDK 自带的 `aapt2` / `d8` / `zipalign` / `apksigner` 构建：

```sh
pnpm build                                 # 先产出 dist/
powershell -File android/make-apk.ps1      # 含前端构建；-SkipWebBuild 复用已有 dist
```

产物是 `android/chat-demo.apk`（调试签名，可直接安装）。

- 页面由内置的本机 HTTP 服务（`127.0.0.1:47113`）提供，而不是 `file://`：WebView 的 `file://` 是 opaque origin，`crypto.subtle`、localStorage 与 IndexedDB 都不可靠，官方登录的回跳地址也必须是 loopback 源。端口固定，因为源（含端口）决定本地存储的归属。
- 同一服务把 `/__auth` 反代到 `https://platform.deepseek.com`，与开发服务器的代理等价，因此手机号登录在 APK 内同样可用。
- 构建需要 Android SDK（build-tools + 任一 platform）与 JDK，脚本会依次查找 `ANDROID_HOME`、`%LOCALAPPDATA%\Android\Sdk`、Android Studio 自带 JBR。
- `-Check` 会额外在 JVM 上跑一遍本机服务自检（静态托管、SPA 回落、MIME、`/__auth` 反代）；该步会访问 Platform，可能被限流。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据

API Key、账号 token 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、账号 token、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key、账号登录状态和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, authOrigin, authUpstream, devServer })` 支持自定义 API 地址、官方鉴权的同源前缀与上游地址，以及开发服务器代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    auth/              官方账号登录（PKCE 流程、平台接口、凭证与账号状态）
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
