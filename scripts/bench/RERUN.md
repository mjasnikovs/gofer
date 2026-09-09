S=/tmp/claude-1000/-home-edgars-hub-gofer/72384aaf-2ce9-4e2b-8bff-21b1bdfacb1e/scratchpad

# 1. build the three tool sets (A shipped, B = git show 851e1fb^:scripts/tool-schema.mjs, C = A without op.description)

cd $S && SCRATCH=$S node shapes-build.mjs

# 2. static token cost of each arm's tool block

SCRATCH=$S node shapes-tok.mjs

# 3. the llama.cpp facts behind arm D

SCRATCH=$S node d-probe.mjs      # D1 constraint, D2 grammar+tools, D3 json_schema+tools
SCRATCH=$S
node d-probe2.mjs # D4 tool_choice auto, D5 control, D6 oneOf branch

# 4. the sweep: 4 tasks x 3 arms x 12 seeds, interleaved A,B,C inside each (seed, task)

SCRATCH=$S ARMS=A,B,C SEEDS=12 OUT=shapes-rows node shapes-run.mjs

# 5. the fifth task shape, same harness

SCRATCH=$S ARMS=A,B,C SEEDS=12 ONLY=shape OUT=shapes-rows-shape node shapes-run.mjs

# 6. tables and paired sign counts

SCRATCH=$S ROWS=shapes-rows node shapes-report.mjs
SCRATCH=$S ROWS=shapes-rows-shape node
shapes-report.mjs

# re-score without re-running the model (every call each trial wrote is stored in the rows)

SCRATCH=$S ROWS=shapes-rows node shapes-rescore.mjs
