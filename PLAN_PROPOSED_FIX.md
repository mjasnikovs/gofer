# Plan: catch invented facts in a plan before it is implemented

## Context

A plan for the `swarm` Godot project was reviewed by hand and carried five defects. They split
cleanly into two classes.

**Invented facts** — three `docs/*.md` files named in CONSTRAINTS that do not exist, and a
`/root/MainWorld/SwarmDirector` node path that is wrong because `MainWorld` sits under
`PixelPerfectShell`. Neither was ever opened. Both were written from a guess that reads plausibly.

**Control-flow bugs** — a 0.25s attack animation against a 0.12s cooldown, a projectile moving in
local space because it is a child of the firing unit, and a hover ring placed in a function that
returns on its first line. Each needs the code run in the head across two files.

Everything the plan got _right_ was copyable off a single line: `OVERLAY_Z_INDEX`, alpha `0.6`,
`_cell_occupied`, the exact `Vector2(FRAME_SIZE * 0.5, 0.0)`.

This plan mechanises the first class only. The second class is not detectable from text and is
addressed by a prompt rule, not a checker.

## Measured evidence (prototype, before the checker was built)

Ran a prototype over the committed `.pi-tasks/` corpora under `/home/edgars/hub`. Scope: backticked
tokens inside `CONSTRAINTS` sections, which are references by definition — a freeze or a "preserve"
names something that must already exist.

| pass                                | corpus                | candidates | unresolved |
| ----------------------------------- | --------------------- | ---------- | ---------- |
| naive (`existsSync` from repo root) | 105 sections, 7 repos | 2076       | **32.1%**  |
| discriminated (below)               | same                  | 1503       | **3.4%**   |

The 32% was not phantoms. Every false positive had a nameable shape: npm specifiers
(`@hono/zod-validator`), URL routes (`/api/auth/me`), MIME types (`image/webp`), bare extensions
(`.tsx`), relative import specifiers (`../db`), and dotted code expressions (`c.var.user`,
`Bun.build`). Bare basenames (`db.ts`, `auth.ts`) were real files that simply are not at the repo
root.

The discriminator that produced 3.4%:

- reject a leading `@` (npm scope), a leading `/` (route), a bare `.ext`, and `./` `../`
- require a source extension (`ts|tsx|js|json|md|sql|yml|css|html|gd|tscn|rs|toml|sh|…`)
- resolve against `git ls-files` first, then `existsSync`, then a **basename index**

**A true positive fell out with no hand labelling.** `playwright-ct.config.ts` is named in 9
CONSTRAINTS lines across `hub/mx5-n`. `TASK_0014` promised to create it, committed as `ed93e4b`, and
the file does not exist at HEAD. Nine plans constrained a file that was never written.

Most of the surviving 3.4% are glob patterns (`src/server/**/*.ts`, `*.spec.tsx`) and elisions
(`0002_….sql`). Excluding those is one more rule.

## Smoke results — all four fixes built, gray areas closed (2026-09-09)

`scripts/plan-check/`. 63 known-answer tests, all passing. `npm run check` 20/20.

### Smoke 2 — swarm plan, known answer. PASSED

Four findings, exactly the four invented facts, zero false positives, and the repo inferred with no
flag.

```
[fix 1] unresolved-path  docs/design.md
[fix 1] unresolved-path  docs/spec-unit-combat.md
[fix 1] unresolved-path  docs/audit-unit-combat.md
[fix 4] bad-node-path    /root/MainWorld/SwarmDirector
        scenes/main.tscn roots at `Main`, not `MainWorld`
```

### Smoke 1 — pi-task CONSTRAINTS corpus. PASSED

105 plans, 1480 claims, 22 findings. **1.5%, 0.21 per plan.**

### Smoke 3 — 83 Claude plans. PASSED, after the gray areas below

74 bound, 9 refused. 116 claims, **13 phantoms, 0.18 per plan.** (7 before the cross-repo tier was
tightened by the live run below; the extra 6 are bare filenames that exist in a sibling repo, now
reported with that note.)

Spot-checked by hand: three of the seven existed in git history and were deleted, so they are
genuine dangling references, not classifier noise.

