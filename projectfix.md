# Project fixes

Validated read-only against the three project skills — `.claude/skills/gofer-ui`,
`.claude/skills/react-best-practices`, `.claude/skills/tauri-v2` — on commit `4d1a607`, clean
working tree. Every item was checked in the source, the built theme, the tauri/tauri-build crate
sources, or a committed screenshot. Two items are marked as unverified suspicions; everything else
was measured. What is covered and what is still unread is listed at the end.

`npm run check:design` (1 known violation, none new), `npm run lint` and `npm run typecheck` pass.
Not run: the rest of `npm run check` — full test suite, Godot acceptance, Rust.

## 1 — The AI token stream rides Tauri events instead of a channel

`src-tauri/src/lib.rs:2028` emits one `ai-stream-event` per line the AI worker writes — every text
delta, thinking delta and tool update — and `src/components/workspace/Workspace.tsx:148` listens for
them. The tauri-v2 skill: events are for fire-and-forget notification and "are not designed for
high-throughput streaming"; channels are for "ordered, high-throughput Rust-to-frontend streaming
tied to a command invocation", which is exactly what this is — it is tied to `send_ai_message`.

The repo already does this correctly five times: `tauri::ipc::Channel` at `lib.rs:820`,
`lib.rs:948`, `lib.rs:1040`, `godot_session_api.rs:448` and `script.rs:494`. The AI stream is the
one high-rate path left on the event bus, and the one where out-of-order delivery corrupts the text.

Fix: give `send_ai_message` a `tauri::ipc::Channel<AiStreamPayload>` parameter and drop the
`emit_to("main", "ai-stream-event", …)` calls. `useGodotSession.ts:171` documents the reasoning for
what legitimately stays an event.

## 2 — A leaked event listener in `useGodotSession`

`src/hooks/useGodotSession.ts:174-186` starts `listen(...)` and assigns the disposer inside `.then`,
while the effect's cleanup calls `unlisten?.()`. If the effect tears down before the promise
resolves — which `React.StrictMode` in `src/main.tsx:24` guarantees on every mount in development,
and any remount can do in production — the disposer arrives after cleanup and the listener is never
removed. It stays alive for the life of the process, holding the old closure.

`src/hooks/useToolApprovals.ts:20-52` already has the correct shape: an `isCancelled` flag, a
disposer list, and a cleanup that disposes anything arriving late. The other three `listen` sites
(`InitializationSplash.tsx:34`, `SettingsPage.tsx:198`, `Workspace.tsx:148`) `await` inside
try/finally and are fine.

Fix: use the `useToolApprovals` pattern.

## 3 — The composer footer is clipped at the panel edge while streaming

In `e2e/visual/application.visual.spec.ts-snapshots/streaming-tool-activity-linux.png` the
"Reasoning: medium" control's chevron is cut in half by the centre column's right edge — cropped and
confirmed at 3×. It fits in `inspector-workspace-linux.png`, where the composer sits in the centred
welcome block instead of the chat column, so this is the streaming layout only.

Fix: let the footer row wrap or shrink at that width. The baseline is committed with the defect in
it, so it needs re-recording after.

## 4 — Popover and card sit below the panel they float over (dark), and on top of it (light)

`src/theme/theme.ts` inherits `--color-background-card` and `--color-background-popover` from
`@astryxdesign/theme-neutral`. In dark both are `#1b1b1b` — the exact value of
`--color-background-body`, and 5.4 L\* **below** `--color-background-surface` (`#262626`). In light
all three of surface, card and popover are `#ffffff`, so nothing separates them but a border. Astryx
documents the ramp as body → surface → card → popover, each level above the previous
(`npm run astryx -- docs color`); its own default puts dark popover at `#28292C`, above surface.

It reaches the screen: `@astryxdesign/core/dist/Popover/usePopover.js` paints
`--color-background-popover` and `DropdownMenu.js:26` imports it, so the model and reasoning menus
in `src/components/workspace/WorkspaceComposer.tsx` open darker than the panel they cover, in the
frame colour.

