# The Godot tool contract, generated end to end

## The defect

Typing `hi` in a project cost 32,443 prompt tokens. 29,090 of them were the 19 tool definitions. The
10 Godot tools alone were 26,199. A commit made the same day added 10,217 of that and sent every
operation summary twice.

Behind the 10 tools sit 110 operations and 197 parameters, all from one hand-written file,
`protocol/schemas/v2/params.json`. The typed half of that file is generated into Rust, the addon
guard, the dispatch table and the JSON schema, and checked both ways. The other half is 38,376
characters of English that nothing holds to the engine: 22,359 in summaries, 9,895 in parameter
notes, 2,850 in domain descriptions.

Against the pinned engine (4.7.2): the catalogue names 25 key names, Godot has 190. 15 monitors,
Godot has 59. 23 value tags, Godot has 39. Six addon commands had no guard row, the 12 `runtime.*`
commands skipped the guard, an unknown command passed it, and the signature the model reads
disagreed with the schema on `create_tileset.solid`. Eight operations were never run by any test.

## The evidence

Every number below is an interleaved, same-process A/B against the local model
(Qwen3.8-27B-UD-Q4_K_XL on llama.cpp, no temperature, reasoning medium), ≥10 seeds per arm, scored
mechanically. Cross-run numbers flip sign; only the paired comparison inside one run counts. The
recorded corpus was used to choose tasks and nothing else — it mixes model faults with Gofer bugs of
the day and cannot tell them apart.

### Where 32k goes

| piece                                                                    | tokens |                                                                                                             % |
| ------------------------------------------------------------------------ | -----: | ------------------------------------------------------------------------------------------------------------: |
| 10 Godot tools                                                           | 26,199 |                                                                                                            81 |
| — of which per-op `oneOf` schemas                                        | 13,734 |                                                                                                            42 |
| — of which the summary copied into it                                    |  5,286 |                                                                                                            16 |
| — of which prose descriptions                                            |  7,509 |                                                                                                            23 |
| 5 local extras                                                           |  1,900 |                                                                                                             6 |
| 4 pi built-ins                                                           |    991 |                                                                                                             3 |
| inventory (`git ls-files`, 245 lines)                                    |  2,179 |                                                                                                             7 |
| the one note nothing else said: `runtime.inspect_node.path` names a node |    ~60 | in vs out on a running-tree ask, 10 seeds: 10 / 10 both ways, the model reads the path off `runtime.get_tree` | —   | **cut stands** |
| system prompt                                                            |  1,419 |                                                                                                             4 |
| the word `hi` and the template                                           |     11 |                                                                                                             0 |

Chat-template framing adds about 185 tokens per tool on top of its own JSON.

### Schema: the per-op `oneOf` stays, the copy goes

| arm                               | prompt tok/turn | raw-invalid | success |
| --------------------------------- | --------------: | ----------: | ------: |
| merged bag (before 851e1fb)       |          19,304 |         26% |     67% |
| per-op `oneOf` as shipped         |          30,637 |          0% |     92% |
| per-op `oneOf`, summary sent once |          24,791 |          0% |     98% |

The merged bag fails on two shapes: an op with many optional scalars (`logs read`, 67% invalid) and
a parameter with two kinds (`create_shape.size`, 73%). The router rescued none of them.

llama.cpp constrains tool-call arguments to the tool's own parameter schema with a grammar. It
refuses a custom `grammar` beside `tools` (HTTP 400) and `json_schema` turns tool calls off. So the
schema in the prompt is the constraint itself; there is no cheaper place to put it. A `oneOf` at the
root of `parameters` is **not** constrained; one level down it is.

### Surface: one tool

| shape                           | success | prompt tok/turn | editor round trips |
| ------------------------------- | ------: | --------------: | -----------------: |
| 10 tools, `ops` array (shipped) |     97% |          24,887 |               1.25 |
| **1 tool, 110 dotted ops**      |     98% |          24,232 |               1.13 |
| 110 flat tools                  |    100% |          29,417 |               1.50 |
| 10 tools, no `ops` array        |      0% |               — |                  — |

