# Client UI state to store per project

Every item below is React state today. It resets on every app start.

Storage home: the `project_state` table already exists in each project's SQLite database. It is a
key/value table and only holds `active_task_id` right now.

Scope column meaning:

- **project** — one value per project.
- **task** — one value per task inside the project.

## Store these

| What                                         | Where it lives now                       | Scope   |
| -------------------------------------------- | ---------------------------------------- | ------- |
| Centre tab (Chat/Scripts/Game/Docs)          | `InspectorWorkspace` `centerTab`         | project |
| Explorer tab (Scene/Runtime/Files)           | `InspectorWorkspace` `explorerTab`       | project |
| Inspector tab (Node/Project/Editor)          | `InspectorWorkspace` `inspectorTab`      | project |
| Bottom tab (Problems/Debugger/Output/Import) | `InspectorWorkspace` `bottomTab`         | project |
| Bottom panel collapsed                       | `InspectorWorkspace` `isBottomCollapsed` | project |
| Explorer width                               | Astryx `useResizable('gofer-explorer')`  | project |
| Inspector width                              | Astryx `useResizable('gofer-inspector')` | project |
| Open script tabs                             | `useScriptBuffers` `buffers`             | project |
| Active script tab                            | `useScriptBuffers` `activePath`          | project |
| Cursor and scroll per script                 | Monaco, not kept at all                  | project |
| Breakpoints                                  | `useScriptBuffers` buffer `breakpoints`  | project |
| Output log severity filter                   | `BottomPanel` `minSeverity`              | project |
| Output log scope filter                      | `BottomPanel` `scope`                    | project |
| Selected node                                | `InspectorWorkspace` `chosen`            | project |
| Composer draft text                          | `Workspace` `draft`                      | task    |

The two panel widths are stored today, but in `localStorage`. That is one value for every project on
the machine. Moving them makes them per project.

## Skip these

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

## Open questions for you

1. Selected node: keep it, or drop it? It already retires itself when the scene changes. Restoring
   it means re-reading the node on startup.
2. Breakpoints: these feel like project data, not UI state. Own table?
3. Open script tabs: restore the buffer list only, or the unsaved edits too?
