# How a project remembers the way it was left

This describes what Gofer stores today. It was written as a plan, and it is now a description of
working code. Nothing below is a proposal.

Reopening a project puts the workspace back the way it was closed: the same centre tab, the same
open scripts at the same lines, the same panel widths, the same chosen node. These are choices about
the work, not about the machine, so they live with the project rather than with the computer.

## Where it lives

The `project_state` table in each project's own SQLite database. Because the database sits inside
the project, moving the project folder moves its remembered layout with it, and two projects never
share one.

Keys are namespaced, and the backend enforces the namespace:

| Key                  | What it holds                                  |
| -------------------- | ---------------------------------------------- |
| `ui.workspace`       | The whole layout, as one JSON object.          |
| `ui.scriptViews`     | Monaco's cursor and scroll, by workspace path. |
| `ui.draft.<task-id>` | One task's unsent composer message.            |

`write_ui_state` rejects any key outside the `ui.` prefix, so the renderer can never overwrite
`active_task_id` — which lives in the same table and decides which worktree the agent runs in. A
stored value is capped at 1 MiB, which is a ceiling on mistakes rather than a budget.

```
src-tauri/src/storage.rs
```

## What is stored

Thirteen fields in `WorkspaceLayout`, plus the two separate keys:

| What                             | Stored as                          | Scope   |
| -------------------------------- | ---------------------------------- | ------- |
| Centre tab (Chat/Scripts/…)      | `ui.workspace` `centerTab`         | project |
| Explorer tab (Scene/Runtime/…)   | `ui.workspace` `explorerTab`       | project |
| Inspector tab (Node/Project/…)   | `ui.workspace` `inspectorTab`      | project |
| Bottom tab (Problems/Debugger/…) | `ui.workspace` `bottomTab`         | project |
| Bottom panel collapsed           | `ui.workspace` `isBottomCollapsed` | project |
| Explorer width                   | `ui.workspace` `explorerWidth`     | project |
| Inspector width                  | `ui.workspace` `inspectorWidth`    | project |
| Open script tabs, in order       | `ui.workspace` `openScripts`       | project |
| Active script tab                | `ui.workspace` `activeScript`      | project |
| Breakpoints, by path             | `ui.workspace` `breakpoints`       | project |
| Output log severity filter       | `ui.workspace` `logSeverity`       | project |
| Output log scope filter          | `ui.workspace` `logScope`          | project |
| Selected node, with its scene    | `ui.workspace` `selection`         | project |
| Cursor and scroll per script     | `ui.scriptViews`, by path          | project |
| Composer draft text              | `ui.draft.<task-id>`               | task    |

The two panel widths used to be one `localStorage` value shared by every project on the machine.
They are per project now. The responsive contract's minimum and maximum widths live beside the type,
because a stored width has to be clamped to them: a project remembered under one contract must not
reopen a panel at a width the current one forbids.

```
src/models/ui-state.ts
```

## What is deliberately not stored

| What                                 | Why                                           |
| ------------------------------------ | --------------------------------------------- |
| File filter text                     | A search box. Stale text hides files on open. |
| Node filter text                     | Same.                                         |
| Log `contains` filter                | Same.                                         |
| Inspector property search            | Same.                                         |
| Docs question and results            | A one-off query.                              |
| Draft image attachments              | The bytes are not saved until you send.       |
| Narrow-viewport inspector overlay    | Follows the window size.                      |
| Every `isLoading` / `isBusy` / error | Facts about a run, not a choice.              |
| Game capture frame                   | Belongs to a game that is no longer running.  |
| Unsaved script edits                 | Tabs come back; the buffer is re-read.        |

## How it is written

Writes are debounced, so a drag or a burst of typing costs one write rather than one per event. The
debounce is a parameter rather than a fact about the module: tests pass a scheduler that runs the
write on the spot, which keeps 250 ms of real waiting out of every test that asserts a layout was
recorded. The application passes the real clock, and flushes whatever is still pending when the
window closes.

```
src/services/ui-state.ts
```

## Questions this raised, and how they were answered

1. **Selected node — keep it or drop it?** Kept, but stored with the scene it was chosen in. A path
   on its own is meaningless once the edited scene changes, so the two travel together.
2. **Breakpoints — project data or UI state?** UI state, in the layout. They are a place the user
   marked while reading, not a fact about the game.
3. **Open script tabs — the list, or the unsaved edits too?** The list. The tabs reopen and their
   contents are re-read from disk. Remembering an unsaved buffer would mean the file on disk and the
   file on screen silently disagreeing across a restart.