Fix: override both in `src/theme/theme.ts`, then
`npm run astryx -- theme build src/theme/theme.ts --out src/theme/gofer-theme.css` and re-run
`npm run check:design`.

## 5 — The design gate cannot see an inverted ramp, and never looks at `card`

Two gaps in `scripts/design-rules.mjs`:

`separation` at line 81 measures `Math.abs(lightness(one) - lightness(other))`, so the
`surface-ramp` rules at 135–152 pass whether the popover is above the panel or below it. That is why
the dark half of item 4 is invisible to the gate.

`findViolations` at 113–171 has no rule for `--color-background-card` in either mode, so a card that
is exactly its background — which is what light mode ships — is never measured at all.

Fix: give `separation` a direction (or add a `ramp-order` rule), add the card pair, and cover both
in `scripts/design-rules.test.mjs`. Expect the light-mode card rule to land in the baseline on the
first run; that is the honest starting state, not a reason to skip the rule.

## 6 — Every message in the conversation re-renders on every streamed token

`updateAssistant` (`src/components/workspace/Workspace.tsx:103`) replaces the `messages` array on
each delta, `ChatConversation` maps it, and `ConversationMessage`
(`src/components/workspace/ChatConversation.tsx:114`) is not memoized — so a hundred-message
conversation re-renders a hundred messages, including their lazy-loaded `CodeBlock` tool output, per
token. React best practices §6.6.

Unchanged `message` objects keep their identity through `updateAssistant`, so `React.memo` would
bite — except `retry` (`Workspace.tsx:360`) is a plain function redefined every render and passed to
every message.

Fix: `React.memo` on `ConversationMessage` and `useCallback` on `retry`. Both, or neither works.

On the same path, `useAttachmentPreviews.ts:22-49` takes `messages` as a dependency and re-runs its
`flatMap` over the whole conversation per token. It early-returns once nothing is new, so the cost
is small, but it is the same "every token walks every message" shape and worth fixing in the same
pass.

## 7 — `WorkspaceComposer` takes 22 props

`src/components/workspace/WorkspaceComposer.tsx:30-56` declares 22 props — four of them booleans
(`canAttachImages`, `isSavingAttachments`, `isStreaming`, `supportsImages`) — and
`src/components/workspace/Workspace.tsx:389-414` relays all of them from values derived twenty lines
earlier. React best practices §1.1 (boolean proliferation), §2.1 (state belongs in the provider) and
§2.3 (lift state into a provider).

`Workspace.tsx:473` already shows the pattern one component down: `ChatReferenceContext.Provider`
carries the mention sink to panels three columns away rather than as a prop.

Fix: a composer provider exposing `{state, actions, meta}`, with the composer's pieces reading it.

## 8 — Two different error contracts across the command surface

Roughly half the commands return `Result<_, String>` (`load_settings`, `save_settings`,
`test_ai_connection`, `list_ai_models`, `send_ai_message`, all the RAG and health commands) and half
return structured errors carrying a code (`SessionError`, `RpcError`, `DapError`, `ApprovalError`).
The UI branches on the codes — `src/components/workspace/ExplorerPanel.tsx:289` turns
`runtime_not_running` into "The game is not running" rather than a failure — and can do nothing but
print the `String` half.

Those strings also embed absolute host paths: `src-tauri/src/rag.rs:246`, `:260`, `:286`, `:293`,
`src-tauri/src/storage.rs:480`, `:482`, `:1076` interpolate `path.display()`. The tauri-v2 skill
asks for structured error codes for UI decisions and no internal paths in error strings. On a
single-user local app with no remote-origin capability the disclosure risk is low; the substantive
half is that the UI cannot tell an ordinary state from a fault for those commands.

Fix: one error type with a code, at least where the UI has to interpret the failure.

