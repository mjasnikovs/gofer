# The tool parameter contract

One source of truth for what every tool operation accepts, the check that refuses a bad call in
Rust, the signature the model reads, and the addon's own backstop.

## Why it exists

A live session lost most of an hour here. The model sent

```json
{"type": "resource", "value": "res://scripts/player.gd"}
```

The path is right. The `{"path": …}` wrapper is missing. It was answered

```
unsupported_value: A resource value requires an object carrying a path
```

eight times, changed nothing between attempts, then decided scripts could not be attached at all and
started writing `.tscn` files by hand.

Nothing in that chain was broken. The shape was first examined by `Protocol.decode`, in GDScript, in
the editor, across a socket — and the answer reached the model flattened to `code: message`,
carrying no example and no echo of what arrived. A hand-written sentence was the whole recovery
path, and no test held it to anything.

## The pieces

```
protocol/schemas/v2/params.json      the source. Hand-written.
  │  npm run generate
  ├─► src-tauri/src/tool_params.rs   the table the router refuses a call against
  └─► src-tauri/addon/plugin.gd      COMMAND_PARAMS, the addon-side backstop
```

`npm run check` runs `--check`, so a hand-edited region fails the gate.

The signature the model reads is generated from the same table at serialization time — the worker
receives `{op, summary, signature, params}` per operation, and `ai-host.mjs` renders the signature
in front of the summary.

## What is checked where

| Layer                                                             | Checks                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `tool_params::check`, in Rust, before anything leaves the process | name is accepted, required present, JSON type, hash length and alphabet, tagged-value payload and arity |
| `_check_declared_params`, in the addon                            | name is accepted, required present                                                                      |
| `Protocol.decode`, in the addon                                   | tagged-value payload, and it is what actually builds the value                                          |
| the handler, in the addon                                         | does this node have that property, does the value fit its declared type, did the setter keep it         |

The last row is the only one that needs a running engine. Everything above it is arithmetic on JSON,
and doing it in Rust costs microseconds instead of a socket round trip.

## Measured, not argued

Local Qwen3.6-27B, 24 trials per cell, temperature 0.7, task: attach a script to a node.

| Variant                                                        | Right first try |
| -------------------------------------------------------------- | --------------- |
| prose only, parameters inside the sentence (before)            | 24/24           |
| generated signature, bare names — `{node, property, value}`    | **0/24**        |
| generated signature with kinds — `{node: text, value: tagged}` | 24/24           |
| kinds on the tricky parameters only                            | 10/24           |

Recovery from a wrong call, same tool description, only the error text differing:

| Error                                                                   | Recovered |
| ----------------------------------------------------------------------- | --------- |
| `A resource value requires an object carrying a path`                   | 18/24     |
| the router's failure, echoing the value and printing the corrected call | 24/24     |

Catalogue cost: 16 904 → 17 412 characters, about +3%.

## Gotchas

**A bare-name signature is worse than no signature.** `{node, property, value, expectedRevision}` in
front of the summary made the model flatten the tagged value to `{"type": "resource", "path": …}`
every single time. Writing the kind out — `value: tagged` — fixed it completely. Annotating only the
parameters that look tricky was worse than both. The annotation is uniform on purpose; do not "tidy"
it.

**Redundancy hurt too.** Keeping the sentence's own parameter list _and_ adding the signature scored
9/12, below either alone. Say it once.

**`expectedRevision` and `timeoutMs` never reach the addon.** The router lifts both onto the
envelope. They are in the Rust table and deliberately absent from `COMMAND_PARAMS`; an addon-side
guard that demanded them would refuse every well-formed call.

**The model never carries a hash.** `expectedHash` was built for Monaco — a buffer open in the UI
can go stale while the Godot editor or the watcher rewrites the file, and a whole-buffer save has no
anchor text to match on. The agent inherited the parameter by calling the same `Workspace::write`,
and a model duly copied 63 of its 64 characters.

`src-tauri/src/read_ledger.rs` holds the hash every read the router forwards answered with, keyed by
worktree and path. `godot_script save` and `godot_resource delete` are filled in from it. The
parameter is `hidden`: still accepted for a caller holding its own token, absent from the signature.
The guarantee is unchanged, because the value used is exactly what the agent's own last read
reported — a file that really did change still conflicts, and now truthfully.

A delete forgets its path, a move carries the record across, and deleting a task forgets its whole
worktree. `an_ai_turn_edits_a_scene_fixes_a_diagnostic_debugs_and_captures_the_game` saves with no
hash against a real editor, which is what proves the ledger rather than the comment.

