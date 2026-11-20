# chat-demo

English | [简体中文](README.zh-CN.md)

A static chat demo powered by the DeepSeek API. No application backend is required: the browser connects directly to the configured API service.

You can [try the app online](https://deepseek-ai.github.io/chat-demo/) or download the archive from [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases), extract it, and double-click `index.html` to use it locally without installation or a build. Sign in with your DeepSeek account using a phone number, or enter an API key, in Settings before your first chat.

## Signing in

Settings → Data → DeepSeek account → Sign in opens the official DeepSeek sign-in page, where you log in with a phone number and an SMS code — no API key required. The resulting account token follows the same official authorization protocol as [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness):

1. The page starts `auth_init` with PKCE (S256) and receives the official authorization URL;
2. The browser completes the phone sign-in on the official page;
3. The official page redirects back to this app, and `auth_exchange` trades the code for an account token;
4. Messages, Files, model listing, and speech requests then carry that token in `x-dsh-auth-token`.

After signing in, the account section in Settings shows the **topped-up balance** and the **granted balance**, with links to view usage and top up. Profile and balance load independently: when the balance query fails (30-second timeout or a server error) the profile still renders and the balance position becomes "View on Platform". Amounts follow Platform Web's formatting — truncated to two decimals, grouped digits, `<¥0.01` below one cent — while preserving server precision (so `5.0000000000000000` shows as `¥5.00`). The granted-balance row is hidden when it is zero.

The official authorization endpoints return no CORS headers, so the browser cannot call them cross-origin. Requests therefore go to a same-origin `/__auth` prefix:

- `pnpm dev` proxies it to `https://platform.deepseek.com` and works out of the box;
- A deployed static build needs a reverse proxy on `/__auth` with the same rule; without one, Settings reports that the deployment has no sign-in proxy. `createConfig({ authOrigin, authUpstream })` configures a different same-origin prefix and upstream.
- The redirect target is fixed at `<origin>/oauth/callback` (matching deepseek-harness, which is where Platform sends the browser after sign-in), so a static server must fall that path back to `index.html`. The entry script restores the address to the root path before loading assets, so relative asset paths keep working.

An account token takes precedence over an API key when both are present. Tokens do not expire; signing out deletes the local credential first and then calls the official logout endpoint.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Android APK

`android/` is a WebView shell built without Gradle, using the SDK's `aapt2` / `d8` / `zipalign` / `apksigner` directly:

```sh
pnpm build                                 # produce dist/ first
powershell -File android/make-apk.ps1      # builds the web app too; -SkipWebBuild reuses dist/
```

The output is `android/chat-demo.apk` (debug-signed, installable as-is).

- Pages are served by an embedded loopback HTTP server (`127.0.0.1:47113`) instead of `file://`: a `file://` page in WebView is an opaque origin, where `crypto.subtle`, localStorage and IndexedDB are unreliable, and the official sign-in redirect must target a loopback origin. The port is fixed because the origin (including the port) owns the local storage.
- The same server proxies `/__auth` to `https://platform.deepseek.com`, mirroring the dev server, so phone sign-in works inside the APK too.
- Building needs an Android SDK (build-tools plus any platform) and a JDK; the script looks for `ANDROID_HOME`, `%LOCALAPPDATA%\Android\Sdk`, and the JDK bundled with Android Studio.
- `-Check` additionally runs a JVM self-check of the local server (static hosting, SPA fallback, MIME types, `/__auth` proxy). That step contacts Platform and may be rate limited.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

Your API key, account token, and settings are stored in the browser's localStorage. Conversations and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, account tokens, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key, signed-in state, and other settings are preserved; files already uploaded to the API service are not deleted.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, authOrigin, authUpstream, devServer })` to customize the API origin, the same-origin prefix and upstream for official authorization, and the development server proxy.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    auth/              Official account sign-in (PKCE flow, platform endpoints, credentials, account state)
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
