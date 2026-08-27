# ADR 0001 — No pass-through wrappers around desktop commands

Date: 2026-08-09 Status: accepted

## Decision

A module in `src/services` earns its place by holding knowledge its callers should not have. A
function whose whole body is `invoke('some_command', args)` holds none, and is not written.

Callers name the command themselves:

```ts
const settings = await invoke('load_settings')
await invoke('save_settings', {request})
```

## Why this was reopened

Six service modules held roughly fifty exported functions, each one line. `settings-store.ts` stated
the reason at the top:

> Every one of these is a one-line wrapper, and that is the point: a page that names the backend
> command itself can only be tested by replacing the whole IPC module, and replacing that module is
> what stops a test from ever noticing that the command name changed.

Both halves of that were true when it was written. Neither is true now.

**A test replacing the IPC module is what the tests already do.** `src/test/backend.ts` is one
in-memory Gofer backend sitting behind `desktop-driver`, holding a scene the editor has open and a
script whose hash moves when it is saved. A test that mounts a screen gets a working backend, not a
`mockResolvedValue`. Nothing substitutes the bridge: what `vi.mock` is still used for is standing in
for a browser API — `monaco-runtime`, `annotation-canvas` — never for a Gofer command.

That last sentence stopped being true once and was put back. Three test files had grown their own
fake: two replaced `services/desktop` outright, one set the driver hook by hand, and the two
replacing it were the ones a renamed command was invisible to — the exact cost this decision was
weighed against. `eslint.config.mjs` now refuses a `vi.mock` of that module, so the claim is checked
rather than asserted.

**A renamed command is caught by three checks, none of which is a wrapper.**
`src/services/desktop.contract.test.ts` reads `DesktopCommandMap` against the `generate_handler!`
list in `lib.rs`. A Rust test reads that same list against the permission grant.
`scripts/check-command-surface.mjs` reconciles all five surfaces. A wrapper cannot notice a rename
in Rust at all; TypeScript does not read `lib.rs`.

So the wrappers were paying a real cost — a second name for every command, a second place to edit, a
file to open before you can see what a screen actually calls — to defend against something three
other things already defend against.

## What stayed

`invoke` itself. It is typed by `DesktopCommandMap`, so the command name and its argument shape are
checked at the call site, and it is the seam the fake backend is installed at.

These modules, because each holds something a caller should not have to know:

| Module              | What it holds                                                        |
| ------------------- | -------------------------------------------------------------------- |
| `ai-stream.ts`      | opens the `Channel` a streamed turn is delivered on                  |
| `godot-session.ts`  | unwraps `response.result` for `callGodot`                            |
| `script-session.ts` | opens the diagnostics `Channel`, restores a structured `ScriptError` |
| `file-dialog.ts`    | turns the picker's path / array / `null` into one answer             |

`godot-session.ts` also minted the correlation id, which was listed here as a second reason. It no
longer does: the id's rules — a length cap, a reserved namespace, and uniqueness against abandoned
requests — belong to the transport, and `RpcSession` mints it. Unwrapping the result is reason
enough on its own.

Those files also contain pass-throughs, sitting beside the parts that do work. They stay where they
are: splitting a script command away from `toScriptError` would cost more than the line it saves.

## Consequences

- `settings-store.ts`, `tasks.ts`, `chat-session.ts` and `health-check.ts` are gone, along with
  `settings-store.test.ts` and `tasks.test.ts` — which only asserted that a wrapper called `invoke`
  with the name it was written to call.
- Reading a component tells you which backend command it uses, without opening a second file.
- Adding a command means adding it to `DesktopCommandMap` and calling it. There is no third step.
- If a call site ever needs shaping — an envelope built from several arguments, a result unwrapped,
  an error restored — that is a module, and it should be written. The rule is about pass-throughs,
  not about a ban on services.
