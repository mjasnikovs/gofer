# Gofer ↔ Godot 4.7.1 Integration — build log

Complete. Every step below shipped and is proven by the suite named with it. This file is the record
of what was built and where it lives; it is no longer a plan.

**What it is:** one Gofer-managed, task-bound Godot 4.7.1-stable editor session over four direct
transports — Gofer's loopback TCP RPC (protocol v2), Godot's native TCP LSP, Godot's native TCP DAP,
and confined filesystem access. No MCP, no Python service, no HTTP tool endpoint. The frozen
`gdformat` executable is the only Python-derived sidecar and needs no user-installed Python.

The editor-plugin/main-thread and runtime-helper patterns are selectively adapted from the
MIT-licensed [godot-ai](https://github.com/hi-godot/godot-ai) architecture, attributed in the addon
comments and in the third-party notices.

## Log

1. **Protocol v2 frozen.** Handshake, request, response, event, error, tagged values, revisions,
   limits, compatibility rules; golden fixtures consumed by Rust, TypeScript, and GDScript;
   compatibility matrix in `protocol/README.md`. Fixture consumption is test-only —
   `protocol_test.gd` reaches them through `res://../../protocol/fixtures`, which never resolves in
   the shipped addon.

2. **Addon packaged and staged.** `src-tauri/addon/` holds `plugin.cfg`, `plugin.gd`, `protocol.gd`,
   and `runtime.gd`, embedded with `include_str!`. `protocol.gd` carries what the editor plugin and
   the in-game helper must encode identically — tagged values and PNG frames — because they run in
   two processes and the game cannot load an `EditorPlugin`. `src-tauri/src/addon.rs` is the stager:
   `stage` installs through `Workspace`, `unstage` removes only ledger-recorded entries (including
   the `.uid` sidecars Godot writes beside staged scripts), and `repair` clears a crashed session's
   leftovers. The ledger is written before the worktree changes; the Git exclude pattern is
   refcounted across worktrees sharing one Git common directory, and a pattern the user wrote is
   never removed. `.gitignore` is never edited.

3. **Session supervisor.** Verifies Godot 4.7.1, binds the RPC listener, allocates LSP/DAP ports,
   launches with `--editor --path --lsp-port --dap-port`, retries port collisions three times, and
   supervises shutdown. Because the LSP binds the machine-wide `network/language_server/remote_host`
   EditorSetting, the supervisor verifies that setting is loopback rather than trusting the port
   override.

4. **Persistent editor RPC.** Authenticated handshake (random loopback port plus a 256-bit token
   through the editor environment), request correlation, timeouts, heartbeats, event sequencing,
   cancellation, 1 MiB payload cap / 16 MiB frame cap, reconnect rules. Newline-delimited JSON over
   `TCPServer`/`StreamPeerTCP`, which keeps an async runtime and a WebSocket crate out of the tree.

5. **Read-only inspection shipped.** `start_godot_session`, `stop_godot_session`,
   `get_godot_session`, `call_godot`, `subscribe_godot_events`, `unsubscribe_godot_events`,
   `respond_tool_approval`. Every session binds to the active task's isolated worktree and fails
   with a structured error instead of falling back to the root workspace — the fallback would have
   installed the addon into the user's own checkout.

6. **Undoable scene authoring.** Mutations through `EditorUndoRedoManager`, scene revisions, dirty
   state, save as a separate explicit operation; mutation blocked while importing, playing,
   disconnected, or revision-stale.

7. **Filesystem centralized.** `src-tauri/src/files.rs` is the single implementation: `Workspace`
   resolves every path against the canonical worktree root, `write`/`edit`/`delete` carry the
   SHA-256 the caller expected to replace, and `spawn_watcher` debounces external changes into
   settled batches, reporting paths only. Renderer commands: `read_workspace_file`,
   `write_workspace_file`, `edit_workspace_file`, `move_workspace_path`, `delete_workspace_path`,
   `watch_workspace_files`, `unwatch_workspace_files`.

8. **Native LSP connected.** `src-tauri/src/godot_lsp.rs` — Content-Length framing, correlation,
   cancellation, document lifecycle; hover, completion/resolve, signature help, definition,
   declaration, references, highlights, document symbols, prepare-rename, rename. Non-loopback
   transports refused. 30 s default timeout, 60 s for initialize, because the server answers from
   the editor main loop in 100 ms poll slices. `workspace_symbols` is synthesized by indexing each
   script's document symbols — Godot 4.7 reports `workspaceSymbolProvider: false`. Rename lands
   through `plan_workspace_edit`/`commit_planned_edit`: one optimistic-concurrency transaction that
   rolls every earlier file back when a later one conflicts. Positions map as UTF-16 code units.

9. **Deterministic formatting.** The pin was proven before adoption: `fixtures/gdformat/probe.gd`
   exercises 4.7-era syntax against gdtoolkit 4.5.0 — every fixture parses, output is idempotent,
   invalid syntax exits non-zero with no stdout. `src-tauri/src/gdformat.rs` resolves
   `GOFER_GDFORMAT` or the bundled resource directory (never PATH, which would bypass the pin),
   requires exactly `gdformat 4.5.0`, and pipes the buffer through stdin with a 1 MiB source cap, 4
   MiB output cap, and a 30 s deadline. The formatter never touches the source file:
   `format_gdscript` returns the buffer with a `changed` flag and the renderer applies through
   `write_workspace_file`.

10. **Monaco integrated.** `src-tauri/src/script.rs` connects lazily to the session's `--lsp-port`,
    keyed by port and worktree, and owns the document version — assigned on open, on every debounced
    change, and on save — which is what keeps a UI edit and an AI edit of one file from leaving two
    versions behind. Locations collapse to workspace-relative paths; anything outside the worktree
    is dropped rather than handed over as a `file://` URI. Rename is planned, previewed, and
    committed by `apply_script_rename`; Monaco's own rename provider is deliberately unregistered
    because its widget would apply model edits behind that transaction. Renderer side:
    `services/monaco-runtime.ts`, `services/monaco-gdscript.ts`, `services/monaco-lsp.ts`,
    `hooks/useScriptBuffers.ts`, `components/workspace/ScriptWorkspace.tsx`. Production CSP widened
    for Monaco's workers.

11. **Native DAP connected.** `src-tauri/src/godot_dap.rs` — Godot's exact sequence, with `launch`
    blocking on its own thread because Godot only answers it once `configurationDone` spawns the
    game. `variables` is retried for 5 s: `scopes` answers from the stack dump while only starting
    the remote fetch, so the next `variables` loses that race. Each message is one write — two make
    Nagle hold the body against the peer's delayed ACK. Source objects carry `name` and `checksums`
    because Godot reads both unconditionally. `step_out` is emulated with bounded `next` requests
    (256-step limit) until stack depth decreases, stopping on breakpoint, exception, pause, or
    termination — Godot 4.7 has no `stepOut` handler. `--headless` rides in `playArgs`; the editor
    does not forward it to the game it spawns.

12. **Runtime feedback loop closed.** `runtime.gd` registers a `gofer` message capture with
    `EngineDebugger` and answers from a coroutine, so input and capture ops can await rendered
    frames while the callback returns immediately; run standalone it stays inert. `plugin.gd`'s
    `GoferDebuggerBridge` owns the editor half: `runtime.*` requests are deferred and correlated by
    RPC id, run/restart ride a state machine (stop → wait → play → `gofer:ready` beacon → chained
    first-frame capture), and `_process` sweeps pending entries against a deadline. Frames are PNG,
    base64, ≤1920 px on the longest edge; remote tree dumps truncate past 2048 nodes or 32 levels.

13. **Configuration editors.** Typed search/get/set/reset for project settings, autoloads, Input
    Map, plugins, and EditorSettings. Setting families with their own typed command (`autoload/`,
    `input/`, `editor_plugins/`) refuse the generic write with `reserved_setting`, so a malformed
    autoload can never reach project.godot. A write keeps the type the engine declared —
    `type_mismatch` rather than `config/name=5` — with int→float, string→StringName/NodePath, and
    array→packed-array promotion so a value read out can be written straight back. Gofer's own
    entries answer `gofer_managed`; built-in `ui_*` actions answer `builtin_input_action` to removal
    and are dropped with `reset_input_action` instead.

14. **AI tool router.** The Node worker channel is duplex NDJSON for the whole turn: Rust writes the
    startup context as the first stdin line and keeps stdin open, the worker answers with
    `GOFER_AI_EVENT:` and `GOFER_AI_TOOL:`, and each request is dispatched on its own thread so a
    debugger wait cannot stall the event stream. `scripts/ai-host.mjs` implements no operation —
    every call is forwarded. `src-tauri/src/ai_tools.rs` is router and catalog: ten domains in one
    `const` that both generates the tool descriptions the model sees and validates what it may call,
    so the two cannot drift. `src-tauri/src/debug.rs` is the session-bound debug adapter;
    `godot_session` drains the editor's pipes into a bounded ring buffer with cursors and
    severities, and the game inherits those pipes, so `godot_logs` covers editor, importer, plugin,
    and game output without parsing engine prose. Diagnostics became pullable, cached per document
    and forgotten whenever the text changes, reporting `published: false` rather than passing an
    unanswered question off as a clean file.

15. **Safety model enforced.** `src-tauri/src/approvals.rs`, and its `GATED` list is the whole
    policy: `godot_resource delete`/`move`, `godot_project set_plugin_enabled`,
    `godot_project set_editor_setting`. Everything else is auto-allowed, because the worktree's Git
    checkout and the editor's undo stack can take it back — the question is not "may this work?" but
    "who can undo it?". A machine-wide editor setting is the one write no `git checkout` in the task
    can reverse. The list is checked against the catalog by a test. A prompt is a paused agent:
    `ask` blocks the tool worker until answered, 300 s pass, or the turn ends; a denial is
    `approval_denied` and explicitly not retryable. `reject_outside_paths` resolves every gated path
    first, so an outside-worktree file is refused rather than offered for approval. Direct UI
    actions never reach the gate by construction — the renderer calls the same handlers without the
    router. Confined bash is the documented autonomous exception in the other direction.

16. **gofer-rag exposed.** `retrieve()` rather than `query()`, so documentation retrieval makes no
    second LLM request. Ranked passages, scores, chapter title and order, bounded text; the `vector`
    field every RankedChunk carries is stripped before anything reaches a model prompt or the
    renderer. Citations name a chapter, and the Docs panel says so rather than implying a link.

17. **Inspector workspace built.** `components/workspace/InspectorWorkspace.tsx` is the frame and
    owns what its regions share — open buffers, selected node, session — so Problems, the debugger,
    the Monaco tabs, and the agent are four views of one set of buffers. Above 1024 px three
    columns; at 1024 px and below the inspector overlays from the toolbar and returns focus on
    close. The bottom panel collapses to its own tab strip at every width. `useGodotSession` gives
    the renderer lifecycle state plus two epochs (edited scene, running game) that panels depend on
    instead of polling; `useGodotQuery` gives every panel the same four states. Edited and runtime
    hierarchies stay separate everywhere. The inspector reads; it does not write.

18. **Migrated and released.** Run is `useGodotSession.ensureReady()` followed by that session's
    `launch`, living in the frame's session toolbar beside the gutter breakpoints. Schema v4 adds
    `godot_runs.session_id` by `ALTER TABLE`, so pre-session runs keep their segments and FTS rows;
    the session's log buffer drains into storage on a timer with a final pass after the stop,
    because the lines that explain a crash arrive last. `search_godot_log_history` queries the FTS5
    index with the needle as a quoted phrase, and the Output panel's Session/History switch works
    with no editor running. `send_godot_command`, `godot_bridge.rs`, `protocol.rs`, the v1 schemas
    and fixtures, and the Node bridge test are removed; `protocol/README.md` keeps one v1 row so an
    old log payload can still be identified.

### Cross-cutting work

- **Monaco surfaces tested.** `ScriptWorkspace.test.tsx` against `src/test/monaco-stub.ts` — jsdom
  can neither measure fonts nor lay out the real editor, so the stub records models, markers,
  decorations, and actions and lets a test fire the listeners the editor would have. Six tests:
  diagnostic→marker+badge, gutter breakpoint add/remove, format preview that dirties only on apply,
  save keybinding, UI-owned rename (`gofer.renameSymbol`, one diff per file including untabbed
  ones), and the two conflicts kept apart because they arrive differently — `externalChange` from
  the watcher, `staleSave` from the write.

- **AI worker tested.** `scripts/ai-worker.test.mjs` against a turn-by-turn scripted model. Duplex
  is proven by two calls in flight answered in reverse order — only the correlation id says which
  result is whose, so a crossed pair fails rather than passing quietly. Cancellation arrives both
  ways it does in production. `approval_denied` reaches the model as an error the turn continues
  past. A captured frame rides the next request as a real image part while the tool text keeps
  dimensions and drops the payload.

- **Packaged journeys on three platforms.** `.github/workflows/packaged-journey.yml` is one
  definition called by `check.yml` (Linux, every push) and `nightly.yml` (three-platform matrix) — a
  second copy is exactly how the Linux journey drifted ahead while the matrix meant to prove the
  others stayed configured and unrun. Both unexercised pins were verified against the published
  archives. Windows could not have passed as it stood: `std::fs::canonicalize` returns `\\?\C:\…`
  and every program a session hands one to rejects it — `SetCurrentDirectory`, Git for Windows, and
  Godot's `--path` alike. `src-tauri/src/paths.rs` is now the one canonicalization rule; `canonical`
  keeps the plain spelling wherever it addresses the same file, and every comparison levels through
  `simplified`. Identities on Linux and macOS.

- **gdformat sidecar frozen.** `scripts/build-gdformat.mjs` resolves the pins in
  `protocol/gdformat-sidecar.json` into a throwaway virtualenv, freezes the console entry point into
  one file, and drops it into `src-tauri/sidecar/` with its SHA-256 and a `LICENSES.md` covering
  only what is actually inside it. The build is also the proof: it asserts the pin contract against
  the frozen executable, not the environment that made it — a binary that lost lark's grammars packs
  cleanly and fails at import. `wdio.packaged.conf.ts` deletes any developer `GOFER_GDFORMAT`, so
  the bundled resource is the only binary that can answer the journey's `format_gdscript` assertion.
  Building it in `check.yml` closed a hole open since step 9: the acceptance journey's formatting
  assertion had accepted `formatter_unavailable`, so every green run was silent about whether the
  formatter worked.

- **Final acceptance journey.** `src-tauri/src/godot_journey_acceptance.rs` —
  `the_final_journey_takes_one_task_from_connect_to_a_second_task`. Real Git checkout, real project
  storage, real task, session started through the supervisor itself, every operation through
  `ai_tools::dispatch` so the safety model is on the path rather than beside it. Two things stay
  scripted, both at the outer edge: the user answering the approval prompt, and the embedding index
  (`fixtures/rag/retrieve-worker.mjs` scripts `retrieve()` and keeps everything downstream real).
  The machine-wide editor setting is written back to itself — the gate is what is proven, and a test
  must not change the developer's own settings. Driving the supervised session found the leak the
  boundary suites hid from each other: `script::bind_test_session` and `debug::bind_test_session`
  were never cleared, so a module that bound its own editor left the next pointed at a deleted
  worktree.

### Defects only real hardware found

- The version gate rejected `4.7.1.stable.official.<hash>` — what every published release reports —
  so no user could have started a session at all.
- Editor settings were looked up as `editor_settings-4.tres` under `Godot/` where Godot 4.7 writes
  `editor_settings-4.7.tres` under a directory whose case differs by platform, and a machine with no
  settings file failed instead of using the engine's own loopback default.
- The LSP remote-host parser matched a bare key where a real file writes
  `network/language_server/remote_host = "…"`, so the loopback check never read the setting.
- The packaged fixture worker still waited for stdin to close, which the duplex channel never does.
- The workspace remounted when the first task list arrived, discarding a message that had not
  reached the debounced save.

## Known gap

macOS universal binary for the `gdformat` sidecar. PyInstaller freezes for the interpreter's own
architecture, so an arm64 runner produces an arm64 executable rather than the universal binary the
Godot pin is. A release that must run on both macOS architectures needs either a universal2 CPython
or two builds joined with `lipo`. Each packaged leg currently proves the architecture its runner was
configured for.

## Standing constraints

- Exactly Godot 4.7.1-stable; other versions fail with a compatibility message.
- GDScript only for intelligence and debugging. C# files stay visible and editable as text.
- One managed editor session; no routing among multiple external editors.
- Scene/node edits are in-memory and undoable until explicit save.
- Game view is snapshot-based, not video streaming.
- No MCP or Python service.
- No export/deployment pipeline, and no dedicated animation, theme, material, particle, audio,
  camera, tilemap, or production-preset authoring suite.
- Formatting is the pinned gdformat sidecar; Godot 4.7 reports `documentFormattingProvider: false`
  and `documentRangeFormattingProvider: false`. gdformat's support for GDScript syntax introduced
  after Godot 4.5 is unverified and gdtoolkit has published nothing since 2025-10-09, so formatting
  is the one feature allowed to ship disabled (`formatter_unavailable`).
- Workspace-wide symbols and DAP step-out are Gofer adaptations; Godot 4.7 provides neither.
- Documentation cites chapters, not URLs — all `retrieve()` returns.
- Machine-wide EditorSettings are outside Git/worktree rollback and stay approval-gated.
- Confined bash is deliberately autonomous inside the active task worktree, even where an equivalent
  typed delete would require approval.
- `npm run check` gates all of it: `coverage-critical` regions at 100% branch coverage, no ignored
  tests, Node suites at 80% line / 75% branch with `workspace-confinement.mjs` at 100%.
