# Project fixes

Re-audited on 2026-08-07 against `a6fb7f7` plus the working tree, item by item, in the current
source and in the committed screenshots. The list it replaces was written against `4d1a607` and had
twenty-eight items; twenty-six of them are fixed and are gone from this file. What is left is item 8
of that list, half done, and two defects the re-audit found in baselines that did not exist when it
was written.

What was checked to close an item is named beside it in
[Closed by this audit](#closed-by-this-audit) — one line each, so nothing has to be taken on trust.

---

## 1 — Fifteen commands still answer in prose

`src-tauri/src/command_error.rs` is the fix for this, and it landed: one `CommandError` with a code,
a sentence, a retryable flag and details, `From<String>` so the internals keep returning sentences,
and `src/utils/command-error.ts` to restore it on the renderer side.

Of the 51 registered commands, 10 answer with `CommandError` and 26 with another typed error the
renderer already branches on — `SessionError`, `RpcError`, `DapError`, `FileError`, `ScriptError`,
`ApprovalError`. Fifteen still reject with a bare `String`, and they are the task and chat surface:
`load_chat`, `save_chat`, `create_chat_task`, `activate_chat_task`, `delete_chat_task`,
`import_legacy_chat`, `list_project_tasks`, `merge_task_worktree`, `save_chat_attachment`,
`read_chat_attachment`, `search_godot_log_history`, `cancel_ai_request`, `query_godot_docs`,
`check_workspace_health`, `apply_health_remedy`. For those the renderer cannot tell "no task yet"
from "the database is corrupt" — it can only print the sentence.

Host paths are still interpolated into some of those sentences: `src-tauri/src/rag.rs:196`, `:202`,
`:383`, and `src-tauri/src/storage.rs:1099`, `:1101`, `:1527`, `:1531`, `:1537`, `:1638`, `:1647`,
`:1650`. Two of them are arguably right — the worker-not-found sentence tells the user where to
look, and the cache-path refusals name a path the user configured. The storage ones name Gofer's own
application directory, which the user did not choose and cannot act on. `ProjectStorage::open` at
`storage.rs:480` already documents that decision and names no path; the rest of the file does not
follow it.

**Done means.** Every command whose failure the UI has to interpret answers with a code. A command
whose failure the UI only prints may keep its `String`, but then say so where it is defined, so the
split is a decision rather than a leftover.

## 2 — The composer's context readout is cut in half by the bottom panel

Measured in the three committed baselines that show the Chat tab with the bottom panel expanded —
`debugger-tab`, `output-tab` and `import-tab`, in both modes. The composer's third footer row (the
context bar and its `0K / 120K · 0 tokens` label) sits under the panel's tab strip and is sliced
through the middle of the glyphs. `streaming-tool-activity-dark-linux.png`, where the bottom panel
is collapsed, shows the same row whole and correct. The Game and Docs tabs replace the chat column,
so the composer is not on screen there at all.

So this is not the footer's own layout — that was fixed, and the row wraps to three lines exactly as
intended. It is the height the chat column is given when the bottom panel expands: the column keeps
laying out a footer taller than the space left for it, and the overflow is drawn under a neighbour
rather than clipped at a border or pushed out.

The readout is how a user sees a conversation approaching the context wall. Compaction summarises
before that wall is reached now, so it is no longer the only warning standing between a conversation
and a dead turn, but it is still the only place the size of one is shown. Half of it is not
readable.

**Done means.** The composer footer is whole in every state, or the bottom panel starts below it.
The three baselines are committed with the defect in them and need re-recording after.

## 3 — The Output tab's two segmented controls print on top of each other

`output-tab-light-linux.png` and `output-tab-dark-linux.png`: the words `Session` and `History`
overlap `Warnings` and `Errors`, in one illegible run of glyphs.
`src/components/workspace/BottomPanel.tsx:470-520` puts two `SegmentedControl`s —
All/Warnings/Errors as `startContent`, Session/History as `endContent` — and a search field in a
single toolbar row, in a panel 360 px wide in the snapshots.

