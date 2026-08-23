# Bundled Node workers

`tauri.conf.json` bundles this directory as an application resource, so everything here reaches a
user's machine and `PathResolver::resource_dir()/workers` is where `src-tauri/src/workers.rs` looks.
Tauri's build script copies it beside the executable for unbundled builds too, which is why a
release binary in `target/release` resolves the same way a packaged one does.

Only `README.md` is tracked. The rest is built by `npm run build:workers`:

| File                      | What it is                                                           |
| ------------------------- | -------------------------------------------------------------------- |
| `ai-worker.mjs`           | `scripts/ai-worker.mjs` with its whole import graph inlined          |
| `ai-codex-auth.mjs`       | `scripts/ai-codex-auth.mjs`, the same way                            |
| `rag-warmup.mjs`          | `scripts/rag-warmup.mjs`, the same way                               |
| `rag-retrieve-worker.mjs` | `scripts/rag-retrieve-worker.mjs`, the same way                      |
| `memory-worker.mjs`       | `scripts/memory-worker.mjs`, the same way                            |
| `node_modules/`           | The three native packages the last three need, and their closure     |
| `.lancedb/`               | The Godot documentation table, 40 MB, copied out of gofer-rag        |
| `package.json`            | A `{"type":"module"}` marker, so the bundles load wherever they land |

The directory is tracked because Tauri's build script fails the whole crate when a declared resource
path is missing, so a fresh clone must be able to run `cargo check` before it has run a Node build.

## Why the directory exists at all

A built Gofer shipped no JavaScript. `ai_turn.rs` and `chatgpt_auth.rs` resolved their worker from
`CARGO_MANIFEST_DIR/../scripts`, a path frozen into the binary when it was compiled, and read the
file fresh on every run. Nothing copied a `.mjs` into the bundle — the AppImage contained none — so
on the machine that built it, editing `scripts/ai-worker.mjs` changed what an already-built
application ran. `workers.rs` explains the resolution order that replaced it.

All five are here now. `memory-worker.mjs`, `rag-warmup.mjs` and `rag-retrieve-worker.mjs` load
`onnxruntime-node`, `@lancedb/lancedb` and `sharp` through a require computed at run time, which no
bundler can follow. Those three are left external and their dependency closure is copied into
`node_modules/` beside the bundles, where Node finds them by walking up. Only this host's binaries
are copied: following every optional dependency shipped every other platform too, and onnxruntime's
CUDA provider alone is 316 MB.

## The documentation table

gofer-rag publishes its LanceDB table inside its own package and finds it by resolving one directory
up from its own module file. Inlining the package moved that file here, so the guess became the
resource root, which holds no database — every warmup failed on `Table 'chunks' was not found` after
downloading 1.8 GB of models first. The table is copied beside the bundles and `rag.rs` names it
outright through `GOFER_RAG_DATABASE_PATH`, so nothing depends on where a third-party package thinks
its own root is. A source-tree build has no table here and needs none.
