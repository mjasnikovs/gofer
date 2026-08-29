/**
 * The Skills tab's half of the loader: one request in, one answer out.
 *
 * The tab has to show what the agent will see — the same names, the same descriptions, and the
 * same warnings about a file that will not load. That knowledge is pi's, in Node, and the tab
 * talks to Rust. So Rust asks here rather than parsing frontmatter a second time in a second
 * language, which is how a tab and a turn end up disagreeing about a file neither of them wrote.
 *
 * `scripts/skills.mjs` is the whole of the work. This file is the wire around it.
 */
import readline from 'node:readline'
import {explainDiagnostic, importSkillFile, listProjectSkills} from './skills.mjs'
import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node'

/** What a probe is answered with, so a bundle that lost the loader fails at build rather than in use. */
export const PROBE_ANSWER = 'skills-worker-reachable'

async function answer(request) {
    if (request.probe === true) return {type: 'probe', answer: PROBE_ANSWER}
    const workspacePath = String(request.workspacePath ?? '')
    if (!workspacePath) throw new Error('The skills worker was given no workspace')
    const env = new NodeExecutionEnv({cwd: workspacePath})
    if (request.operation === 'list') {
        const {skills, diagnostics} = await listProjectSkills(env, workspacePath)
        return {
            type: 'list',
            // Only what the tab draws. The body is read through Rust, on the row the user opened,
            // because a project with thirty skills would otherwise send all thirty to draw a list.
            skills: skills.map(skill => ({
                name: skill.name,
                description: skill.description,
                path: skill.filePath,
                hidden: skill.disableModelInvocation === true
            })),
            warnings: diagnostics.map(explainDiagnostic).map(one => ({
                code: one.code,
                message: one.message,
                path: one.path
            }))
        }
    }
    if (request.operation === 'import') {
        return {
            type: 'imported',
            name: await importSkillFile(env, workspacePath, String(request.sourcePath ?? ''))
        }
    }
    throw new Error(`Unknown skills operation: ${String(request.operation)}`)
}

const requests = readline.createInterface({input: process.stdin, crlfDelay: Infinity})
const first = await requests[Symbol.asyncIterator]().next()
// Closed rather than left open: without `process.exit` below, a still-reading stdin is a process
// that never ends on its own.
requests.close()
process.stdin.pause()
if (first.done) throw new Error('The skills worker received no request')

// `process.exitCode` rather than `process.exit`, which does not flush. Rust reads this over a
// pipe, and stdout to a pipe is asynchronous in Node — an answer larger than the pipe buffer is
// cut off mid-line, and Rust reports a worker that answered something unreadable.
try {
    process.stdout.write(`${JSON.stringify(await answer(JSON.parse(first.value)))}\n`)
} catch (error) {
    process.stdout.write(
        `${JSON.stringify({type: 'failed', message: error instanceof Error ? error.message : String(error)})}\n`
    )
    process.exitCode = 1
}