pi does not have this problem. Its `edit` tool is `{path, edits: [{oldText, newText}]}` — the
content is the token, and the model already has it. Worth remembering if the whole-file save is ever
up for redesign.

**`scene` goes the other way.** Eight node commands read it, default it to the open scene, and the
desktop client passes it. The model is never told about it. That is `accepts` in the source and
`hidden` in the Rust table: accepted by the check, absent from the signature. Marking a parameter
hidden is not a way to save tokens on something the model needs — it is only for a parameter the
model has no reason to know exists.

**Absence means unchecked, never "takes nothing".** An operation with no entry is forwarded as it
always was. `the_untyped_domains_are_covered_operation_by_operation` fails if one of the four raw
domains grows an operation without a contract, which is the only reason absence is safe.

**Coverage is the whole catalogue, and it is enforced.** All 99 operations of all 11 domains are
declared. `every_catalog_operation_declares_its_parameters` fails if one is added without an entry,
so there is no exceptions list to grow.

The first cut covered four domains and left five to serde, on the reasoning that serde was already
their contract. That reasoning was wrong within a day: `expectedHash` lives in one of the five, a
model copied 63 of its 64 characters, serde saw `Option<String>` and waved it through, and the file
comparison reported `changed since it was read`. The agent re-read, copied it wrong the same way,
three rounds, then wrote the file raw — around the language server the domain exists to keep in the
loop. serde checks that a string is a string. That is not a contract.

The 50 operations serde still deserializes are now held to their structs both ways.
`every_field_the_rust_handlers_deserialize_is_the_one_the_catalog_documents` compares the declared
names against the real fields **and** the declared `required` against whether serde would accept the
field being absent — `Option<…>` or `#[serde(default)]`. A disagreement in either direction fails.

**The Rust region goes through rustfmt.** The generator emits one `op(...)` per line and lets
rustfmt break them, because guessing where rustfmt would break a line is a game the generator cannot
win — and losing it fails `npm run check` on a file nobody edited. `npm run generate` now needs
`rustfmt` on PATH.

**Validation runs before approvals.** A malformed call must never raise a dialog the user cannot
usefully answer. Same reasoning as `reject_outside_paths`, which already sat there.

## Gray areas

**Requiredness for the 8 router-arm operations is still hand-judged.** `godot_resource list`,
`godot_session status/start/stop` and the addon-answered commands have no struct to ask, so nothing
compares their `required` flags to a handler. One was wrong on the first pass: `resource.rescan`
treats an absent `path` as "walk the whole project", and declaring it required broke three
acceptance tests within a minute. That is the guard for those — the acceptance suite drives the real
editor, and it caught it. Do not add an addon operation without an acceptance test that calls it.

**Unknown-key rejection is strict.** A parameter the operation does not declare is refused rather
than ignored. It caught three wrong names in this repo's own tests on the first run — `setting`
where the handler reads `name`, in two Rust tests and one worker fixture. The risk is the mirror
image: a caller that has always passed something harmless and undeclared now fails. `hidden` is the
escape hatch, and `scene` is the only user of it so far.

**Coercion was considered and not taken.** `{"type": "resource", "value": "res://x.gd"}` could
simply be accepted — the path is unambiguous. It is refused instead, with the corrected call in the
message. Rejecting keeps one shape on the wire and the model measurably recovers, 24/24. Revisit
only with numbers.

**`value.schema.json` is still dead.** It describes the same tagged values and requires
`resourceType`, which nothing enforces and the addon does not read. It is stricter than the code
that works. Do not wire it up without reconciling it first.

**The addon backstop checks names, not shapes.** Duplicating the tagged-value table in GDScript
would be a second copy of the thing this design exists to have one of. `Protocol.decode` already
covers shapes there, and it is the layer that builds the value anyway.

**One model, one task.** Every number above is Qwen3.6-27B on one operation. The direction is strong
enough to act on — 0/24 against 24/24 is not noise — but a different model may weigh the signature
differently. `scripts/bench-tool-contract.py` is the harness; keep it if you want to re-measure
after a catalogue change.

## Kinds

`text`, `int`, `number`, `flag`, `list`, `object`, `hash`, `tagged`, `choice`, `either`.

`hash` is 64 lowercase hex characters and nothing else, and its refusal counts the characters it
got. `either` is a union — `tileSize` is one number or two, `solid` a list or the word `"all"`.
`object` means any object: what is inside `position` or `cells` belongs to the handler that reads
it, and that is the deliberate floor of this schema.
