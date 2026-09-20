# Moki

**A small personal assistant for testing how far memory, context, and large tool catalogs can go.**

Moki is a macOS desktop assistant that starts simple: one chat, one assistant, and only the abilities you choose to connect through [MCP](https://modelcontextprotocol.io/).

The experiment underneath is less simple. Moki is exploring whether an assistant can:

- remember useful facts without turning every conversation into permanent memory;
- keep evidence and revisions attached to what it learns;
- retrieve context by meaning, topics, and entities instead of only text matches;
- work with large MCP tool catalogs without placing every schema in every prompt;
- remain understandable and controllable by the person using it.

> [!WARNING]
> **Moki has just started.** It is evolving, macOS-first, solo-maintained, and not ready for public distribution. Memory quality, Jev-assisted retrieval, and large-catalog tool selection are active experiments, not solved problems.

## The idea

A useful personal assistant needs more than a chat box.

It needs a model to think, tools to act, and memory to carry useful context forward. Moki keeps those parts separate:

```text
Chat model                 Context layer                 Abilities
DeepSeek V4.1 Flash   ->   local memory + Jev     ->    MCP servers
Codex subscription         recall + learning             Cua Driver
```

You bring the model access. You connect the abilities. You explicitly choose whether memory, automatic learning, Jev routing, and smart tool loading are allowed.

Nothing here is silently enabled because it sounds convenient.

## What works today

### Bring your own model access

Moki currently supports:

- **DeepSeek V4.1 Flash** with your own DeepSeek API key.
- **Codex subscription** through ChatGPT browser sign-in.
- **TypeSafe Jev** with your own TypeSafe API key for experimental context routing.

Credentials are encrypted with Electron `safeStorage` and are not returned to the renderer. Model availability is still decided by each provider.

### Give Moki abilities through MCP

Add local `stdio` or remote Streamable HTTP MCP servers from Settings. Moki can:

- discover each server's tools;
- enable or disable whole connections;
- disable individual tools;
- sign in to compatible remote MCP servers through OAuth;
- cache catalogs and fall back to the last known catalog when a server is temporarily unreachable;
- merge connected tools into the agent's toolset.

Moki ships with no user-added MCP servers. You decide what it can reach.

[Cua Driver](https://cua.ai/) is also supported as a built-in MCP connection for computer-use tools on your Mac. Computer-use permission gating is not implemented yet, so every enabled Cua tool is available to the agent.

### Fetch public web pages

Moki includes a built-in `webfetch` tool. It can fetch public HTTP or HTTPS URLs and return Markdown, plain text, or HTML without a per-call approval prompt. It blocks local and private network destinations, checks every redirect, stops after five redirects, limits downloads to 5 MB, and truncates model-facing output.

### Try large tool catalogs without dumping everything into context

When smart tool loading is enabled, Jev scores likely tools for the current request. Moki loads a bounded set of their schemas directly and keeps the rest available through local `search_tools` and `call_tool` discovery tools.

Without Jev, Moki falls back to a bounded names-only index and local tool search. Chat still works.

This is one of the project's main questions: **can an assistant use hundreds of possible actions without paying the full context cost on every turn?**

### Memory that you have to opt into

Memory recall is **off by default**. Automatic learning is a separate switch and is also **off by default**.

When enabled, the current implementation provides:

- local SQLite storage;
- basic local recall;
- an explicit memory tool for the current request;
- searchable, paginated saved memories;
- edit, pin, inspect, and forget controls;
- source-message evidence and revision tracking;
- topic, entity, and relationship records;
- learning history with revision-safe undo;
- per-conversation learning exclusions.

Automatic learning reviews only new completed messages after you enable it. It does not backfill old conversations. Only user statements may support learned facts; assistant text is treated as context.

### Jev as the experimental context layer

[TypeSafe Jev](https://typesafe.ai/) is important to what Moki is trying to test. Today it is used for three separate jobs:

1. **Smart tool loading** chooses which tool schemas should enter the prompt directly.
2. **Contextual memory routing** uses bounded evidence plus learned topic and entity descriptors to select relevant memories.
3. **Learning verification** checks a proposed fact against the user message cited as evidence before it is saved.

Each path has its own conditions and consent. Connecting Jev does not automatically enable memory, learning, or Jev memory routing.

The limits are real:

- Jev recall falls back to basic local recall when the descriptors it needs do not exist yet.
- If TypeSafe is unreachable, learning can continue without the additional Jev verification step.
- Live Jev retrieval quality is not yet verified.

That is why Moki exposes recall history, learning runs, evidence, revisions, and fallback status instead of pretending the context pipeline is magic.

## Privacy and control

Moki's current rules are deliberately explicit:

| Capability | Default | What leaves your Mac when enabled |
| --- | --- | --- |
| Basic memory recall | Off | Nothing. Retrieval is local. |
| Automatic learning | Off | Bounded conversation excerpts go to your selected chat provider. |
| Jev memory routing | Off | The request, bounded recent evidence, and bounded topic/entity descriptors go to TypeSafe. |
| Jev learning verification | Requires a saved TypeSafe key | Bounded source excerpts and proposed facts go to TypeSafe. |
| Smart tool loading | Off | Bounded message context plus tool names and short descriptions go to TypeSafe. Tool schemas and attachments are not sent. |
| Public web fetch | Always available, no prompt | The requested URL, request headers, and normal network metadata go to the destination server. Local and private destinations are blocked. |

MCP servers receive whatever an enabled tool call sends them. Review connections and tool switches before using them.

## Other current features

- streamed Markdown replies;
- conversation history in SQLite;
- per-conversation model selection and thinking level;
- screenshot questions with model-gated image input;
- native push-to-talk dictation on macOS;
- edit, resend, or unsend your messages;
- a context-usage estimate for the next turn;
- built-in search across older conversations;
- separate chat, history, settings, and learning-review windows.

## Build it locally

### Requirements

- macOS
- Bun **1.4.0**
- Xcode command-line tools

```sh
bun install
bun run build
bun run desktop
```

`desktop` opens the Electron application. It does not start a development server. Closing the window hides Moki; use the tray, Dock, or Quit action to reopen or stop it.

### Connect the pieces

1. Open **Settings > Providers**.
2. Add a DeepSeek API key or sign in with your ChatGPT account for Codex.
3. Optionally add a TypeSafe API key for Jev.
4. Open **Settings > Connections** and add the MCP servers you want Moki to use.
5. Open **Settings > Memory** and explicitly enable recall, learning, or Jev routing if you want to test them.
6. Choose the chat provider and model under **Settings > Moki**, then start a conversation.

## Development

```sh
bun run typecheck
bun run build
bun run test:foundation
bun run package:dir
```

The foundation checks are offline. They do not prove live provider access, a real MCP connection, native permission flows, Jev retrieval quality, or the packaged GUI. Those still require focused or manual verification.

For renderer development:

```sh
bun run dev
```

This starts Vite on `127.0.0.1:5173` and opens the separate **Moki Dev** app profile. Production builds remain server-free.

Imports use path aliases only:

```text
@shared/*
@renderer/*
@electron/*
@backend/*
@scripts/*
```

## Architecture

```text
src/electron   Electron windows, tray, native permissions, encrypted credentials
src/backend    Bundled Bun runtime, chat loop, MCP clients, memory, SQLite
src/renderer   React interface with no direct network or filesystem access
src/shared     Typed IPC contracts and runtime validation
src/native     macOS dictation helper
tests          Focused offline and source-level checks
```

Moki is built with Electron, React, TypeScript, Bun, Čapek model adapters, the AI SDK, and TypeSafe's SDK.

## Current boundaries

Before trying Moki, know what it is not yet:

- not signed, notarized, or ready for public macOS distribution;
- not production-hardened;
- not verified on Intel Macs;
- not equipped with per-call computer-use permission prompts;
- not able to accept arbitrary file attachments;
- not proof that the current memory or Jev approach is the right one.

The point of the project is to make those experiments concrete enough to inspect, run, break, and improve.

## Contributing

Issues and focused pull requests are welcome. Please describe the behavior you observed, the behavior you expected, and how you verified the change.

This is a young, solo-maintained project. Small changes with clear boundaries are much easier to review than broad rewrites.

## License

All source code in this repository is licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

The repository does not include a local copy of the license text yet. The linked canonical terms apply.