One tool was cheaper on 60 of 60 paired trials. Flat reads best and pays for it in tokens and round
trips. No `ops` array is unusable because of the root-`oneOf` rule above; moved one level down it
works and costs 33% more round trips, so the array earns its keep.

### Vocabulary: the engine's lists as enums, no list in prose

| arm                                            | tok/turn | success | wall/trial |
| ---------------------------------------------- | -------: | ------: | ---------: |
| 25 keys / 15 monitors / 23 tags, in prose      |   19,828 |     48% |     14.4 s |
| engine lists as enums, old prose kept          |   21,573 |     87% |      5.0 s |
| **engine lists as enums, prose names no list** |   20,986 |     95% |      4.4 s |
| no vocabulary, refusal names the nearest       |   19,131 |     60% |      8.6 s |

The enum permits, the prose steers: the same enum with stale prose beside it lost. A refusal naming
the nearest match recovers a misspelling and never a different word (`Numpad 5` never became
`Kp 5`).

### Prose: the summaries earn their keep

| arm                      | tok/turn | success | tok/trial |
| ------------------------ | -------: | ------: | --------: |
| **full summaries**       |   23,636 |     78% |    35,492 |
| first sentence only      |   19,664 |     68% |    32,689 |
| none; the result teaches |   18,418 |     66% |    32,257 |

Cutting saves per turn and costs turns. Teaching by tool result fails: the rule arrives after the
mistake and the model repeats it. Only one rule discriminated ("a Button answers the release, not
the press"); the others every arm already followed. Which lines are dead is unmeasured — see Trims.

### Batch operations

At 20 nodes, `create_nodes` / `set_properties` turn 40 editor round trips into 2, cut output tokens
16–19% and wall time 40–60%, for 791 prompt tokens once. Keeping the single op beside the batch made
the model split the turn; batch-only beat both. The model never emitted two tool calls in one
message on this surface (0 of 126). It packs work into the `ops` array instead.

The model never sends `expectedRevision`. Rust's read ledger fills it in. The revision lock was
never the model's problem.

### The prefix is reused

| turn              | evaluated | prefill |
| ----------------- | --------: | ------: |
| first, cold       |    24,682 |    27 s |
| same prefix again |         4 |   0.3 s |
| new user text     |       261 |   0.9 s |

The block costs one slow first turn per session, then the tail only. Cloud providers cache the same
way. So the tool set must not change within a session.

### The repair layer

`src-tauri/src/tool_repair.rs` changed 0 of 3,199 recorded entries when run in pipeline order behind
today's schema. The only thing that keeps it reachable is the tagged value: the schema leaves a
`{type, value}` payload open. The worker's `normalizeToolCalls` is live and runs first (fixed 4,
refused 3, touched 0 valid calls).

## The design

### One tool

One tool, `godot`. One `ops` array. Each entry is one `oneOf` branch pinned to one operation by a
dotted const: `node.create`, `script.edit`, `runtime.input`. `additionalProperties: false`, its own
`required`. The description lists the operations grouped by domain, one line each: the dotted name,
the generated signature, the summary. The summary appears nowhere else.

Every op has the same shape. There is nothing tool-specific left for the model to learn.

### Every name is Godot's own

The model writes only names the engine publishes, verbatim, never a Gofer alias:

- key names as `OS.get_keycode_string` spells them: `Enter`, `Kp 5`, `JIS Eisu`
- monitors as the `Performance.Monitor` constants: `NAVIGATION_AGENT_COUNT`
- value tags as `type_string` spells them: `Vector2`, `PackedVector2Array`
- mouse and joypad buttons and axes as their enum constants
- node classes as `ClassDB` names