### Binding accuracy — the number smoke 3 was missing. 91.7%

Ground truth was recovered rather than invented. Claude Code stores each session under a directory
named for its cwd, and those transcripts name the plan file, so the transcript's directory IS the
plan's repo. 139 plans mapped, 81 usable.

**66 correct, 6 wrong, 9 refused.** Every miss is aiz-client versus aiz-server — sibling repos that
share filenames. `truth.mjs` and `bind-accuracy.mjs` keep this measurable rather than assumed.

## Live A/B against a real model (Qwen3-27B, 2026-09-09)

The corpora above are all plans written earlier by someone else. The question they cannot answer is
whether a model, asked fresh, writes the defects this checker looks for — and whether the checker
separates that from noise.

Six real Godot tasks against `hub/swarm`, two arms, **interleaved in one process** because cross-run
numbers flip sign. Same task, same format, one difference:

- **arm A** — the model gets no file inventory
- **arm B** — the model gets `git ls-files` for the repo

| arm                | plans | claims | findings | per plan |
| ------------------ | ----- | ------ | -------- | -------- |
| A — no inventory   | 6     | 20     | 22       | **3.67** |
| B — `git ls-files` | 6     | 28     | 1        | **0.17** |

**21x separation, and 5 of 6 arm-B plans are completely clean.** Arm A makes _fewer_ claims and
carries _more_ findings, so this is not a volume effect. The checker is measuring invention.

### The detection evidence that was missing

The earlier note said the ported predicates had no real-data proof — 743 real VERIFY commands, zero
hits, on a corpus pi-task's own gates had already policed. Arm A closes it. One plan's VERIFY block
contained **seven** commands of the exact rule-C shape, unprompted:

```sh
grep -q 'WaveLabel' scenes/ui/hud.tscn && echo "OK: WaveLabel present" || echo "FAIL: WaveLabel missing"
godot --headless --import --path . 2>&1 | grep -i 'error' && echo "FAIL" || echo "OK: no parse errors"
```

Both exit zero whatever they find. A model writes this shape on its own, and the ported predicate
catches it. That is detection on text no human wrote for this suite. Both plans are kept as fixtures
under `fixtures/live/`.

### A bug the live run found

Five invented paths were being labelled `cross-repo-path` and quietly excused.
`scripts/units/unit.gd` exists in **no** repo — swarm's file is `units.gd`, plural — but some other
project had a file named `unit.gd`, and the cross-repo check was accepting a bare basename.

Tightened to exact-or-suffix, the same reasoning binding already used. This turned an invention into
a false reassurance, which is the worst direction for this tool to fail in. Cost: smoke 3 went from
7 findings to 13, still 0.18 per plan. Six of those thirteen are bare filenames that exist in a
sibling, and the finding now says so rather than implying the name was invented.

## Gray areas, and what closed them

Reporting findings-per-plan without measuring binding hid a real problem. Five things were wrong;
four are fixed.

**Binding had no ground truth.** Closed by `truth.mjs`, above.

**Most smoke 3 findings were cross-repo references, not phantoms.** A plan cites a sibling
constantly — a server plan naming a client component, a plan citing pi-task as a reference. Those
are correct about the filesystem and wrong about the plan. Now a separate finding kind,
`cross-repo-path`, decided structurally: the token resolves in another candidate repo. This alone
took smoke 3 from 22 findings to 7.

**Paths written relative to a source root were called missing.** `task/loop-detector.ts` for
`src/task/loop-detector.ts`. Added a `suffix` resolution tier, matching only on a segment boundary
and only for a token carrying a directory — a bare basename stays in the weaker tier, because
admitting it would make every repo match.

**Two classifier misses**, both structural: `<data_root>/sketches/<id>.html` is a template, and
`.ts/.tsx` is a pair of extensions, not a directory.

**`DRIFT = 25` was an invented magic number** — the exact thing this exercise exists to prevent, in
my own code. Removed. The quoted text is the claim and the line number is a hint, so the whole file
is searched and the drift is _reported_: "moved to line 3, cited as 1". No tolerance window to
justify.

