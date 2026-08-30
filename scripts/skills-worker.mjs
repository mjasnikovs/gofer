import readline from 'node:readline'
import {explainDiagnostic, importSkillFile, listProjectSkills} from './skills.mjs'
import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node'

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
requests.close()
process.stdin.pause()
if (first.done) throw new Error('The skills worker received no request')

try {
    process.stdout.write(`${JSON.stringify(await answer(JSON.parse(first.value)))}\n`)
} catch (error) {
    process.stdout.write(
        `${JSON.stringify({type: 'failed', message: error instanceof Error ? error.message : String(error)})}\n`
    )
    process.exitCode = 1
}
