# ADR 0002 — Godot command names are generated; their shapes are not

Date: 2026-08-09 Status: accepted

## Decision

`GodotCommandMap` is a mapped type over `GodotCommandName`, and `GodotCommandName` is emitted from
`protocol/schemas/v2/commands.json`. Its keys are therefore the catalogue's keys, checked by the
compiler with nothing to keep in step.

The params and result of each command are hand-written, in `KnownGodotCommands`, and only for the
commands somebody has had to name. Everything else keeps the shape every call site used before: a
dictionary in, a dictionary out.

```ts
call('scene.get_tree') // GodotSceneTree
call('scene.get_treee') // does not compile
call('node.get_cells') // Readonly<Record<string, unknown>>, until someone needs better
```

## Why the shapes are not generated too

The catalogue names a command and the addon method answering it. It does not describe a payload, and
making it describe one would mean a fourth schema — after `request`, `response` and `value` — that
nothing on the wire validates against. The addon builds its replies as GDScript dictionaries; the
generator cannot read a shape out of that without becoming a GDScript type checker.

So the shapes are a decision, in the same sense `DesktopCommandMap`'s are, and ADR 0001 already says
where decisions live: written by hand, next to the thing they describe.

## Why `KnownGodotCommands` is checked by a script rather than by the compiler

The map looks each name up conditionally:

```ts
Name extends keyof KnownGodotCommands ? KnownGodotCommands[Name] : GodotCommandSpec<…>
```

A key in `KnownGodotCommands` that no command has is looked up by nothing. It is not a type error —
it means nothing at all, quietly, while the command it was meant for keeps the generic shape.
TypeScript cannot constrain an object type's keys at its declaration without also demanding every
one of them, which would put fifty-odd entries back into the file this was written to avoid.

`scripts/check-command-surface.mjs` reads the keys and fails on one no surface offers. That is the
same instrument the mutating lists are held to, so there is one way this repo catches a name that
has drifted rather than two.

## Consequences

- A command added to `commands.json` is callable after `npm run generate`, with no second step.
- A command removed from it stops compiling wherever the renderer names it.
- Giving a command a real shape is one entry, and the checker proves the entry names something.
- `runtime.*` commands are in the catalogue too, under `runtimeCommands`, because the renderer types
  them and the union has to hold them. They carry no handler: the addon routes them.
