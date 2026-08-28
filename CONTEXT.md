# CONTEXT

The words Gofer's code uses, and what each one means here. A term is in this list because it means
something narrower than it sounds, or because two things that look alike are deliberately kept
apart.

Architecture decisions live in [`docs/adr/`](docs/adr/).

## The work

**Workspace** — the folder the user opened, and the Godot project inside it. It is the process's
working directory. One workspace at a time.

**Binding** — which folder that is, and where its data lives: the environment file the health check
writes, the two environment variables that override it, and the project database that is reopened
when either changes. It is `src-tauri/src/workspace.rs`, and it is the decision every command comes
after. Distinct from `files::Workspace`, which decides what may be touched _inside_ the folder this
one chooses.

**Project data** — everything Gofer knows about a workspace, kept in `.gofer/` inside the workspace
itself, so moving the folder moves what Gofer remembers about it.

**Ledger** — one narrow view over the project database: `chats`, `tasks`, `runs`, `sketches`,
`memory`, `project`. One connection, one schema, one write lock; six interfaces, so a caller that
wants the conversation learns what a conversation can do rather than everything a project can. Each
view owns its own upkeep as well as its own tables — maintenance is a fold over the six, not one
view reaching into the others' rows, which is how the two newest arrived with nothing collecting
them at all. Each view names its own failures: a rejection carries the code chosen where the failure
happened, not at the seam it crosses — a task that is not there is `task_not_found` whichever view
was asked, and a view names the situation only for a sentence nobody has classified. A task's brief
travels with `tasks`, because it belongs to one task and is deleted with it.

**Task** — one unit of work in the sidebar: a conversation, and a git branch to do it in. Tasks are
created, activated, deleted, and merged back. A task made before the repository existed gets its
branch when one appears.

**Switch** — what activating a task costs, because every task shares the project's one checkout.
Stop the editor session, commit whatever is loose onto the branch being left, check out the branch
being opened, and only then move the current-task pointer. Godot never rereads a scene a checkout
changed underneath it, so an editor left running would save the outgoing task's copy over the
incoming task's file. Creating, opening, deleting, merging and resolving all move the same checkout
and all go through `task_switch.rs`, which owns that order and the one failure policy.

## The conversation

**Turn** — one prompt and the answer to it: append the pair, open the stream, fold each event,
settle whatever the ending left running. It is a sequence, not a message, and the sequence is
`src/services/turn.ts`. Retrying rewrites the last reply in place; it never shortens the
conversation, because the chat is saved by replacing every row of the task.

**Conversation** — the messages on screen, oldest first.

**Transcript** (`agentMessages`) — what the model is given as its memory. Not the conversation: it
holds tool calls and their results, it is opaque to the renderer, and it is stored on every step of
a turn rather than only at a clean end, so a turn that crashed still leaves the model holding what
it did.

**Timeline** — the arithmetic that folds one stream event into one message. It belongs to the Turn
and only to the Turn; an eslint rule says so.

## The editor

**Editor session** — a real Godot editor Gofer started, with the addon staged into it. Gofer asks
Godot whether one is running rather than remembering that it started one.

**Session end** — the two ways a session stops, and the order the steps take. Gofer stopping it and
the editor exiting on its own differ in what is left to take back: an editor that is already gone
cannot be killed, and its addon must not be pulled out from under a directory Gofer no longer knows
the state of. What they share is an order — clients before the process, the run closed after it, the
addon out last — and that order is `end_session`, not a habit two functions have.

**Addon** — the GDScript plugin Gofer stages into the project, which answers protocol commands from
inside the editor. Four scripts: `plugin.gd` in the editor, `runtime.gd` in the running game, and
`protocol.gd` and `params.gd` beside both.

`plugin.gd` extends `EditorPlugin`, and that one line is the addon's testability seam: nothing in
that class can be reached without booting a real editor under xvfb, whether it touches the editor or
not. `protocol.gd` and `params.gd` are on the other side of it — preloadable, so
`fixtures/godot-project/tests` drives them from source in about a second each.

What lives there is what an editor cannot answer better: `protocol.gd`'s codec, where `encode` and
`decode` are one round trip and live together; and in `params.gd`, everything the commands decide
_before_ they touch the editor. The declared-parameter check and the table behind it, the guard
against a path that climbs out of the project, the tile and atlas arithmetic, the input-event codec,
the texture and rescan limits, the reserved setting names, the settings-search matcher, and the
readback comparison that knows a 32-bit float drifts and a cleared object property is not
`TYPE_NIL`. Each of those was measured on a real editor once and is re-proved from source since.

Two of them are read by both halves at once — `authored_groups` and `icon_class` take a `Node` and
never ask whether it is being edited or played. Each existed twice, byte for byte, once on each side
of the seam. Which side a function belongs on is decided by what it touches, not by which handler
happened to need it first, and a function that touches neither the editor nor the game belongs here.

