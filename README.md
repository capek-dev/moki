# Povondra

A macOS-first, minimal desktop assistant built with Electron, React, and a bundled Bun 1.4.0 runtime using Čapek.

## Current slice

Text chat with DeepSeek and Codex subscription: editable assistant profiles, a per-conversation model picker, streamed replies, Stop, and SQLite-saved history. A small chat window, separate Settings, tray reopen/quit, and optional always-on-top. No workspace setup. Existing local notes are retained as user messages.

Settings (Cmd+,) now supports DeepSeek API key verification/storage and Codex subscription sign-in. Credentials are encrypted using Electron safeStorage under userData, never returned to the UI. One subscription is stored initially. Codex opens a browser and completes sign-in automatically through a temporary localhost callback on port 1455. The listener binds only to IPv4/IPv6 loopback and closes on completion, cancellation, timeout, or Quit. Sign-in expires after five minutes. If another app is using port 1455, close its sign-in attempt before retrying. Disconnect removes local credentials, it does not revoke the upstream grant.

To chat: connect a provider, select it under Settings > Assistants, start a conversation, select a model, and Send. Model choices come from a curated Jean2 catalog, not a guarantee of subscription availability. No automatic fallback. Codex refreshes expired credentials before a turn; rejected access requires reconnecting rather than replaying a turn. Disconnect removes credentials for future turns; use Stop to abort a running reply.

Replies use Čapek's published model adapters and AI SDK streaming, not the full agent/tool loop yet. **MCP/cua.ai, screenshots, memory, session search, and learning remain unimplemented.** Text-only history displays the latest 100 messages and sends up to 60k characters of recent completed history. The picker lists the latest 100 conversations; older records stay on disk. Replies are limited to three minutes and 64k characters. Interrupted/failed partial replies are saved but not replayed into subsequent model context. No reasoning logs or tool cards.

Automated verification uses offline provider responses; live model access and native UI need manual verification. Codex browser sign-in was confirmed working by the user before this slice.

Provider-focused checks: `bun test tests/provider-connections.test.ts tests/settings-window.test.ts tests/desktop-paths.test.ts` after building.

## Build and open

Requires macOS, Bun **1.4.0**, and Xcode command-line tools for local signing. The existing Git repository is used as-is.

```sh
bun install
bun run build
bun run desktop
```

`desktop` opens the native application, not a development server. Closing its window hides it; use the tray or Dock to reopen. Use Quit to stop the app and background process.

## Focused verification

```sh
bun run typecheck
bun run build
bun run test:foundation
bun run package:dir
```

The tests require a preceding build. They exercise only the foundation: validation, SQLite persistence, compiled runtime startup with an empty PATH, Čapek import, pipe requests, and shutdown. They do not open Electron windows or call model providers.

On Apple Silicon, the local package is `release/mac-arm64/Povondra.app`. To test the actual bundled backend:

```sh
POVONDRA_TEST_BINARY="release/mac-arm64/Povondra.app/Contents/Resources/backend/povondra-runtime" bun run test:foundation
```

Builds target the current machine's architecture. Cross-architecture packaging is not supported by this script yet. Local builds refresh the compiled Bun executable's ad-hoc signature. The outer app is unsigned, uses the default Electron icon, and is **not ready for public distribution**. Developer ID signing, hardened-runtime verification, notarization, and Intel verification remain release work.

## Layout

- `src/electron`: windows/tray, sandboxed preload, private runtime transport.
- `src/backend`: bundled Bun process and SQLite persistence in Electron's userData directory.
- `src/renderer`: React conversation and assistant UI; no network or filesystem access.
- `src/shared`: typed IPC contract; backend validates incoming values at runtime.
- `docs/plans`: product direction and bounded implementation slices.

Jean2's `bunfig.toml` is copied unchanged, including the three-day dependency release cooldown and Čapek exclusions. Only Electron's install script is trusted. The blocked `electron-winstaller` install script is not needed for this macOS slice.

Chat checks: `bun test tests/chat.test.ts tests/model-stream.test.ts tests/provider-refresh.test.ts`. These cover additive data migration, streamed persistence/cancellation, stale events, fixed credential endpoints, actual adapter payloads for both providers, and refresh races. No live credentials or provider calls are used.

Next: full agent/tool execution, MCP integration, knowledge scope, and computer-use permissions from the product plan.