## 9 — `build.rs` command list is out of sync, and its output is dead

`src-tauri/build.rs` names 28 commands in `AppManifest::new().commands(&[...])`;
`src-tauri/src/lib.rs:2330` registers 51.

Not a permission hole — verified in `tauri-build-2.6.3/src/acl.rs:274-289` that `.commands()` only
autogenerates `allow-$command`/`deny-$command` files, and in `tauri-2.11.5/src/webview/mod.rs:1820`
that enforcement keys off `has_app_manifest()` plus the resolved capability.
`src-tauri/permissions/main-window-commands.toml` lists all 51, so every command is gated.

The debris is real: no capability references any `allow-*` identifier, so all 37 files in
`src-tauri/permissions/autogenerated/` are dead, and 9 are stale — `call_godot`, `format_gdscript`,
`get_godot_session`, `query_godot_docs`, `respond_tool_approval`, `start_godot_session`,
`stop_godot_session`, `subscribe_godot_events`, `unsubscribe_godot_events` left the `build.rs` list,
so nothing regenerates or deletes them. They still carry snake_case identifiers, unlike the
kebab-case the current version writes.

Fix: one source of truth. Either drop `.commands(...)` and delete
`src-tauri/permissions/autogenerated/`, or grow the list to all 51 and point the capability at the
generated identifiers.

## 10 — Two primary buttons in the settings dialog

`src/components/settings/SettingsPage.tsx:667` (`Back up project`, in the scrolling body) and `:703`
(`Save connection`, in the pinned footer) are both `variant='primary'` inside the one `Dialog`
opened at line 297. The footer is pinned, so scrolling to Project storage puts both blues on screen
at once. Astryx Button docs: "Don't: Place more than one primary button in the same view; this
dilutes the visual hierarchy."

Fix: `Back up project` becomes secondary. The dialog's one primary is the save.

## 11 — Three dialogs with no primary action

`src/components/workspace/ScriptWorkspace.tsx:312` (Apply to buffer), `:359` (Preview rename) and
`:411` (Apply rename) each pair a ghost `Cancel` with a confirm button left at the default
`secondary`, so nothing says what the dialog is for.

Fix: `variant='primary'` on the three confirm buttons. With item 10 that makes the rule uniform:
exactly one primary per view, everywhere.

## 12 — Light mode has no visual coverage at all

`playwright.config.ts:16` pins `colorScheme: 'dark'`, and `src/main.tsx:26` renders
`<Theme mode='system'>`. Every user on a light desktop gets a mode that no baseline has ever looked
at — and it is the mode carrying the one violation already in `scripts/design-baseline.json`, plus
the unmeasured card collapse from item 5.

Fix: a light-mode Playwright project over the same seven states, or at minimum over the settings
dialog and the inspector workspace.

## 13 — Six more views have no visual baseline

`e2e/visual/application.visual.spec.ts` takes seven screenshots. Nothing covers the Debugger, Output
or Import tabs of the bottom panel, the Game or Docs tabs, the three `ScriptWorkspace` dialogs, or
the tool approval dialog. The gofer-ui skill's method for judging a screen is measuring a screenshot
of it, so views with no baseline regress unseen — item 3 is what the net catches when it exists.

Fix: a baseline per uncovered view, starting with the debugger toolbar (item 27).

## 14 — The inspector's offline state bypasses the shared panel states

`src/components/workspace/InspectorPanel.tsx:118-127` renders offline as a bare `Text` line, in a
file that imports `PanelState` and uses it three times. The explorer's equivalent
(`ExplorerPanel.tsx:323-339`) is an `EmptyState` with a title and a "Start editor session" action.
Both panels are on screen together — visible side by side in `script-editor-linux.png`, where the
inspector shows one dim sentence and no way to act on it.

Fix: an `EmptyState` with the same title/description/action shape as the explorer's.

## 15 — Two progress indicators for one download

