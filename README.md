<p align="center">
  <img src="assets/brand/moki-scene-focused.svg" alt="Moki working on a laptop" width="260">
</p>

<h1 align="center">A desktop AI assistant with memory you can inspect.</h1>

<p align="center">
  Moki is an open-source macOS app for talking to AI models, connecting MCP tools, and keeping optional memory on your machine.
</p>

<p align="center">
  <a href="https://github.com/capek-dev/moki/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/capek-dev/moki?color=66b8a7"></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-66b8a7"></a>
  <a href="https://bun.sh"><img alt="Bun" src="https://img.shields.io/badge/runtime-Bun-66b8a7?logo=bun"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-66b8a7?logo=typescript"></a>
</p>

<p align="center">
  <a href="https://github.com/capek-dev/moki/releases">Download</a> ·
  <a href="#setup">Setup</a> ·
  <a href="#development">Development</a>
</p>

---

## Why Moki

Most AI assistants hide how context and memory are assembled. Moki makes those parts visible and optional.

- **Bring your own model access:** Use a DeepSeek API key or sign in with ChatGPT for supported Codex models.
- **Connect tools through MCP:** Add local `stdio` or remote HTTP servers, then enable only the connections and tools you want.
- **Inspect memory:** See what Moki learned, which message supports it, why it was recalled, and remove it when it is wrong.
- **Choose what runs:** Basic recall, automatic learning, Jev routing, and smart tool loading are separate settings. Memory features are off by default.
- **Keep local control:** Conversations and memory live in local SQLite. There is no required Moki account or telemetry.

Moki is maintained by one developer. It is early software, built for real use and continued experimentation rather than presented as production-hardened.

## What Moki is not

Moki is a personal desktop assistant, not a coding workspace, IDE, or autonomous employee. It does not run models locally, and using it still sends requests to the model providers and external tools you configure.

Moki is probably not for you if you:

- want a completely offline assistant or bundled local models;
- need a turnkey product with models, tools, and cloud sync included;
- need Windows, Linux, or verified Intel Mac support;
- require enterprise support, centralized administration, or production-hardening guarantees;
- do not want to manage provider credentials or decide which tools and memory features to enable.

It is for people who want a macOS assistant they can configure, inspect, and keep under their control.

## Download

[Moki 0.1.0](https://github.com/capek-dev/moki/releases/tag/app/v0.1.0) is available for Apple Silicon as a Developer ID-signed and notarized DMG or zip. SHA-256 checksums are included with the release.

Intel Macs are not currently verified.

## Setup

1. Open **Settings > Providers** and add a DeepSeek API key or sign in with ChatGPT.
2. Optionally connect MCP servers under **Settings > Connections**.
3. Choose a model under **Settings > Moki**.
4. Start a conversation.

Memory is optional. Enable basic recall or automatic learning separately under **Settings > Memory**. A TypeSafe key is only needed for optional Jev features.

## How memory works

```text
Conversation message
└── Evidence tied to that exact message revision
    └── Memory record
        ├── Revision history
        ├── Recall history
        └── Validity status
```

Editing or deleting a source message invalidates the evidence attached to that revision. Forgetting a memory deletes it and suppresses the same fact from being immediately learned again.

Automatic learning is a separate opt-in feature. After an idle period, it reviews newly completed messages, proposes useful facts, and revalidates their sources before saving them. Learning can be disabled for individual conversations.

## What is included

| Area | Capabilities |
| --- | --- |
| **Chat** | Streamed Markdown, conversation history, edit, resend, unsend, thinking controls, context estimate |
| **Models** | DeepSeek with an API key, supported Codex models through ChatGPT sign-in |
| **Tools** | Local and remote MCP connections, per-tool controls, OAuth for compatible servers, built-in `webfetch` and Cua Driver |
| **Memory** | Local SQLite storage, source evidence, revisions, recall history, deletion, opt-in automatic learning |
| **Context** | Optional Jev tool selection and memory routing, with local fallbacks when Jev is disabled |
| **Input** | Text, native push-to-talk dictation, and region screenshots for models that accept images |
| **Desktop** | macOS app, customizable Moki avatar, conversation search, release update checks |

Moki does not bundle third-party MCP servers. Computer-use tools do not yet have per-call permission prompts.

## Privacy and network access

Moki stores conversations, settings, and memory locally. Credentials are encrypted with Electron `safeStorage`.

External services still receive the data required to do their jobs:

- Your selected model provider receives chat requests.
- Enabled MCP servers receive the arguments sent in tool calls.
- TypeSafe receives bounded context only for the Jev features you enable.
- Websites receive normal network request data when `webfetch` is used.
- GitHub is contacted for release update checks.

`webfetch` blocks local and private destinations, checks redirects, limits downloads to 5 MB, and truncates content before returning it to the model.

## Build from source

Requires macOS, [Bun](https://bun.sh) 1.4.0, and Xcode command-line tools.

```bash
bun install
bun run build
bun run desktop
```

## Development

```bash
bun run typecheck
bun run build
bun run test:foundation
bun run dev
```

`bun run dev` starts Vite on `127.0.0.1:5173` and uses a separate Moki Dev profile.

Moki is built with Electron, React, TypeScript, Bun, Capek model adapters, the AI SDK, and TypeSafe's SDK. Foundation tests run offline. They do not prove live provider access, real MCP connections, or retrieval quality.

Imports use path aliases only: `@shared/*`, `@renderer/*`, `@electron/*`, `@backend/*`, and `@scripts/*`.

## Contributing

Issues and focused pull requests are welcome. Include the behavior you observed, what you expected, and how you verified the change.

## License

[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). A local copy of the license text still needs to be added to this repository.
