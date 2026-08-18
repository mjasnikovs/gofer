# Bundled Node workers

`tauri.conf.json` bundles this directory as an application resource, so everything here reaches a
user's machine and `PathResolver::resource_dir()/workers` is where `src-tauri/src/workers.rs` looks.
Tauri's build script copies it beside the executable for unbundled builds too, which is why a
release binary in `target/release` resolves the same way a packaged one does.

Only `README.md` is tracked. The rest is built by `npm run build:workers`:

| File                | What it is                                                           |
| ------------------- | -------------------------------------------------------------------- |
| `ai-worker.mjs`     | `scripts/ai-worker.mjs` with its whole import graph inlined          |
| `ai-codex-auth.mjs` | `scripts/ai-codex-auth.mjs`, the same way                            |
| `package.json`      | A `{"type":"module"}` marker, so the bundles load wherever they land |

The directory is tracked because Tauri's build script fails the whole crate when a declared resource
path is missing, so a fresh clone must be able to run `cargo check` before it has run a Node build.

## Why the directory exists at all

A built Gofer shipped no JavaScript. `ai_turn.rs` and `chatgpt_auth.rs` resolved their worker from
`CARGO_MANIFEST_DIR/../scripts`, a path frozen into the binary when it was compiled, and read the
file fresh on every run. Nothing copied a `.mjs` into the bundle — the AppImage contained none — so
on the machine that built it, editing `scripts/ai-worker.mjs` changed what an already-built
application ran. `workers.rs` explains the resolution order that replaced it.

Two of Gofer's five workers are here. `memory-worker.mjs`, `rag-warmup.mjs` and
`rag-retrieve-worker.mjs` load `onnxruntime-node` and `@lancedb/lancedb`, which are native `.node`
binaries no bundler can inline, so those still resolve from the source tree and still carry the old
behaviour. `REDUCE-SIZE.md` in gofer-rag is the work that would let them join.
