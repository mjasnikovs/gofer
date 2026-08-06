# Gofer

Gofer is a Tauri desktop workspace for an AI agent that operates Godot 4.7 on a user's behalf. It
runs one managed Godot editor session bound to the active task's isolated Git worktree, launches the
game through that editor's own debug adapter, streams editor output into the UI, and persists
compressed run logs.

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

### The workspace Gofer manages

Gofer manages the directory it was started in. `tauri dev` runs the binary from `src-tauri`, which
is not a Godot project, so a development run has to be told where the project is:

```bash
GOFER_WORKSPACE_DIR=/path/to/your/godot/project npm run tauri dev
```

A built Gofer takes the directory it is launched from. Either way the directory must contain
`project.godot`; a session refuses one that does not, and says which directory it looked in.

## Godot documentation RAG

The project pins [`@mjasnikovs/gofer-rag`](https://github.com/mjasnikovs/gofer-rag) at
`0.1.0-canary.1`. It provides local retrieval and grounded answers over the Godot 4.7 documentation.

The package requires Node.js 22.19 or newer and is a Node-only runtime dependency, so Tauri invokes
it through `scripts/rag-warmup.mjs` instead of bundling it into the Vite browser renderer. The
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

Chat completions run through a Gofer-owned Node worker backed by
[`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai). The channel
between them is duplex NDJSON: Rust sends the connection settings, conversation, credential, and
tool catalog as the first line, the worker asks for tools on standard output, and Rust answers on
the same standard input it opened with — all while Pi's streaming response events are forwarded to
the interface. The local provider uses the configured base URL and model with the
`openai-completions` dialect, disables developer-role and reasoning-effort fields for llama.cpp
compatibility, and uses `local` as the harmless placeholder API key when no credential is stored.

## AI tool router

The agent reaches Godot through ten compact domain tools — `godot_session`, `godot_scene`,
`godot_node`, `godot_project`, `godot_resource`, `godot_script`, `godot_debug`, `godot_runtime`,
`godot_logs`, and `godot_docs_search` — each taking an `op` plus that operation's parameters. The
worker implements none of them: it forwards every call to `src-tauri/src/ai_tools.rs`, which routes
it to the same handler the renderer's own command calls, so a scene the agent edits goes through the
same undo stack, revision check, and worktree binding as one the user edits. The catalog in that
module generates the tool descriptions the model sees and validates the operations it may call, so
the two cannot drift apart. Captured frames come back as real images rather than base64 text, and
every failure keeps its structured code — `revision_conflict` stays `revision_conflict`.

## Local project data

Gofer's Rust backend owns durable project data. A small `catalog.sqlite` in the operating system
application-data directory maps canonical workspace paths to stable project IDs. Each project has an
isolated `project.sqlite` containing tasks, messages, agent context, and attachment metadata. SQLite
runs with WAL mode and foreign keys enabled.

Attachment bytes are stored outside SQLite in a project-scoped, SHA-256-addressed blob store. The
database retains their names, media types, sizes, hashes, and message relationships. Existing chat
history in browser `localStorage` and its legacy attachment directory is imported once when an empty
project database is first opened; the renderer then removes the migrated browser record.

Tasks remain independently resumable. Git projects automatically receive an isolated `gofer/task-*`
worktree with its branch, base, head, and merge commits recorded. Creating a task does not close
other tasks; selecting one changes only the project's current task pointer. The task merge action
commits pending task changes and creates a merge commit on a clean main worktree.

Godot runs are tied to tasks and to the editor session that produced them. The managed session opens
a run when the editor starts and closes it when the editor stops, draining its output buffer into
project-scoped `.jsonl.zst` segments while warning and error records are indexed with SQLite FTS5.
The Output panel's History search reads that index, so a warning from a session that has already
stopped is still findable; runs recorded before Gofer managed the editor keep their segments and
their index rows and simply name no session. Normal informational output therefore does not cause
unbounded growth in the relational tables.

Project memory is canonical SQLite data with explicit project/task scope, kind, lifecycle state,
provenance, and supersession. FTS5 provides exact retrieval. Normalized 1,024-dimensional Qwen3
embeddings are stored alongside the source records and indexed by the statically linked, exactly
pinned `sqlite-vec` 0.1.9 extension. Hybrid search combines lexical and vector ranks; changing a
memory's content or scope invalidates its old embedding.

Successful AI turns automatically create task-scoped summary memories. A persistent local embedding
worker indexes them, and subsequent requests receive a hybrid retrieval of confirmed project and
active-task memories. SQLite remains the canonical store; no external database service is required.

Settings can create a consistent project backup containing SQLite data, attachments, logs, and a
manifest. Maintenance removes unreferenced attachments after 24 hours, completed Godot runs after 30
days, retains the five newest backups, and re-embeds memories whose vector is missing because the
embedding worker was unavailable or because an edit invalidated it.

## Godot addon staging

The Gofer editor addon ships inside the Rust binary and is copied into the active task worktree as
`res://addons/gofer` with a manifest listing the content hash of every file Gofer wrote.
`project.godot` receives exactly two entries — the `res://addons/gofer/plugin.cfg` editor plugin and
the `GoferRuntime` autoload — and Git's per-repository `info/exclude` receives one pattern, never
`.gitignore`. Linked worktrees share that exclude file, so the pattern is written once and removed
only when the last task session that needed it stops.

A cleanup ledger in Gofer's application-data directory records what was introduced and what existed
beforehand, and it is written before the worktree is touched, so a crashed session is repairable.
Cleanup removes only Gofer's own entries: a plugin enabled or an autoload added while the session
ran survives, and an `addons/gofer` that Gofer did not install is refused rather than overwritten.
The editor session that stages and stops the addon arrives with the session supervisor.

## Third-party notices

`THIRD-PARTY-NOTICES.md` records what reaches a user's machine through Gofer's own files rather than
through a package manager: the MIT-licensed godot-ai patterns the editor addon adapts, the Godot
documentation and source the transports were written against, Monaco, and the pinned `gdformat`
sidecar. Dependencies installed by npm and Cargo carry their licences in `package-lock.json` and
`src-tauri/Cargo.lock`.

## Quality gates

```bash
npm run check
npm run build
```

`check` verifies formatting, type-aware ESLint, TypeScript, and the Rust crate. Use `npm run format`
and `npm run lint:fix` to apply safe automatic fixes.

### The live sweep

`npm run check` stubs what it has to. One suite stubs nothing:

```bash
npm run build:desktop:test
node node_modules/@wdio/cli/bin/wdio.js run wdio.live.conf.ts
```

It drives the built application against a real Godot project — `~/hub/test-gd` unless
`GOFER_LIVE_WORKSPACE` says otherwise — with the AI endpoint you configured, the retrieval models in
your own cache, and a real windowed Godot 4.7. Only the application data directory is redirected
(`/tmp/gofer-live-run`), so a sweep cannot touch your projects; the task worktrees it creates live
there too. Between runs:

```bash
rm -rf /tmp/gofer-live-run
git -C ~/hub/test-gd worktree prune
git -C ~/hub/test-gd branch | grep gofer/task | xargs -r git -C ~/hub/test-gd branch -D
```

Nothing in the suite waits on a clock. Every wait runs inside the page, resolves the instant its
condition holds or the application reports a failure, and gives up the moment the application stops
doing anything at all — no DOM mutation, no backend event, no command in flight, nothing on screen
claiming to be busy — quoting what the window actually showed. It is not part of `npm run check`,
because it needs a display, a Godot install, and a model server that a CI machine does not have.

Astryx's project guidance lives in `AGENTS.md`. Refresh it after an Astryx upgrade with:

```bash
npx astryx init --all --agent codex
```
