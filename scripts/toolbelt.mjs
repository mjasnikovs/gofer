import {
    createBashTool,
    createEditTool,
    createReadTool,
    createWriteTool
} from '@earendil-works/pi-agent-core/node'
import {createToolEnv, decorateTools, realTimers} from './agent-runtime.mjs'
import {ASK_USER_TOOL_NAME} from './ai-ask.mjs'
import {createGrepTool} from './ai-grep.mjs'
import {notesTheRead} from './noted-read.mjs'
import {withLineNumbers} from './numbered-read.mjs'
import {createProgressGuard} from './progress-guard.mjs'
import {readsADirectory} from './read-a-directory.mjs'
import {withoutPackedLiterals} from './scene-text.mjs'
import {forwardsScriptsToTheServer} from './script-forwarding.mjs'
import {confineTool} from './workspace-confinement.mjs'

/// Everything that differs between the agent the user talks to and a child it delegates to.
export const SEATS = {
    parent: {notesReads: true, clocksCommands: false},
    child: {
        // Noting its read would arm a save over a file the parent's model never saw.
        notesReads: false,
        // Only a child has a ceiling to keep: the sub-agent's commandTimeoutMinutes setting.
        clocksCommands: true
    }
}

const FILE_TOOLS = {
    read: () => readsADirectory(withoutPackedLiterals(withLineNumbers(createReadTool()))),
    grep: createGrepTool,
    write: createWriteTool,
    edit: createEditTool,
    bash: createBashTool
}

export const isFileTool = name => Object.hasOwn(FILE_TOOLS, name)

/**
 * The tools one seat holds, under the one decorator stack every seat shares.
 *
 * `files` are built here and confined to the workspace and away from `frozen`; `reaching` tools
 * were built by the caller and are only decorated. Whatever else a seat changes is a row of SEATS.
 */
export function createToolbelt({
    seat,
    workspacePath,
    files = [],
    reaching = [],
    frozen = [],
    host,
    model,
    commandTimeoutMs = 0,
    timers = realTimers
}) {
    const policy = SEATS[seat]
    if (!policy)
        throw new Error(`A toolbelt is built for the parent or a child, not for '${seat}'.`)
    const env = createToolEnv(workspacePath)
    const guard = createProgressGuard()
    const confined = files.map(name => {
        const tool = forwardsScriptsToTheServer(
            confineTool(FILE_TOOLS[name](), workspacePath, frozen),
            host
        )
        return name === 'read' && policy.notesReads ? notesTheRead(tool, host, workspacePath) : tool
    })
    const clock = tool => underCommandClock(tool, {timeoutMs: commandTimeoutMs, timers})
    return {
        env,
        guard,
        tools: decorateTools({
            env,
            tools: [...confined, ...reaching],
            model,
            guard: guard.decorate,
            extras: policy.clocksCommands ? [clock] : []
        })
    }
}

function commandOverrunMessage(toolName, timeoutMs) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000))
    return (
        `The ${toolName} call was stopped after ${String(seconds)} seconds and produced no result. `
        + `Do not report it as finished, and do not assume anything it would have started is now `
        + `running. If it genuinely needs that long, run it again with the bash tool's own timeout `
        + `parameter set, in seconds, so it cannot hang. Otherwise break it into smaller steps or `
        + `answer from what you already have. Do not repeat the same unbounded command.`
    )
}

const WAITS_ON_A_PERSON = new Set([ASK_USER_TOOL_NAME])

function underCommandClock(tool, {timeoutMs, timers}) {
    if (!(timeoutMs > 0) || WAITS_ON_A_PERSON.has(tool.name)) return tool
    return {
        ...tool,
        execute: async (id, params, signal, onUpdate) => {
            const controller = new AbortController()
            const stop = () => controller.abort()
            if (signal?.aborted) stop()
            else signal?.addEventListener('abort', stop, {once: true})
            let timer
            let overran = false
            try {
                const result = await Promise.race([
                    tool.execute(id, params, controller.signal, onUpdate),
                    new Promise(resolve => {
                        timer = timers.schedule(() => {
                            overran = true
                            controller.abort()
                            resolve(undefined)
                        }, timeoutMs)
                    })
                ])
                if (overran) throw new Error(commandOverrunMessage(tool.name, timeoutMs))
                return result
            } catch (error) {
                if (overran) throw new Error(commandOverrunMessage(tool.name, timeoutMs))
                throw error
            } finally {
                timers.cancel(timer)
                signal?.removeEventListener('abort', stop)
            }
        }
    }
}