This is what item 27 of the previous list suspected and could not measure, because the Output tab
had no baseline then. The debugger toolbar, the other half of that suspicion, was fixed the right
way and fits: `Launch` plus six icon-only buttons, visible in `debugger-tab-dark-linux.png`.

**Done means.** The row fits at 360 px — icon-only, a wrap, or one of the two controls moved — and
the two baselines are re-recorded.

---

## Closed by this audit

Each was checked in the current source or the current screenshots. The number is the item's number
in the previous list.

- **1, AI stream on the event bus** — `send_ai_message` streams over `tauri::ipc::Channel`.
- **2, leaked listener in `useGodotSession`** — the cancelled-flag/disposer pattern is in place.
- **3, clipped composer footer** — the footer wraps, and `WorkspaceComposer.tsx` records why.
- **4, popover and card below the panel** — `src/theme/theme.ts:42-43` overrides both, and the
  comment above them writes down the ramp it is restoring.
- **5, the design gate could not see an inverted ramp** — `scripts/design-rules.mjs:103` measures
  direction, and `:188` and `:196` measure the card pair. `scripts/design-baseline.json` is now
  empty: the violation it carried is fixed, not tolerated.
- **6, every message re-rendered per token** — `ChatConversation.tsx:127` is `memo(...)` and
  `Workspace.tsx:385` wraps `retry` in `useCallback`.
- **7, 22 props on the composer** — `src/hooks/useComposer.ts` is the provider.
- **9, `build.rs` command list** — `.commands(...)` is gone with a comment saying why, and
  `src-tauri/permissions/autogenerated/` is empty.
- **10, two primary buttons in settings** — `Back up project` is secondary, with the reason above
  it.
- **11, three dialogs with no primary** — all three confirms are `variant='primary'`.
- **12, no light-mode coverage** — `playwright.config.ts:28-30` runs a light project beside the dark
  one, and every baseline exists in both.
- **13, six views with no baseline** — debugger, output, import, game, docs, and the three script
  dialogs all have one. Which is how items 2 and 3 above were found.
- **14, the inspector's bare offline line** — `InspectorPanel.tsx:160` is an `EmptyState` with a
  title and an action.
- **15, two indicators for one download** — the splash has no `Spinner`.
- **16, splash alignment** — the splash and `HealthGate` both align their text blocks to the start.
- **17, Badge as decoration** — `DocsView.tsx:105` is a `Token`, with the reason beside it.
- **18, raw elements in the tree** — the row is `HStack` + `Text maxLines={1}`; the two raw elements
  left are the icon slot and the hover-reveal wrapper, both documented where they stand.
- **19, style objects rebuilt per render** — hoisted (`GameView.tsx:17` and the rest).
- **20, hand-written dialog type** — `@tauri-apps/plugin-dialog` is a dependency and `desktop.ts:10`
  imports `OpenDialogOptions` from it.
- **21, placeholders repeating labels** — gone, with the decision recorded at `ExplorerPanel.tsx:90`
  and `InspectorPanel.tsx:47`.
- **22, barrel icon import** — no barrel imports left in `BottomPanel.tsx`.
- **23, `useContext`** — `useChatReferences.ts:1` imports `use`.
- **24, the user bubble's alignment override** — the override is a hoisted constant with the reason
  written beside it.
- **25, no preload for the lazy routes** — `src/app/routes-preload.ts`, fired from
  `Navigation.tsx:60` and `:136` on hover and focus.
- **26, stale baseline count in the skill** — the sentence no longer counts them.
- **27, toolbars that may not fit** — measured. The debugger toolbar fits; the Output toolbar does
  not, and is item 3 above.
- **28, `plugin:dialog|open` out of order** — alphabetical at `desktop.ts:148`.

## Not re-checked

The previous list's Coverage section — path confinement, process arguments, lock discipline,
capabilities, and the per-component and per-hook read-through — was not repeated here. It was true
of `4d1a607` and nothing in this audit contradicts it, but it is a year of reading compressed into
one section and it has not been re-measured. Treat it as history, not as a current guarantee.