`src/components/application/InitializationSplash.tsx:105-120` renders a `Spinner` labelled
"Initializing documentation search" and, immediately below it, a `ProgressBar` labelled "Preparing
model download…". Visible in `first-run-preparation-linux.png`. The comment at 109-114 records
removing a duplicated caption for exactly this reason; the spinner is the same duplication one
element up.

Fix: the bar alone — it carries its own label and its indeterminate state covers the phase the
spinner was for.

## 16 — The splash centres its heading and stretches everything else

`InitializationSplash.tsx:66-96`: the outer `VStack` is `hAlign='stretch'` while the heading block
is `hAlign='center'`, so in both `first-run-preparation-linux.png` and `error-state-linux.png` a
centred title and subtitle sit over a left-aligned banner, paragraph and progress label in a 592 px
column. `HealthGate.tsx:152-181` has the same split.

Fix: pick one axis per block, and make the two screens agree.

## 17 — Badge used as decoration

`src/components/workspace/DocsView.tsx:100-103` labels a passage `Section 3` with a `Badge`.
AGENTS.md and `npm run astryx -- docs principles` both reserve Badge for counts and enumerated
states — "Badge as decoration" is on the anti-pattern list. The other four Badges are correct: two
counts (`ScriptWorkspace.tsx:160`, `BottomPanel.tsx:248`), two enumerated states
(`InspectorPanel.tsx:181`, `:291`).

Fix: `Token`, which `InspectorPanel.tsx:225` already uses for the same kind of chip.

## 18 — Raw elements with inline styles in the explorer tree

`src/components/workspace/ExplorerPanel.tsx:122`, `:130`, `:167`, `:172`, `:182` build the tree row
label from `<span>` and `<img>` carrying `style` objects. The values are tokens (`var(--spacing-2)`,
`var(--spacing-4)`), so no hardcoded measurement is involved, but Astryx lists "Inline styles on raw
elements" as an anti-pattern and AGENTS.md forbids raw `<div>`/`<span>` layout.

Fix: `HStack` + `Text maxLines={1}` — the truncation pattern `ScriptWorkspace.tsx:180` already uses
— checking it still lays out inside `TreeList`'s `label` slot. `WorkspaceComposer.tsx:83`'s hidden
`<input type='file'>` has no Astryx equivalent; leave it and say so in a comment.

## 19 — Style and prop objects rebuilt on every render

`src/components/workspace/GameView.tsx:150` (`{maxWidth: '100%', height: 'auto'}`, fully static),
`src/components/workspace/MonacoDiff.tsx:63` (`{height, width: '100%'}`), and
`src/components/settings/SettingsPage.tsx:329`, `:524`, `:632` (`columns={{minWidth: 320}}`, the
same literal three times). React best practices §6.5, and against the repo's own convention —
`ROW_LABEL_STYLE`, `NODE_ICON_STYLE`, `SAFE_CENTRE`, `LEFT_ALIGNED_USER_BUBBLE_STYLE` and
`CHAT_SCROLL_VIEWPORT_STYLE` are all hoisted module constants.

Fix: hoist the four static ones; leave `MonacoDiff`'s, which closes over a prop.

## 20 — A hand-written type for a library that ships its own

`src/services/desktop.ts:116` declares `OpenDialogOptions` by hand for `plugin:dialog|open`.
AGENTS.md: "Do not hand-write types for libraries… Author a type only when the library exports
none." `@tauri-apps/plugin-dialog` exports exactly this type, but the package is not installed —
`npm run tauri -- info` reports `@tauri-apps/plugin-dialog ⱼₛ: not installed!` against
`tauri-plugin-dialog 🦀: 2.7.2` on the Rust side. So the payload shape is guessed against the Rust
deserializer and a plugin bump can break it silently.

The direct `invoke` itself is fine and documented at `desktop.ts:112-114` — the test driver has to
intercept it like every other desktop call. Only the type is the problem.

