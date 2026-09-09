# S is any SCRATCH directory. Unset, every script uses its own directory.

S=$(git rev-parse --show-toplevel)/scripts/bench

# 1. build the four surface arms from one catalog.json (S1 is shapes-tools-C.json verbatim)

cd $S && SCRATCH=$S node surf-build.mjs

# 2. does llama.cpp constrain each arm's parameter schema? (S4's top-level oneOf: no)

SCRATCH=$S node s4-probe.mjs      # bare oneOf vs {type:object, oneOf}
SCRATCH=$S node
s4-control.mjs # the control: S1 ops-array and S3 flat object

# 3. one-turn smoke on every arm

SCRATCH=$S node smoke.mjs

# 4. the sweep (max_tokens 3072 for every arm; S4 is unconstrained and rambles without it)

# 6 tasks x 4 arms x 10 seeds, interleaved S1,S2,S3,S4 inside each (seed, task)

SCRATCH=$S ARMS=S1,S2,S3,S4 SEEDS=10 OUT=surf-rows node surf-run.mjs

# 5. static token cost of each arm's tool block

SCRATCH=$S node surf-tok.mjs

# 6. tables and paired sign counts

SCRATCH=$S ROWS=surf-rows node surf-report.mjs

# re-score without re-running the model (every call each trial wrote is stored in the rows)

SCRATCH=$S ROWS=surf-rows node surf-rescore.mjs

# 7. S4 is unconstrained on this server, so its loss is about GBNF, not about the surface.

# S4b keeps S4's "one call = one operation" but puts the oneOf under an `operation` key,

# one level down, where llama.cpp does constrain it. Paired against a fresh S1.

SCRATCH=$S ARMS=S1,S4b SEEDS=10 OUT=surf-rows-b node surf-run.mjs
SCRATCH=$S ROWS=surf-rows-b node
surf-report.mjs

# ---------------------------------------------------------------- after a step that moves the surface

S1 stays the shipped list, verbatim. S2 is what the worker builds now, with the prompt it ships. The
sign of the paired S2-S1 gap (tokens down, success not down) must not change.

```sh
GOFER_DUMP_CATALOG=/dev/null GOFER_DUMP_PROMPT=$S/surf-prompt-S2.txt \
  cargo test --manifest-path src-tauri/Cargo.toml --features godot-acceptance --lib -- dump_catalog_and_prompt
SCRATCH=$S node surf-build.mjs            # S1 and surf-map.json
SCRATCH=$S ARM=S2 node surf-built.mjs     # overwrites surf-tools-S2.json with the built surface
SCRATCH=$S ARMS=S1,S2 SEEDS=10 OUT=surf-rows-step node surf-run.mjs
SCRATCH=$S ROWS=surf-rows-step node surf-report.mjs
```