Each list is a schema `enum`. No summary or note recites any member of any list; a test refuses one
that does.

### Generated from the engine

`npm run generate` runs the pinned Godot once, headless, and writes
`protocol/godot-vocabulary.json`. Two sources feed it:

- `godot --headless --dump-extension-api`: `Key`, `Variant.Type`, `Performance.Monitor`,
  `MouseButton`, `JoyButton`, `JoyAxis`, every `Node` subclass and its typed properties.
- `godot --headless --script`: the key _strings_. They are not in the dump, and 57 of 190 are not a
  mechanical transform of the enum name. `OS.get_keycode_string` over the keycode space,
  round-tripped through `find_keycode_from_string`, yields exactly 190.

Both runs take about half a second. From that file plus `params.json`, one generator emits:

| target                                      | what                                              |
| ------------------------------------------- | ------------------------------------------------- |
| `protocol/schemas/v2/godot-tool.json`       | the tool the model reads, committed               |
| `src-tauri/src/tool_params.rs`              | the operation table and every vocabulary constant |
| `src-tauri/addon/params.gd`                 | the guard rows, one per command, no exceptions    |
| `src-tauri/addon/runtime.gd`, `protocol.gd` | the monitor and tag tables, from the same list    |
| `src/models/godot-commands.ts`              | command names and typed params                    |

The worker does not build a schema at runtime. It loads the committed one. A test asserts the two
are byte-identical, which retires the signature-versus-schema drift: both are printed from one table
by one program.

`npm run test:godot:api` becomes "a fresh dump equals the committed one". It moves only when the pin
moves, which is when it should.

### One shape per job

- The eight two-kind parameters go. Five (`path: text | list` on `script open/close/diagnostics`,
  `resource rescan`) become one `paths: listOf text` and always answer `{files: […]}`. `tileSize`
  and `create_texture size` become width and height. `input events.button` becomes a button choice
  for `mouse_button` and an index for `joypad_button`.
- The single twin of each batch op goes: `node.create` and `node.set_property` are `create_nodes`
  and `set_properties` with one entry.
- `logs.read` gets a default `minSeverity`. Every non-flat failure in the surface run was that call
  without it.
- Hidden parameters (`expectedRevision`, `scene`, `expectedHash`, `maxPassages`) leave the schema.
  The router supplies them; a grammar that permits them lets the model write what the prose forbids.
- The tagged value closes: each tag's payload shape is in the schema, generated from `Variant.Type`.
  With that, `tool_repair.rs` is unreachable and is deleted. `normalizeToolCalls` stays; the one
  shape it misses (`ops` written as a JSON string) gets a rule.

### Results are typed in the chain, never in the prompt

`params.json` gains a `result` per operation. The generator emits a Rust struct per op; in debug
builds `godot_rpc` deserializes every addon answer into it and a mismatch is a test failure, not a
sentence. TypeScript's `KnownGodotCommands` is emitted from the same source, all 68, not 16 by hand.
The model never sees any of it.

### What holds it

| claim                                    | test                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| the model reads what the generator wrote | worker output == committed `godot-tool.json`, byte for byte                                |
| every enum is the engine's               | fresh dump == `godot-vocabulary.json` (`test:godot:api`)                                   |
| no prose recites a list                  | no summary or note contains a vocabulary member                                            |
| no hidden param is in the schema         | schema keys ⊆ visible params, per op                                                       |
| every command is guarded                 | every dispatched and runtime command has a row; unknown is refused                         |
| every op runs                            | `dispatch` records ops during the acceptance suite; the complement over `CATALOG` is empty |
| every answer has the declared shape      | debug-build deserialization at the socket                                                  |
| the surface is what was measured         | the harness below, re-run on the built surface, same sign                                  |

### What is deleted

Ten tools. `op.description` inside the schema. The runtime schema builder. `tool_repair.rs` and its
fixtures' `router` rows. The single twins of the batch ops. `ai_tools.rs`'s hand-written domain
descriptions move into `params.json` as a `domains` block so the same checks reach them.