### Still open, stated rather than guessed at

**The ported predicates have no real-data detection proof.** Run over 743 real VERIFY commands in
the pi-task corpora: zero grep-theater, zero unfailable, zero undecidable. That proves they do not
fire spuriously. It cannot prove detection, because that corpus is exactly the population pi-task's
own gates already policed. Detection rests on the known-answer tests, which reproduce the shapes
pi-task's own comments document as real incidents.

**The four `contains:` assertions are still uncovered.** They are not shell, so neither predicate
reaches them. Calling `contains: "hp"` too weak needs a length threshold, and that is an invented
number.

**Fix 3 has no producer.** The citation checker works and is tested. No plan in any corpus writes
`path:line` citations, so it checks a format nothing emits yet. That is the one-sentence prompt
change, not code.

**Binding confuses sibling repos.** All 6 misses are aiz-client/aiz-server. A plan that touches both
has no single right answer, and nothing distinguishes them.

### The node resolver, validated across three repos

134 real node paths — every scene's own declared children in swarm, spawn and CrypticMansion — all
resolve. The negative cases (wrong root, missing child, missing scene) are in the test suite.

### A fifth defect in the original plan

It wrote "change `_spawn_projectile` (line ~169)". It is at line 221. Fix 3 rejects the citation.
Nobody caught this by reading.

## Design

### Why not parse the verb

The obvious rule — "modify" means it must exist, "add" means it must not — is a regex over English.
Rejected. Two structural substitutes replace it.

**Section membership.** `CONSTRAINTS` is references by definition. That is a header parse, and it
alone catches the `docs/design.md` defect. This is what was measured above.

**Three buckets.** A name is in the repo, or produced by an earlier STEP, or neither. Only the third
bucket is a finding. `hp` is produced by step 1, so it stays silent. `docs/design.md` is produced by
nothing. Step ordering is structural, so the verb is never consulted.

### Guard direction

May cost time, never work. Every inconclusive input steps aside. A glob, an ambiguous token, a repo
that is not a git tree — all yield nothing rather than a guess. This matches the rule
`foreign-path.ts` states for itself in pi-task.

### Findings are advisory

The checker reports. It does not block, rewrite, or edit. A finding names the token, the section,
and the file, and the reader decides.

## Files

All new, self-contained, node builtins only.

```
scripts/plan-check/extract.mjs       sections (ALL-CAPS + Title Case) + tokens
scripts/plan-check/classify.mjs      is a token a file claim
scripts/plan-check/resolve.mjs       exact / disk / suffix / basename tiers
scripts/plan-check/bind.mjs          FIX 2 - infer the repo, or refuse
scripts/plan-check/truth.mjs         binding ground truth from transcripts
scripts/plan-check/citations.mjs     FIX 3 - path:line + quoted text
scripts/plan-check/verify-block.mjs  VERIFY parser: fenced sh + godot_runtime
scripts/plan-check/verify-shell.mjs  FIX 4 - ported pi-task predicates
scripts/plan-check/godot-nodes.mjs   FIX 4 - node path vs the scene being run
scripts/plan-check/index.mjs         the CLI, wiring all four
scripts/plan-check/test.mjs          63 known-answer tests
scripts/plan-check/corpus.mjs        smokes 1 and 3
scripts/plan-check/bind-accuracy.mjs binding accuracy vs ground truth
scripts/plan-check/fixtures/         swarm plan + a stable cited file
```

`fixtures/` is in `.prettierignore`: a fixture is an input under test, and reformatting one changed
what it tested.

## Smoke runs

Three. Each must run before the checker is trusted, and each produces a number, not a pass/fail
feeling.

**1 — False-positive rate on the real corpus.** `corpus.mjs` sweeps every `.pi-tasks/` directory
under `/home/edgars/hub` (382 task files, 105 with CONSTRAINTS) and reports candidates, resolved,
and unresolved per repo. Target: **under 2% unresolved**, down from the measured 3.4%, by excluding
globs. Every surviving finding is listed with its token and file so it can be read.