One kind of function cannot leave, whatever it touches.
`EditorUndoRedoManager.add_do_method(self, "_do_attach", …)` names a method by string, on the plugin
object, and six of those were moved out with the node arithmetic they read like. Everything
compiled, nothing failed a search for callers, and every undo-backed write silently stopped writing.
A string is not a call, so what a function touches is not the whole rule: what names it counts too.

`parse_test.gd` is what keeps that decision cheap to act on. `plugin.gd` and `runtime.gd` cannot be
_run_ without an editor and a game, but both can be compiled, and a moved function that no longer
parses is the only thing a move breaks that no other suite would notice. It is not a substitute for
the acceptance suite; it is what stops a rename reaching it. It holds the string-named callbacks to
the same standard, because that is the one break it could not otherwise see.

**Command map** — a command name is a key, not a string, and its reply is a type. There are two:
`DesktopCommandMap` for the backend's commands and `GodotCommandMap` for the addon's. The Godot one
is a mapped type over a union emitted from the catalogue, so its keys are the catalogue's keys and
nothing casts a reply at the call site.

**Runtime command** — a `runtime.*` command, which the addon hands to the running game rather than
answering itself. Listed apart in the catalogue because it has no handler method: what routes it is
a match, not a table.

**Game** / **run** — the project playing. Distinct from the editor: the editor survives the game
being closed, and a node read out of a running game does not survive it.

**Epoch** — a counter that says which run, or which opened scene, a reading came from. A node path
means one node in the scene the editor had open when it was clicked and another in the next one, so
a chosen node carries the epoch that makes its path mean something.

## The frame

**Frame** — the IDE layout: explorer, centre, inspector, bottom panel, around one editor session.

**Remembered layout** — how a project's workspace was left, and the round trip that keeps it that
way: read both keys, hold the frame closed until they answer, reduce every change, write what
changed, drop the cursor of a script that is no longer open. It is
`src/services/remembered-layout.ts`. A frame that mounts before the read has answered writes the
defaults over the project's real layout, which is why it reports "not open yet" rather than handing
out a layout nobody has read.

**Interface state** — everything about how the window was left, stored per project: the remembered
layout, the script cursors, the sidebar's width, the unsent message of each task. Never the filter
boxes: a stored search reopens the project with files hidden and no sign of why.

One rule holds all of it, and it lives in `src/services/interface-state.ts`: a value is closed until
its key has answered, and a change while it is closed is dropped rather than written. Every
remembered value is a `rememberValue`, including the frame's layout. The frame keeps
`remembered-layout.ts` because it is a second key beside that one — a cursor per open script, which
is written on every keystroke and published to nobody — not because it obeys a different rule.

**Repair** — a torn tool call turned into the one the router accepts. Two engines make them, and
which one owns a repair is not a preference. The agent loop validates a call against the generated
schema between `prepareArguments` and the router, and the schema for a nested entry and for a tagged
value is closed — so a shape it refuses never reaches the table, and `scripts/tool-call-repair.mjs`
is the only layer that can answer it. The entry's own schema is open, so a key no operation declares
does reach the table, and `src-tauri/src/tool_repair.rs` answers everything a key or a value means.
`fixtures/tool-call-repairs.json` is one row per repair naming which engine owns it, and both suites
assert both halves of every row: the owner repairs it, the other leaves it exactly as the model
wrote it. Before that corpus the line was written down in two prose comments and checked by nothing,
which is how a fix for the double-wrapped tag came to exist only in JavaScript while both suites
stayed green.

**Driver** — which model service a turn is put to: `openai-compatible`, `openai-codex`, `openrouter`
or `cerebras`. A closed set of four, spelt as a Rust enum with `driver_id` for the wire word, as a
TypeScript union with `AI_CONNECTION_TYPES` beside it, and as `DRIVERS` in the worker.
`check-command-surface.mjs` reconciles the three, because a driver that reaches the worker as a word
no map has a key for used to resolve to the local provider — a hosted model's turn put to this
machine, with the hosted key never sent and nothing said about it.

There are two seams, and they answer different questions. `scripts/ai-provider.mjs` runs the turn,
over pi-ai, in the worker. `src-tauri/src/settings/catalogue.rs` asks which models may be picked and
whether a key is any good, which the renderer asks before a turn exists. A model the second offers
that the first cannot register fails mid-turn, which is why the drivers are held to one list.

**Failure** — what a command rejects with, and it is never prose: `code`, `message`, `retryable`,
`details`. The code is chosen where the situation is known rather than at the seam it crosses, and
`command_failed` is what an unclassified sentence carries until something names it. Eight Rust types
serialize to that one shape and a check refuses a ninth that does not, so `command_failed` means the
rejection never reached a command rather than that a command had nothing to say about itself.
