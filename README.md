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
