# S is any SCRATCH directory. Unset, every script uses its own directory.

S=$(git rev-parse --show-toplevel)/scripts/bench

Both measurements sit on the S2 surface (one `godot` tool, an `ops` array, a per-op oneOf with
dotted `op` consts). `s2.mjs` builds that surface from whatever catalogue it is handed, so an arm is
a catalogue transform and nothing else. `vrun.mjs` is the shared interleaved runner: same seed, same
task, arms back to back, three turns, max_tokens 3072, reasoning_effort medium.

# 0. the engine's own words, and the nearest-name refusal V3/P3 answer with

SCRATCH=$S node -e
'import("./vocab.mjs").then(v=>console.log(v.KEYS_ALL.length,v.MONITORS_ALL.length,v.TAGS_ALL.length))'

# ---------------------------------------------------------------- MEASUREMENT 1: vocabulary

# 1. build V1 (as shipped), V2 (full engine vocab as schema enums, prose unchanged),

# V2p (same enums, prose no longer repeating a shorter list), V3 (no vocabulary anywhere)

cd $S && SCRATCH=$S node vocab-build.mjs

# 2. static token cost

SCRATCH=$S PREFIX=vocab ARMS=V1,V2,V2p,V3 node vtok.mjs

# 3. the sweep — 6 tasks x 4 arms x 10 seeds, interleaved inside each (seed, task)

SCRATCH=$S ARMS=V1,V2,V2p,V3 SEEDS=10 OUT=vocab-rows node vrun.mjs

# 4. tables and paired sign counts against the shipped arm

SCRATCH=$S ROWS=vocab-rows BASE=V1 node vreport.mjs

# every Godot word each arm actually wrote

SCRATCH=$S ROWS=vocab-rows node vwords.mjs

# ---------------------------------------------------------------- MEASUREMENT 2: behavioural prose

# 5. build P1 (summaries as shipped), P2 (first sentence only), P3 (no summaries), on the

# vocabulary placement measurement 1 chose

cd $S && SCRATCH=$S VOCAB=V2p node prose-build.mjs SCRATCH=$S PREFIX=prose ARMS=P1,P2,P3 node
vtok.mjs

# 6. the sweep — 5 tasks x 3 arms x 10 seeds

SCRATCH=$S PREFIX=prose ARMS=P1,P2,P3 SEEDS=10 OUT=prose-rows node vrun.mjs

# 7. tables

SCRATCH=$S ROWS=prose-rows BASE=P1 node vreport.mjs

# 8. measurement 2 answered "no difference" at 10 seeds, so ten more, then both halves together

SCRATCH=$S PREFIX=prose ARMS=P1,P2,P3 FROM=11 SEEDS=20 OUT=prose-rows-b node vrun.mjs
node -e 'const fs=require("fs");const a=n=>JSON.parse(fs.readFileSync(`'$S'/${n}.json`,"utf8"));fs.writeFileSync("'$S'/prose-rows-all.json",JSON.stringify([...a("prose-rows"),...a("prose-rows-b")]))'
SCRATCH=$S ROWS=prose-rows-all BASE=P1 node vreport.mjs

# extra pairings the report only prints against its BASE

SCRATCH=$S ROWS=vocab-rows BASE=V2 node vreport.mjs     # V2 vs V2p
SCRATCH=$S ROWS=prose-rows-all
BASE=P2 node vreport.mjs # P2 vs P3

# files

# vocab.mjs Godot's 190 keys / 59 monitors / 41 tags, and the nearest-name refusal

# s2.mjs the S2 surface, built from any catalogue

# vocab-build.mjs V1 / V2 / V2p / V3, and the catalogue each was built from

# prose-build.mjs P1 / P2 / P3 over vocab-catalog-$VOCAB.json

# vocab-tasks.mjs six vocabulary asks, and the router that checks every word

# prose-tasks.mjs five behavioural asks, their traps, and the rule each trap answers with

# vrun.mjs vreport.mjs vwords.mjs vtok.mjs
