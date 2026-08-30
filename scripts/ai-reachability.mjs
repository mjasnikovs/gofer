import {rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {SUBAGENT_PROBE_ANSWER, SUBAGENT_TOOL_NAME} from './ai-subagent.mjs'
import {ASK_PROBE_ANSWER, ASK_USER_TOOL_NAME} from './ai-ask.mjs'
import {WEB_FETCH_PROBE_ANSWER, WEB_FETCH_TOOL_NAME} from './ai-fetch.mjs'
import {WEB_SEARCH_PROBE_ANSWER, WEB_SEARCH_TOOL_NAME} from './ai-search.mjs'

export const PROBE_REQUEST = {probe: true}

const PROBE_FILE = '.gofer-tool-probe'
const PROBE_WRITTEN = 'gofer'
const PROBE_EDITED = 'reachable'
const PROBE_TIMEOUT_MS = 15_000

const WORKSPACE_PROBES = [
    {name: 'write', params: {path: PROBE_FILE, content: PROBE_WRITTEN}},
    {
        name: 'edit',
        params: {path: PROBE_FILE, edits: [{oldText: PROBE_WRITTEN, newText: PROBE_EDITED}]}
    },
    {name: 'read', params: {path: PROBE_FILE}, answersWith: PROBE_EDITED},
    {name: 'bash', params: {command: `cat ${PROBE_FILE}`}, answersWith: PROBE_EDITED}
]

const SUBAGENT_PROBE = {
    name: SUBAGENT_TOOL_NAME,
    params: PROBE_REQUEST,
    answersWith: SUBAGENT_PROBE_ANSWER
}

const ASK_PROBE = {
    name: ASK_USER_TOOL_NAME,
    params: PROBE_REQUEST,
    answersWith: ASK_PROBE_ANSWER
}

const WEB_PROBES = [
    {name: WEB_SEARCH_TOOL_NAME, params: PROBE_REQUEST, answersWith: WEB_SEARCH_PROBE_ANSWER},
    {name: WEB_FETCH_TOOL_NAME, params: PROBE_REQUEST, answersWith: WEB_FETCH_PROBE_ANSWER}
]

const LOCAL_PROBES = [...WORKSPACE_PROBES, SUBAGENT_PROBE, ASK_PROBE, ...WEB_PROBES]

function resultText(result) {
    return (result?.content ?? [])
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
}

function reason(error) {
    return error instanceof Error ? error.message : String(error)
}

async function withDeadline(run, signal, timeoutMs) {
    let timer
    let stopped
    try {
        return await Promise.race([
            run(),
            new Promise((_, reject) => {
                if (signal?.aborted) return reject(new Error('the turn was stopped'))
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                `it did not answer within ${String(timeoutMs / 1000)} seconds`
                            )
                        ),
                    timeoutMs
                )
                stopped = () => reject(new Error('the turn was stopped'))
                signal?.addEventListener('abort', stopped, {once: true})
            })
        ])
    } finally {
        clearTimeout(timer)
        if (stopped) signal?.removeEventListener('abort', stopped)
    }
}

async function probeLocalTool(tool, probe, signal, timeoutMs) {
    const result = await withDeadline(
        () => tool.execute('reachability-probe', probe.params, signal),
        signal,
        timeoutMs
    )
    const text = resultText(result)
    if (result?.isError) throw new Error(`it refused its own probe: ${text}`)
    if (probe.answersWith && !text.includes(probe.answersWith)) {
        throw new Error(
            `it answered without the text the probe wrote: expected ${probe.answersWith}, `
                + `got ${text.trim() || '<nothing>'}`
        )
    }
}

async function seedProbeFile(tools, workspacePath) {
    const held = new Set(tools.map(tool => tool.name))
    if (held.has('write')) return
    if (!held.has('read') && !held.has('bash')) return
    await writeFile(join(workspacePath, PROBE_FILE), PROBE_EDITED).catch(() => undefined)
}

export async function probeTools({
    tools,
    host,
    workspacePath,
    signal,
    timeoutMs = PROBE_TIMEOUT_MS
}) {
    const local = new Map(LOCAL_PROBES.map(probe => [probe.name, probe]))
    const failures = []
    await seedProbeFile(tools, workspacePath)

    for (const probe of LOCAL_PROBES) {
        const tool = tools.find(candidate => candidate.name === probe.name)
        if (!tool) continue
        try {
            await probeLocalTool(tool, probe, signal, timeoutMs)
        } catch (error) {
            failures.push({name: probe.name, reason: reason(error)})
        }
    }
    await rm(join(workspacePath, PROBE_FILE), {force: true}).catch(() => undefined)

    const remote = tools.filter(tool => !local.has(tool.name))
    const answers = await Promise.all(
        remote.map(async tool => {
            if (!host) return {name: tool.name, reason: 'there is no channel to answer it'}
            try {
                await withDeadline(
                    () => host.call(tool.name, PROBE_REQUEST, signal),
                    signal,
                    timeoutMs
                )
                return undefined
            } catch (error) {
                return {name: tool.name, reason: reason(error)}
            }
        })
    )
    failures.push(...answers.filter(Boolean))

    if (failures.length === 0) return
    throw new Error(
        `The turn was not started, because the model would have been told about ${
            failures.length === 1 ? 'a tool it cannot use' : 'tools it cannot use'
        }:\n${failures.map(failure => `- ${failure.name}: ${failure.reason}`).join('\n')}`
    )
}
