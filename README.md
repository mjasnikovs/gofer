# Gofer

Gofer is a Tauri desktop workspace for an AI agent that will operate Godot 4.7 on a user's behalf.
This repository currently contains the application foundation and interface; the Godot connection is
intentionally represented as disconnected and is not implemented yet.

## Stack

- Tauri 2 with a Rust 2024 backend
- React 19 and Vite 8
- TypeScript 6.0, the newest release supported by the current `typescript-eslint` toolchain
- Astryx with the neutral theme
- ESLint 10 and Prettier 3 with strict, type-aware project rules

## Development

Install dependencies and start the desktop application:

```bash
npm install
npm run tauri dev
```

Start only the browser frontend with `npm run dev`.

## Godot documentation RAG

The project pins [`@mjasnikovs/gofer-rag`](https://github.com/mjasnikovs/gofer-rag) at
`0.1.0-canary.1`. It provides local retrieval and grounded answers over the Godot 4.7 documentation.

The package requires Node.js 22 or newer and is a Node-only runtime dependency, so Tauri invokes it
through `scripts/rag-warmup.mjs` instead of bundling it into the Vite browser renderer. The
preparation splash downloads approximately 1.68 GiB of embedding and reranking models when they are
missing. The Node worker aggregates their file events into one overall progress total before the
Rust backend streams it to the interface. The models remain in the operating system's user cache
until they are explicitly deleted from Settings; deletion returns the app to the preparation splash
and starts a fresh download.

## Local settings

Gofer owns a versioned `settings.json` in its operating system application configuration directory.
The first supported AI connection is an OpenAI-compatible chat-completions endpoint. Connection
metadata is stored in Gofer's settings file, while its optional API key is stored separately in the
operating system credential store. Gofer does not read or depend on Pi's agent configuration.

## Quality gates

```bash
npm run check
npm run build
```

`check` verifies formatting, type-aware ESLint, TypeScript, and the Rust crate. Use `npm run format`
and `npm run lint:fix` to apply safe automatic fixes.

Astryx's project guidance lives in `AGENTS.md`. Refresh it after an Astryx upgrade with:

```bash
npx astryx init --all --agent codex
```
