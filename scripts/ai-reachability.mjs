/**
 * Proves every tool the model is about to be told about can actually answer.
 *
 * A tool the model cannot reach does not look like a failure from the outside. It looks like a
 * model that never chose to use it: the tool is listed in the request, the model calls it or does
 * not, and nothing anywhere says the call site is dead. Ten live sweeps ended with zero
 * documentation searches and no error to show for it.
 *
 * So every declared tool is invoked once before the turn starts, in a mode that changes nothing,
 * and a tool that cannot answer stops the turn by name instead of being advertised to the model.
 * There is no allow-list of tools that may skip this: a tool with no probe of its own is probed
 * through the backend, which answers `unknown_tool` for a name it does not route.
 *
 * That last sentence is also why this file has to know about every tool that is *not* routed through
 * the backend. A Node-side tool sent to the backend is asked for by a name `ai_tools.rs` has never
 * heard of, and the honest answer it gets back — there is no such tool — refuses the turn. So the
 * split below is the whole policy: a name in `LOCAL_PROBES` is proven here, and everything else is
 * proven through `host.call`. Adding a tool in Node without adding it there does not degrade the
 * turn, it stops it.
 */

import {rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {SUBAGENT_PROBE_ANSWER, SUBAGENT_TOOL_NAME} from './ai-subagent.mjs'
import {DESIGN_PROBE_ANSWER, DESIGN_TOOL_NAME} from './ai-design.mjs'
import {WEB_FETCH_PROBE_ANSWER, WEB_FETCH_TOOL_NAME} from './ai-fetch.mjs'
import {WEB_SEARCH_PROBE_ANSWER, WEB_SEARCH_TOOL_NAME} from './ai-search.mjs'

/**
 * Marks a tool request as a reachability probe rather than an operation. The same constant is
 * `PROBE_KEY` in `src-tauri/src/ai_tools.rs`, which answers it before it reads an operation.
 */
export const PROBE_REQUEST = {probe: true}

/** The file the workspace tools are proven against. Written, edited, read back, then removed. */
const PROBE_FILE = '.gofer-tool-probe'
const PROBE_WRITTEN = 'gofer'
const PROBE_EDITED = 'reachable'
const PROBE_TIMEOUT_MS = 15_000

/**
 * The workspace tools, and what each is asked to do to the probe file.
 *
 * They share one file and run in this order on purpose: the write puts a known word in it, the
 * edit replaces that word, and the read and the shell each have to come back with the replacement.
 * A tool that answered without doing its work is caught by the tool after it, so the pass proves
 * the workspace itself — that it exists, that it can be written, that the shell starts in it —
 * rather than proving that four functions exist.
 */
const WORKSPACE_PROBES = [
    {name: 'write', params: {path: PROBE_FILE, content: PROBE_WRITTEN}},
    {
        name: 'edit',
        params: {path: PROBE_FILE, edits: [{oldText: PROBE_WRITTEN, newText: PROBE_EDITED}]}
    },
    {name: 'read', params: {path: PROBE_FILE}, answersWith: PROBE_EDITED},
    {name: 'bash', params: {command: `cat ${PROBE_FILE}`}, answersWith: PROBE_EDITED}
]

/**
 * The sub-agent, which is a whole second agent rather than a call to something already running.
 *
 * "Reachable" means more for this one than for the four above, because there is more that can be
 * absent: a provider that cannot be reused, a child tool list that no longer builds or that
 * `assertChildTools` refuses, an `Agent` that cannot be constructed against this model, a loop that
 * ends with nothing to return. All of that is proven by asking it a question and requiring the
 * answer back — the probe request runs the real child against a canned provider, so every step but
 * the network is the step the model's own call will take. See `cannedModels` for why the model call
 * is the one thing left out.
 */
const SUBAGENT_PROBE = {
    name: SUBAGENT_TOOL_NAME,
    params: PROBE_REQUEST,
    answersWith: SUBAGENT_PROBE_ANSWER
}

/**
 * The design loop, proven the same way and for a sharper reason.
 *
 * It is the only child that may reach the user, and the ration that lets it is refused at build time
 * rather than at the call. Proving it here means a machine set never to be interrupted, or a build
 * where the ration was dropped, says so before the turn starts — instead of the model discovering it
 * halfway through a design the user was waiting on. The canned provider answers immediately, so no
 * dialog is ever opened by a probe.
 */
const DESIGN_PROBE = {
    name: DESIGN_TOOL_NAME,
    params: PROBE_REQUEST,
    answersWith: DESIGN_PROBE_ANSWER
}

/**
 * The two tools that reach outside the machine, and the one thing their probes deliberately do not
 * prove.
 *
 * Every other tool here is reachable or not for reasons this process can settle: a file is writable,
 * an `Agent` builds, the backend routes a name. These two also depend on the network, and that is
 * the first thing in the catalogue that can be legitimately absent — a laptop on a train has no
 * connection, and no probe can conjure one.
 *
 * So the probes are answered offline, and they answer a narrower question on purpose: can the tool
 * be built, and does it return an answer through its own code. A probe that made a real request
 * would leak one request per turn, spend a search quota on a tool the user may never call, and
 * refuse the whole turn for a connection that has nothing to do with the work being done. A
 * connection that is down is reported by the call that needs it, after it has been retried — which
 * is where the user can see it and do something about it.
 */
const WEB_PROBES = [
    {name: WEB_SEARCH_TOOL_NAME, params: PROBE_REQUEST, answersWith: WEB_SEARCH_PROBE_ANSWER},
    {name: WEB_FETCH_TOOL_NAME, params: PROBE_REQUEST, answersWith: WEB_FETCH_PROBE_ANSWER}
]

/** Every tool proven in this process. Everything not named here is proven through the backend. */
const LOCAL_PROBES = [...WORKSPACE_PROBES, SUBAGENT_PROBE, DESIGN_PROBE, ...WEB_PROBES]

function resultText(result) {
    return (result?.content ?? [])
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
}

function reason(error) {
    return error instanceof Error ? error.message : String(error)
}

/**
 * Runs one probe under a deadline.
 *
 * A tool that never answers is as unusable as one that fails, and it is worse to wait for: without
 * this the turn would hang before it started, with nothing on screen to say what it was waiting on.
 */
async function withDeadline(run, signal, timeoutMs) {
    let timer
    // Taken off in the same `finally` as the timer, and for the same reason: the signal outlives the
    // probe by the whole turn, and every probe adds one of these to it.
    let stopped
    try {
        return await Promise.race([
            run(),
            new Promise((_, reject) => {
                // Asked before the listener is added: a signal that aborted before the probes
                // started never fires again, and the probe would wait out the whole deadline.
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

/**
 * Puts the probe file there when the caller holds no tool that could write it.
 *
 * The four workspace probes are one probe in four steps and each proves the one before it, so the
 * chain has a beginning: `write` creates the file the other three work on. A caller that holds only
 * some of them has no beginning — a research worker gets `read` and `bash` and nothing else, and
 * both correctly failed on a file that was never going to exist.
 *
 * So the *setup* is done here rather than by a tool, and only the setup. `read` and `bash` are still
 * held to coming back with the word this wrote, which is the whole of what their probe ever
 * asserted: that the workspace is there, that it can be read, and that the shell starts inside it.
 * Nothing is seeded when `write` is present — that chain proves more, and it still runs.
 */
async function seedProbeFile(tools, workspacePath) {
    const held = new Set(tools.map(tool => tool.name))
    if (held.has('write')) return
    if (!held.has('read') && !held.has('bash')) return
    await writeFile(join(workspacePath, PROBE_FILE), PROBE_EDITED).catch(() => undefined)
}

/**
 * Invokes every declared tool once and throws unless all of them answered.
 *
 * The failure names every tool that could not answer and why, because a turn refused for one dead
 * tool and a turn refused for all of them are different problems.
 */
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

    // In order, and before the rest: the four workspace probes are one probe in four steps, and the
    // sub-agent is worth answering for last because it is the only one that builds anything.
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
