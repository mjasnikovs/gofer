// Known-answer tests. Every case states what must fire AND what must stay
// silent, because the risk this checker carries is noise, not blindness.

import {isFileClaim} from './classify.mjs'
import {makeIndex, resolveClaim} from './resolve.mjs'
import {sections, tokensIn} from './extract.mjs'
import {bindRepo} from './bind.mjs'
import {findCitations, checkCitation} from './citations.mjs'
import {classifyExitStatus, findGrepOnlyVerify} from './verify-shell.mjs'
import {checkNodePathInScene} from './godot-nodes.mjs'
import {checkPlan} from './index.mjs'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'

let pass = 0
const fails = []
const is = (name, got, want) => {
    const g = JSON.stringify(got)
    const w = JSON.stringify(want)
    if (g === w) pass++
    else fails.push(`${name}\n     got  ${g}\n     want ${w}`)
}

// ─── fix 1: which tokens are file claims ─────────────────────────────────────
// The measured false-positive shapes must all stay silent.
for (const t of ['scripts/units/units.gd', 'package.json', 'src/a/b.ts', 'main.tsx'])
    is(`claim: ${t}`, isFileClaim(t), true)
for (const t of [
    '@hono/zod-validator',
    '@types/bun',
    '/api/auth/me',
    '/me',
    'image/webp',
    '.tsx',
    '../db',
    './setup',
    'c.var.user',
    'Bun.build',
    'src/**/*.ts',
    '*.spec.tsx',
    '0002_….sql',
    'attack_range',
    'set_state'
])
    is(`not a claim: ${t}`, isFileClaim(t), false)

// ─── fix 1: resolution ───────────────────────────────────────────────────────
const swarm = makeIndex('/home/edgars/hub/swarm')
is('exact path resolves', resolveClaim(swarm, 'scripts/units/units.gd'), 'exact')
is('bare basename resolves', resolveClaim(swarm, 'spider.gd'), 'basename')
is('phantom does not resolve', resolveClaim(swarm, 'docs/design.md'), null)

// ─── fix 1: section parsing, both header forms ───────────────────────────────
is('bare ALL-CAPS header', Object.keys(sections('GOAL\na\nCONSTRAINTS\nb')), [
    'GOAL',
    'CONSTRAINTS'
])
is('## header', Object.keys(sections('## GOAL\na\n## VERIFY\nb')), ['GOAL', 'VERIFY'])
is('tokens', tokensIn('use `a.ts` and `b.ts`'), ['a.ts', 'b.ts'])

// ─── fix 2: binding ──────────────────────────────────────────────────────────
const HERE = new URL('.', import.meta.url).pathname
const swarmPlan = readFileSync(HERE + 'fixtures/swarm-plan.md', 'utf8')
is(
    'binds to the right repo',
    bindRepo(swarmPlan, ['/home/edgars/hub/swarm', '/home/edgars/hub/gofer']).repo,
    '/home/edgars/hub/swarm'
)
is(
    'refuses when nothing resolves',
    bindRepo('GOAL\nedit `zz/nope/nothing.ts`', ['/home/edgars/hub/gofer']).repo,
    null
)
is(
    'refuses a plan with no claims',
    bindRepo('GOAL\njust prose', ['/home/edgars/hub/gofer']).repo,
    null
)

// ─── fix 3: citations ────────────────────────────────────────────────────────
is(
    'finds a citation',
    findCitations('see `scripts/units/units.gd:169` — `func _spawn_projectile`').length,
    1
)
is('no citations, no findings', findCitations('no citation here at all').length, 0)
// Against a fixture, not another repo's working tree: swarm's files moved
// under this suite mid-session, which is exactly the drift a citation guards.
const cite = (line, quote) => checkCitation(HERE, {path: 'fixtures/cited.txt', line, quote})
is('exact citation passes', cite(3, 'func _spawn_projectile').ok, true)
is('drifted citation passes', cite(5, 'func _spawn_projectile').ok, true)
is('wrong quote fires', cite(3, 'func nothing_like_this').ok, false)
is('missing file fires', checkCitation(HERE, {path: 'no/such.gd', line: 1, quote: 'x'}).ok, false)

// ─── fix 4: exit status, the three documented shapes ─────────────────────────
is(
    'rule C echo chain',
    classifyExitStatus('test -f "$X" && echo PASS || echo FAIL').cls,
    'unfailable'
)
is('rule A console.assert', classifyExitStatus('bun -e "console.assert(1===2)"').cls, 'unfailable')
is(
    'rule B $? after pipe',
    classifyExitStatus('tsc --noEmit | tail -5; test $? -eq 0 && echo ok').cls,
    'unfailable'
)
is(
    'console.assert with exit path is fine',
    classifyExitStatus('bun -e "console.assert(x); process.exit(1)"').cls,
    'can-fail'
)
is('plain grep can fail', classifyExitStatus('grep -q foo bar.ts').cls, 'can-fail')
is('|| true stays out of scope', classifyExitStatus('rm -rf build || true').cls, 'can-fail')
is('set -e is undecidable', classifyExitStatus('set -e; grep x y').cls, 'unknown')

// ─── fix 4: grep theater ─────────────────────────────────────────────────────
is(
    'all-static block on a runnable file fires',
    findGrepOnlyVerify(['grep -q build build.ts', 'cat build.ts']).map(f => f.target),
    ['build.ts']
)
is(
    'one real execution silences the block',
    findGrepOnlyVerify(['grep -q build build.ts', 'bun build.ts']),
    []
)
is('inspecting a non-runnable file is not theater', findGrepOnlyVerify(['grep -q x README.md']), [])

