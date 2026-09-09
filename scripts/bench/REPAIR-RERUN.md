S=/tmp/claude-1000/-home-edgars-hub-gofer/72384aaf-2ce9-4e2b-8bff-21b1bdfacb1e/scratchpad

# 1. corpus: every recorded toolCall out of tasks.agent_messages_json in every ~/hub/*/.gofer/project.sqlite

# (messages.payload_json carries none; logs/oxloop does not exist on this machine)

cd $S && SCRATCH=$S node extract.mjs # -> corpus.json (3054 calls)

# 2. standalone crate: the real tool_repair.rs + tool_params.rs, with a stub ai_tools (ToolFailure,

# ToolDomain, CATALOG lifted verbatim from ai_tools.rs:124-207). tool_repair.rs carries one

# scratch-only addition, which_rules_fire, that names the rule of repair_set that acted.

cd $S/rustprobe && cargo build --release

# stdin [{tool, entry}] -> stdout [{known, changed, before, after, checkBefore, checkAfter, rules}]

# 3. the real order: normalizeToolCalls -> generated schema (ajv over createGodotTools parameters)

# -> tool_repair.rs

cd $S && SCRATCH=$S node pipeline.mjs

# 4. per-rule attribution, both engines, plus the counterfactual on what the schema refuses

cd $S && SCRATCH=$S node attribute.mjs

# 5. fixtures/tool-call-repairs.json, row by row: does today's schema accept it, who repairs it

cd $S && SCRATCH=$S node fixture-rows.mjs

# 6. Q2: every either/tagged/object parameter, and how the corpus used each side

cd $S && SCRATCH=$S node kinds.mjs