Fix: add `@tauri-apps/plugin-dialog` as a devDependency and import its `OpenDialogOptions`; keep the
direct invoke.

## 21 — Placeholder repeats a hidden label in six inputs

`ExplorerPanel.tsx:378` and `:418`, `InspectorPanel.tsx:252` and `:328`, and
`BottomPanel.tsx:490-497` (both branches of its scope switch) set `label`, `isLabelHidden`, and a
placeholder repeating the label word for word. The gofer-ui skill: a placeholder is for format
examples, never to name the field.

`SettingsPage.tsx:468-476` shows the correct use — the API key field's placeholder is "Stored
securely" or "Not required by local servers", which says something the label does not.

The colour half is already fixed — `--color-text-secondary` `#c2c2c2` and `--color-text-disabled`
`#8f8f8f` are 19.0 L\* apart, so a placeholder no longer reads as a typed value. What is left is a
decision, not a defect: show the label, or record why a filter box in a 260 px column cannot spare
the label row.

## 22 — Barrel import of two icons

`src/components/workspace/BottomPanel.tsx:7` imports `{ChevronDownIcon, ChevronUpIcon}` from
`@heroicons/react/24/outline`; the other 17 heroicon imports all use the direct file path. React
best practices §4.1.

## 23 — `useContext` where the repo uses React 19's `use`

`src/hooks/useChatReferences.ts:1` and `:19` read the context with `useContext`;
`src/app/router.tsx:55` uses `use`. React best practices: on React 19+, `use` replaces `useContext`.

## 24 — The user bubble overrides its component's alignment

`src/components/workspace/ChatConversation.tsx:27` and `:131` push the user's message to
`flex-start` with an inline `alignSelf`, overriding what `ChatMessage sender` lays out. AGENTS.md
asks for component props first. It works today; it is a silent fight with the next Astryx release.

Fix: check whether `ChatMessage`/`ChatMessageBubble` expose an alignment prop
(`npm run astryx -- component ChatMessage`); keep the override with a comment if they do not.

## 25 — Nothing preloads the two lazy routes

`src/app/router.tsx:31-33` lazy-loads `SettingsPage` and `Workspace`, and nothing triggers either
import before the click. React best practices §4.4: preload on hover or focus of the control that
leads there — here the `Settings` item in `Navigation.tsx` and the task rows.

Fix: an `onMouseEnter` that fires the same `import()`.

## 26 — The skill's own baseline count is stale

`.claude/skills/gofer-ui/SKILL.md` says `scripts/design-baseline.json` "lists the seven violations
the theme carries today". It lists one:
`surface-ramp:light:--color-background-surface:--color-background-popover`.

## 27 — Not verified: two toolbars may not fit their panels

`src/components/workspace/BottomPanel.tsx:151-215` puts seven text buttons in one `Toolbar` row —
Launch, Continue, Pause, Step over, Step in, Step out, Terminate — and `GameView.tsx:82-128` puts
five — Run, Restart, Stop, Capture game, Capture editor. Both live in a panel that is 360 px wide in
the committed snapshots, and neither tab has a baseline. The repo has already fixed this class twice
(`theme.ts:63` tab padding, `ScriptWorkspace.tsx:173` path truncation).

**This is a suspicion, not a measurement.** Open both tabs and measure before changing anything; if
they clip, icon-only buttons with tooltips are the usual answer. Needs the baselines from item 13
either way.

## 28 — Not verified: `plugin:dialog|open` out of alphabetical order

`src/services/desktop.ts:134` sits between `create_chat_task` and `create_project_backup` in an
otherwise alphabetical map. Cosmetic; noted only so it is not mistaken for deliberate grouping.

---

## Coverage

Checked and clean, so no item was written for them:

- **Path confinement.** `files.rs` `Workspace::resolve` canonicalizes, compares against the
  canonical root with `starts_with`, rejects `ParentDir`/`RootDir`/`Prefix` components, and caps
  relative paths at 1024 bytes, files at 8 MiB and directory walks at depth 32 — each with a test.
- **Process arguments.** No `args: true` anywhere and no shell plugin. Godot gets a fixed argument
  vector whose only variable is the canonical worktree and allocated loopback ports
  (`godot_session.rs:369-388`); gdformat gets `--version` or `-`, with the buffer over **stdin** and
  capped by `MAX_SOURCE_BYTES` (`gdformat.rs:146`, `:214`). Every `git` argument in the codebase is
  a static literal, and `git_command` (`git.rs:302-315`) strips `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR` and
  `GIT_PREFIX` from the environment.
- **Locks.** No `async fn` in `src-tauri/src` contains both `.lock()` and `.await`.
- **Capabilities.** One window, `dialog:allow-open` only for the picker, production CSP explicit and
  narrow, `withGlobalTauri` confined to `tauri.wdio.conf.json`.
- **React.** §5.2 (no touch/wheel listeners exist), §5.3 (`gofer.agent-chat.v1`, try/catch), §6.3
  (no trivial `useMemo`), §6.4 (no component defined inside another), §6.12, §7.7 (every `&&` in JSX
  has a boolean left operand), §8.13 (no `.sort()` on props or state), §4.1 for Astryx (all subpath
  imports), §4.2/4.3 (Monaco, `Workspace`, `SettingsPage`, `CodeBlock` all behind dynamic imports).
- **Style.** No hardcoded hex or px in any component; the four hand-written CSS files under
  `src/theme` contain neither; `monaco-theme.ts` derives every editor colour from the built theme
  rather than restating it. `@stylexjs/stylex` is a declared peer dependency of
  `@astryxdesign/core`, so it belongs in `dependencies`.

- **Every component.** All twenty were read end to end. `ScriptEditor.tsx` is the strongest of them:
  it uses the §9.2 handler-ref pattern deliberately (lines 80-85), disposes every model, listener
  and action, and hoists its options object. `MonacoDiff`, `ToolApprovalDialog`, `WorkspaceHeader`,
  `Navigation` and `InspectorWorkspace` are clean — `Navigation.tsx:39-42` even documents why the
  delete button is a sibling of the nav item rather than its `endContent` (a button nested in an
  anchor would navigate as well as delete).
- **Every hook.** All thirteen were read. `useGodotQuery`, `useLogHistory`, `useAttachmentPreviews`,
  `useChatPersistence`, `useDebugSession` and `useScriptBuffers` all guard their async effects with
  a cancelled flag or a mounted ref and clear every timer they set, which is what makes
  `useGodotSession.ts:174` (item 2) the single outlier rather than a house style.
- **Polling.** `useSessionLogs.ts:70` polls `read_godot_logs` every second, which looks like an
  AGENTS.md "never sleep" violation and is not: `SessionEvent` (`godot_session_api.rs:84-93`)
  carries only `StateChanged` and `RpcEvent`, and log lines are flushed Rust-side into storage by
  `RunLogger` (`godot_session_api.rs:209-257`) with nothing signalling the renderer. Nothing
  signals, so the rule permits the poll, and it is cursor-based so no line can be skipped.
- **Command bodies.** `script.rs` reaches the filesystem only through `Workspace` (`script.rs:284`
  `workspace.read(...)`, `:567` `Workspace::open`) and filters LSP-returned locations back to the
  worktree (`:649`); its worktree comes from the supervised session, not from the renderer. No
  command body joins a renderer-supplied path onto a root by hand.

Remaining unread, and outside the three skills' scope: the internals of `storage.rs` (3241 lines),
`godot_rpc.rs`, `memory.rs` and `ai_tools.rs`, plus `src/utils` and `src/models` — Rust persistence
and plain TypeScript helpers with no Tauri surface, no React and no UI. Their command-facing edges
are covered above.