// ─── fix 4: node paths, scene-relative ───────────────────────────────────────
const np = (scene, p) => checkNodePathInScene('/home/edgars/hub/swarm', scene, p)
is('wrong root fires', np('scenes/main.tscn', '/root/MainWorld/SwarmDirector').ok, false)
is('right scene resolves', np('scenes/main_world.tscn', '/root/MainWorld/SwarmDirector').ok, true)
is('real child resolves', np('scenes/main.tscn', '/root/Main/CanvasLayer').ok, true)
is('missing child fires', np('scenes/main.tscn', '/root/Main/Nope').ok, false)
is('missing scene is undecided', np('scenes/nope.tscn', '/root/X').ok, null)

// ─── the shapes found by hand-reading smoke 3's findings ─────────────────────
is('template placeholder is not a claim', isFileClaim('<data_root>/sketches/<id>.html'), false)
is('extension pair is not a claim', isFileClaim('.ts/.tsx'), false)

// A path written relative to a source root - the single largest cause of
// "unresolved" before it was handled.
const pitask = makeIndex('/home/edgars/.pi/agent/extensions/pi-task')
is('suffix resolves', resolveClaim(pitask, 'task/loop-detector.ts'), 'suffix')
is('suffix needs a segment boundary', resolveClaim(pitask, 'sk/loop-detector.ts'), 'basename')
is('suffix needs a directory', resolveClaim(pitask, 'loop-detector.ts'), 'basename')

// A file that lives in a sibling repo is a cross-repo reference, not a phantom.
const neighbours = ['/home/edgars/hub/swarm', '/home/edgars/.pi/agent/extensions/pi-task']
const cross = checkPlan(
    'CONSTRAINTS\n- see `src/task/loop-detector.ts`',
    '/home/edgars/hub/swarm',
    neighbours
)
is(
    'cross-repo is its own kind',
    cross.findings.map(f => f.kind),
    ['cross-repo-path']
)
const phantom = checkPlan(
    'CONSTRAINTS\n- see `zz/nowhere/at-all.ts`',
    '/home/edgars/hub/swarm',
    neighbours
)
is(
    'a real phantom stays a phantom',
    phantom.findings.map(f => f.kind),
    ['unresolved-path']
)

// ─── citations report drift, they do not tolerate a fixed window ─────────────
is(
    'a moved quote passes and says where',
    cite(1, 'func _spawn_projectile').why,
    'moved to line 3, cited as 1'
)

// ─── node resolver: every scene's own children, three real Godot repos ───────
for (const repo of [
    '/home/edgars/hub/swarm',
    '/home/edgars/hub/spawn',
    '/home/edgars/hub/CrypticMansion'
]) {
    const scenes = execFileSync(
        'bash',
        ['-c', `cd ${repo} && find . -name '*.tscn' -not -path './.*' | sed 's|^./||'`],
        {encoding: 'utf8'}
    )
        .split('\n')
        .filter(Boolean)
    let bad = 0
    for (const sc of scenes) {
        const text = readFileSync(`${repo}/${sc}`, 'utf8')
        const root = text.match(/^\[node name="([^"]+)"[^\]]*\]/m)?.[1]
        if (!root) continue
        for (const m of text.matchAll(/^\[node name="([^"]+)"[^\]]*parent="\."/gm)) {
            if (checkNodePathInScene(repo, sc, `/root/${root}/${m[1]}`).ok !== true) bad++
        }
    }
    is(`every declared child resolves in ${repo.split('/').pop()}`, bad, 0)
}

// ─── live model output: the only real-data detection evidence ───────────────
// Qwen3-27B, asked for a plan with no file inventory, wrote seven VERIFY lines
// of the exact `grep -q X && echo OK || echo FAIL` shape pi-task documents. That
// is detection on text no human wrote for this suite.
const liveA = readFileSync(HERE + 'fixtures/live/qwen3-27b-no-inventory.md', 'utf8')
const liveB = readFileSync(HERE + 'fixtures/live/qwen3-27b-with-inventory.md', 'utf8')
const rA = checkPlan(liveA, '/home/edgars/hub/swarm', neighbours)
const rB = checkPlan(liveB, '/home/edgars/hub/swarm', neighbours)
is(
    'live: unfailable commands detected',
    rA.findings.filter(f => f.kind === 'unfailable-command').length,
    7
)
is('live: invented paths detected', rA.findings.filter(f => f.kind === 'unresolved-path').length, 2)
is('live: same task with an inventory is clean', rB.findings.length, 0)

// ─── regression: the whole swarm plan ────────────────────────────────────────
const r = checkPlan(swarmPlan, '/home/edgars/hub/swarm')
is('swarm plan finding count', r.findings.length, 4)
is('swarm plan findings', r.findings.map(f => f.what).sort(), [
    '/root/MainWorld/SwarmDirector',
    'docs/audit-unit-combat.md',
    'docs/design.md',
    'docs/spec-unit-combat.md'
])

// A plan naming only real things must be silent.
is(
    'clean plan is silent',
    checkPlan(
        'GOAL\nEdit `scripts/units/units.gd` and `scenes/main.tscn`.\nCONSTRAINTS\n- Do not modify `project.godot`',
        '/home/edgars/hub/swarm'
    ).findings.length,
    0
)

console.log(`\n${pass} passed, ${fails.length} failed`)
for (const f of fails) console.log(`  FAIL ${f}`)
process.exit(fails.length ? 1 : 0)
