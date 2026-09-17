# Moki

A macOS-first, minimal desktop assistant built with Electron, React, and a bundled Bun 1.4.0 runtime using Čapek.

## Current slice

Chat with DeepSeek and Codex subscription: one Moki with editable instructions, provider, and avatar, a per-conversation model picker, streamed replies, Stop, saved screenshot questions, and SQLite history. A small chat window, separate Settings, tray reopen/quit, and optional always-on-top. No workspace setup. Existing local notes are retained as user messages.

Settings (Cmd+,) now supports DeepSeek API key verification/storage and Codex subscription sign-in. Credentials are encrypted using Electron safeStorage under userData, never returned to the UI. One subscription is stored initially. Codex opens a browser and completes sign-in automatically through a temporary localhost callback on port 1455. The listener binds only to IPv4/IPv6 loopback and closes on completion, cancellation, timeout, or Quit. Sign-in expires after five minutes. If another app is using port 1455, close its sign-in attempt before retrying. Disconnect removes local credentials, it does not revoke the upstream grant.

To chat: connect a provider, select it under Settings > Moki, start a conversation, select a model, and Send. Model choices come from a curated Jean2 catalog, not a guarantee of subscription availability. No automatic fallback. Codex refreshes expired credentials before a turn; rejected access requires reconnecting rather than replaying a turn. Disconnect removes credentials for future turns; use Stop to abort a running reply. Hover any of your own messages to **Unsend** it (its text returns to the composer) or **Edit and resend** it; both remove everything after that message, including replies and their screenshots.

Replies use Čapek's published model adapters and AI SDK streaming, not the full agent/tool loop yet. **MCP/cua.ai, arbitrary file attachments, memory, session search, and learning remain unimplemented.** History displays the latest 100 messages and sends up to 60k characters of recent completed text plus a separately bounded set of saved screenshots. The picker lists the latest 100 conversations; older records stay on disk. Replies are limited to three minutes and 64k characters. Interrupted/failed partial replies are saved but not replayed into subsequent model context. No reasoning logs or tool cards.

Automated verification uses offline provider responses; live model access and native UI need manual verification. Codex browser sign-in was confirmed working by the user before this slice.

Provider-focused checks: `bun test tests/provider-connections.test.ts tests/settings-window.test.ts tests/desktop-paths.test.ts` after building.

## Screenshot questions

Press **Cmd+Shift+8** from any app, choose **Capture region…** from Moki's tray/menu, or use the capture button beside the model picker. Drag over a rectangular screen region, then Moki opens with the screenshot previewed and the prompt focused. Escape cancels selection without changing the current draft. Screenshots are saved with their user messages and can be opened at a larger size from conversation history.

macOS requires Screen Recording permission. If access is denied, Moki links to System Settings and may need to be restarted after permission changes. The native region selector handles Retina and multiple-display selection. If the global shortcut is already used by another app, the tray and composer actions remain available.

Image input is model-gated. DeepSeek Flash and the curated Codex models send the screenshot as actual multimodal input; DeepSeek V4 Pro remains text-only. Moki disables Send rather than dropping the image or silently switching models. Screenshot files remain in Moki's private data directory, while renderer APIs use random attachment IDs instead of local paths.

Automated checks inspect serialized DeepSeek and Codex payloads without live provider calls. Native selection, Screen Recording consent, multiple displays, and live image interpretation still require manual Electron verification.

## Readable answers

Assistant replies render Markdown with headings, lists, tables, quotes, and code blocks, including partial replies. User messages stay plain text. **Copy answer** copies the original Markdown; **Copy code** copies only that block's text. Both report clipboard success or failure.

Raw HTML is disabled. Images display alt text without loading remote resources. HTTP(S) links open in the default browser on click; file, script, relative, and credential-bearing URLs are not clickable. Clipboard access is write-only through validated Electron IPC.

Focused checks: `bun test tests/answer.test.tsx tests/screenshot.test.tsx tests/chat.test.ts tests/model-stream.test.ts`. Native clipboard, browser opening, screen capture, and visual layout still require manual Electron verification.

## Single Moki

Chat and settings expose one Moki, with no companion picker or creation flow. Existing assistant records remain intact for future multi-assistant support. Earlier conversations belonging to other records remain visible in History as read-only; New conversation always uses Moki. Stored custom names and historical attribution are not rewritten. Dynamic memory and skill loading are a future capability, not part of this UI change.