## Build order

Each step ends with `npm run check` green and one commit on `master`. A step that moves the surface
ends with the harness re-run and the sign unchanged.

1. Delete `description: operation.summary` from the `op` const. Take hidden params out of the
   schema. Both proven; no measurement.
2. One tool. `godot-tools.mjs`, `tool-schema.mjs`, the JS dispatcher, the `Wire` the Rust catalogue
   hands the worker, the chat's tool rows, the tests.
3. Engine dump at generate time. `godot-vocabulary.json`, the enums in the schema, the addon tables
   for all 59 monitors and 39 tags, `test:godot:api` rewritten.
4. One shape per job: the eight params, the two twins, the `logs.read` default, the tagged closure.
   Delete `tool_repair.rs`.
5. Results in `params.json`; Rust structs, TS types, debug-build validation.
6. The dispatch hook and the complement test.
7. Trims, below, one measurement each, on the built surface.

## Trims

Measured 2026-09-10, on the surface step 6 left, interleaved in one process, 20 seeds on the trap
tasks and 10 on the surface tasks. Each cut alone first, then every cut that held as one arm —
eleven lines that each measured "no effect" once destroyed the survivors when cut together, so the
set is what decides.

| trim                           | tokens/turn | alone                                                                                                                    | in the set                                                          | verdict                                                                                                                       |
| ------------------------------ | ----------: | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| summaries: first sentence only |      -3,713 | 73% vs 70%, better on 9 pairs, worse 6                                                                                   | held                                                                | **cut**; `runtime.input` keeps its whole summary, the one rule the prose run found the model does not already obey            |
| per-parameter `note`s          |      -1,624 | tie, 8 / 7                                                                                                               | held                                                                | **cut**                                                                                                                       |
| the signature line             |      -1,064 | tie, 0 / 0 on 60 pairs                                                                                                   | held                                                                | **cut**                                                                                                                       |
| domain descriptions            |        -616 | tie, 0 / 0 on 60 pairs                                                                                                   | held                                                                | **cut**                                                                                                                       |
| the set of the four            |      -7,037 | —                                                                                                                        | 5 / 5 on 100 trap pairs, 0 / 0 on 60 surface pairs, 26,445 → 19,408 | **shipped**                                                                                                                   |
| inventory vs a `files.list` op |      -1,150 | inventory better on 9 pairs, worse 4; the op costs a turn and an editor round trip on 32 of 60; 0 ghost paths either way | —                                                                   | **keep the inventory**                                                                                                        |
| the five local extras          |      ~1,900 | over 840 trials: subagent, remember, ask_user never called; web_search 8, web_fetch 2                                    | —                                                                   | **keep**: the task shapes here never need them, so removal cannot be measured by them, and each has a job outside these tasks |
| system prompt                  |      ~1,400 | every shortened version lost on 2026-08-12                                                                               | —                                                                   | **leave alone**                                                                                                               |

On the harness's turn — the shipped prompt, the tool block and the ask — that is 19,408 prompt
tokens. The same turn cost 24,875 on the ten-tool list step 2 was measured against, and the schema
run put the surface before step 1 at 30,637.

The harness that produced every number here is committed under `scripts/bench/` (`surf-*.mjs`,
`vocab-*.mjs`, `vrun.mjs`, `vreport.mjs`, `prose-*.mjs`, `trim-build.mjs`, `inv-*.mjs`,
`VOCAB-RERUN.md`, `SURF-RERUN.md`). It builds the arm under test from the committed
`godot-tool.json` and the shipped prompt, scores with `ajv` against the strict schema, and replays
`normalizeToolCalls`. Each RERUN file ends with the recipe for re-running a step: the previous
step's built arm as the baseline, the new build as the arm, the sign of the paired gap as the
verdict.