**2 — Known-answer test against the swarm plan.** The reviewed plan is the one case with
hand-verified ground truth. Feed it against `/home/edgars/hub/swarm`. Must fire on exactly
`docs/design.md`, `docs/spec-unit-combat.md`, `docs/audit-unit-combat.md`. Must **not** fire on
`scripts/units/units.gd`, `scripts/enemy/enemy.gd`, `scripts/ui/unit_placement_panel.gd`,
`scripts/projectiles/spawned_projectile.gd`, `scenes/main.tscn`, or any of the correct symbols. This
is the regression test.

**3 — Regression sweep on the 83 Claude plans.** `/home/edgars/.claude/plans/` holds 83 real plans,
freeform rather than ALL-CAPS sectioned. They are the adversarial input: no `CONSTRAINTS` header to
key on. Two outcomes are acceptable and one is not. Acceptable: the checker finds no section and
reports nothing, or it finds real phantoms. Not acceptable: a burst of findings on a plan whose
paths are all real. Report findings-per-plan as a histogram.

A checker that averages more than ~1 finding per plan is noise and gets tightened before it is wired
anywhere.

## The four fixes

**1 — The path checker.** Built and measured above. `scripts/plan-check/`. Reports every backticked
path in a plan that resolves to nothing in the repo.

**2 — Repo binding.** Not built. The checker needs `--repo` and nothing currently supplies it. This
is the smoke 3 finding: pointed at the wrong repo it produced 33 fake findings on one plan, and 1
real one when pointed correctly. Fix 1 is unsafe to wire anywhere until this lands. A hook passes
the session cwd; a typed command takes the flag.

**3 — The citation rule.** Not built, and not code. A step must cite `path:line` plus the text it
relies on. The check is then a substring test against that file at that line — deterministic, no
English. A step claiming "runs every frame" must quote the guard, and it cannot quote a guard it
never opened.

This is the only lever on the control-flow class. Nothing detects from text that 0.25 > 0.12, or
that `position.x` on a child node is local space.

**4 — Run the VERIFY block.** Not built.

The swarm plan's own VERIFY named `/root/MainWorld/SwarmDirector`. Running it would have errored on
the path immediately. Nobody ran it. Every VERIFY command in that plan was written and none was
executed, which is why a wrong node path and four assertions that cannot fail both shipped in the
same block.

So VERIFY is executed against the repo _before_ the plan is accepted, not after the work. Two
outcomes are findings:

- a command that errors on something structural — a bad path, a missing scene, a tool that is not
  installed
- a command that exits zero for a reason unrelated to the claim

The second is the harder half and is already solved upstream. pi-task's `grep-theater` probe rejects
a VERIFY block that only inspects statically instead of running the artifact, and
`unfailable-command.ts` rejects a command whose exit status is destroyed by its own construction.
Both are pure scanners over the command text. Port the predicate, do not rewrite it.

Ordering note: a VERIFY that legitimately depends on work the plan has not done yet will fail for
the right reason. So a pre-work run classifies, it does not gate — a structural error is a finding,
a missing-feature failure is expected and silent.

## Verification

```sh
node scripts/plan-check/test.mjs           # 63 known-answer tests
node scripts/plan-check/corpus.mjs         # smokes 1 and 3
node scripts/plan-check/bind-accuracy.mjs  # binding vs ground truth
node scripts/plan-check/live-ab.mjs        # live A/B, needs localhost:8080
node scripts/plan-check/index.mjs scripts/plan-check/fixtures/swarm-plan.md --auto
```

The last is the assertion that matters: **4 findings, exactly these four.**

| measure                      | bar                   | actual |
| ---------------------------- | --------------------- | ------ |
| smoke 1 — pi-task corpus     | under 1 finding/plan  | 0.21   |
| smoke 2 — swarm known answer | exactly 4, no others  | 4      |
| smoke 3 — Claude plans       | under 1 finding/plan  | 0.09   |
| binding accuracy             | measured, not assumed | 91.7%  |
| repo gate                    | `npm run check` green | 20/20  |

Every test states what must fire _and_ what must stay silent. The risk this checker carries is
noise, not blindness, and every regression found while building it was noise.