## Build and open

Requires macOS, Bun **1.4.0**, and Xcode command-line tools for local signing. The existing Git repository is used as-is.

```sh
bun install
bun run build
bun run desktop
```

`desktop` opens the native application, not a development server. Closing its window hides it; use the tray or Dock to reopen. Use Quit to stop the app and background process.

## Development

Run `bun run dev` to build the isolated Electron shell/backend, start Vite on `127.0.0.1:5173`, and open **Moki Dev** with detached DevTools. Right-click **Inspect Element**, or press **Cmd+Option+I**, in chat, Settings, or History.

On macOS, the first run prepares the ignored `dist/dev-shell/Moki Dev.app` with the stable bundle identifier `app.moki.desktop.dev` and a Screen Recording usage description. Grant Screen Recording to that exact app, not `node_modules/electron/dist/Electron.app`. After changing the permission, fully quit and rerun `bun run dev`. The cached app is rebuilt only when its preparation revision or Electron version changes.

React component and CSS changes hot reload. Source maps expose TSX in DevTools. Changes to Electron, preload, backend, or build configuration require stopping and rerunning `bun run dev`. Some shared-module edits cause a full page reload, which resets unsent drafts.

Development uses a separate `Moki Dev` profile with its own chats and provider connections. Connect providers separately in its Settings. Normal `bun run desktop` and packaged builds remain server-free and use their existing data. The server uses a fixed port and refuses to start if it is occupied. Ctrl+C or quitting the dev app stops the server too.

`bun run build:dev` builds only the dev shell/backend without starting anything. Production renderer CSP stays unchanged; only the development HTML permits Vite's inline refresh preamble and loopback WebSocket connection.

## Focused verification

```sh
bun run typecheck
bun run build
bun run test:foundation
bun run package:dir
```

The tests require a preceding build. They exercise only the foundation: validation, SQLite persistence, compiled runtime startup with an empty PATH, Čapek import, pipe requests, and shutdown. They do not open Electron windows or call model providers.

On Apple Silicon, the local package is `release/mac-arm64/Moki.app`. To test the actual bundled backend:

```sh
MOKI_TEST_BINARY="release/mac-arm64/Moki.app/Contents/Resources/backend/moki-runtime" bun run test:foundation
```

Builds target the current machine's architecture. Cross-architecture packaging is not supported by this script yet. Local builds refresh the compiled Bun executable's ad-hoc signature. The outer app is unsigned, uses the default Electron icon, and is **not ready for public distribution**. Developer ID signing, hardened-runtime verification, notarization, and Intel verification remain release work.

## Rename compatibility

The checkout directory is unchanged. New installs use the `Moki` Electron profile and `moki.sqlite`. Existing `Povondra`/`povondra` profiles and `povondra.sqlite` are reused in place, without copying or deleting data. Ambiguous profiles/databases stop startup rather than choosing a history silently. Existing companion IDs, customized names, avatars, and historical message attribution remain intact; the old default companion display name becomes Moki. Saved appearance preferences fall back to the legacy keys. Encrypted provider files are retained, but macOS Keychain access under the new application identity needs native verification.

The backend now requires `MOKI_DATA_DIR`. Rebuild before launching; existing release artifacts are not renamed in place.

## Layout

- `src/electron`: windows/tray, sandboxed preload, private runtime transport.
- `src/backend`: bundled Bun process and SQLite persistence in Electron's userData directory.
- `src/renderer`: React conversation and assistant UI; no network or filesystem access.
- `src/shared`: typed IPC contract; backend validates incoming values at runtime.
- `docs/plans`: product direction and bounded implementation slices.

Jean2's `bunfig.toml` is copied unchanged, including the three-day dependency release cooldown and Čapek exclusions. Only Electron's install script is trusted. The blocked `electron-winstaller` install script is not needed for this macOS slice.

Chat checks: `bun test tests/chat.test.ts tests/model-stream.test.ts tests/provider-refresh.test.ts`. These cover additive data migration, streamed persistence/cancellation, stale events, fixed credential endpoints, actual adapter payloads for both providers, and refresh races. No live credentials or provider calls are used.

Next: full agent/tool execution, MCP integration, knowledge scope, and computer-use permissions from the product plan.
