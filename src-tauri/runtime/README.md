# The bundled Node runtime

`tauri.conf.json` bundles this directory as an application resource, so what lands here reaches a
user's machine and `PathResolver::resource_dir()/runtime` is where `src-tauri/src/workers.rs` looks
for it.

Only `README.md` is tracked. The binary is written by `npm run build:node-runtime`, from the pin in
`protocol/node-runtime.json`.

| File               | What it is                                             |
| ------------------ | ------------------------------------------------------ |
| `node`, `node.exe` | The pinned Node executable, and nothing else around it |

The directory is tracked because Tauri's build script fails the whole crate when a declared resource
path is missing, so a fresh clone must be able to run `cargo check` before it has downloaded
anything.

## Why it ships

Every AI turn, the memory embedder and both documentation workers are JavaScript, and Rust spawns
them. The binary used to be whatever `node` PATH answered with. A machine with no Node failed at the
first AI turn; a macOS one failed even with Node installed, because a GUI-launched `.app` inherits
`/usr/bin:/bin:/usr/sbin:/sbin` and never reads a shell profile, so nvm and Homebrew installs are
invisible to it. `GOFER_NODE_BINARY` still overrides what is here.
