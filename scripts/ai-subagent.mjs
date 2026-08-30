import {Agent, createBashTool, createReadTool} from '@earendil-works/pi-agent-core/node'
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai'
import {createGodotTools} from './godot-tools.mjs'
import {
    abortableWait,
    createToolEnv,
    decorateTools,
    isWorthRetrying,
    modelReadsImages,
    realTimers,
    textContent,
    zeroUsage
} from './agent-runtime.mjs'
import {createWebSearchTool} from './ai-search.mjs'
import {ASK_USER_TOOL_NAME, createAskUserTool} from './ai-ask.mjs'
import {toolStepLine} from './tool-target.mjs'
import {confineTool} from './workspace-confinement.mjs'

export const SUBAGENT_TOOL_NAME = 'subagent'

export const CHILD_TOOL_NAMES = ['read', 'bash', 'godot_docs_search', 'web_search', 'ask_user']

export const SUBAGENT_TOOL_NAMES = ['read', 'bash']

export const DESIGN_TOOL_NAMES = ['read', 'bash', 'ask_user']

export const SUBAGENT_SETTINGS_DEFAULTS = {
    commandTimeoutMinutes: 5,
    streamInactivityMinutes: 10,
    maxTurns: 24,
    maxAnswerChars: 12_000,
    retryAttempts: 2,
    retryBaseDelaySeconds: 1
}

export function boundsFrom(settings) {
    const chosen = settings ?? {}
    const pick = name =>
        typeof chosen[name] === 'number' ? chosen[name] : SUBAGENT_SETTINGS_DEFAULTS[name]
    return {
        commandTimeoutMs: pick('commandTimeoutMinutes') * 60_000,
        streamInactivityMs: pick('streamInactivityMinutes') * 60_000,
        maxTurns: pick('maxTurns'),
        maxAnswerChars: pick('maxAnswerChars'),
        retryAttempts: pick('retryAttempts'),
        retryBaseDelayMs: pick('retryBaseDelaySeconds') * 1_000
    }
}

export const SUBAGENT_BOUNDS = boundsFrom(undefined)

function pollIntervalMs(timeoutMs) {
    return Math.max(20, Math.min(Math.floor(timeoutMs / 4), 30_000))
}

const MAX_REPORTED_STEPS = 12

const CHILD_SYSTEM_PROMPT =
    'You are a research sub-agent. You have been given one question by another agent that is '
    + 'working in this same checkout, and it will see nothing you read — only what you write in '
    + 'your final message.\n'
    + '\n'
    + 'You can read files and run shell commands. You cannot change anything: you have no write '
    + 'tool, no edit tool, and no access to the Godot editor. Do not try to acquire them, and do '
    + 'not use the shell to modify, move or delete anything.\n'
    + '\n'
    + 'Work as briefly as the question allows, then answer it. Your answer must stand on its own: '
    + 'state the conclusion, name the files and line numbers it rests on, and quote only the few '
    + 'lines that actually decide it. Do not paste whole files, whole command output, or a summary '
    + 'of what you did — the agent that asked wants the finding, not the search. If the answer is '
    + 'not in this checkout, say so plainly instead of guessing.'

const SUBAGENT_DESCRIPTION =
    'Delegate a bounded question to an isolated read-only agent and get back only its conclusion. '
    + 'USE THIS FIRST, instead of running your own bash grep, find, ls or cat, whenever a question '
    + 'spans more than one file or means searching for code you have not already located. The '
    + 'material it reads never enters this conversation: doing the search yourself fills your '
    + 'context with raw output you will carry for the rest of the turn, where the sub-agent hands '
    + 'back a paragraph and drops the rest.\n'
    + '\n'
    + 'Use it when:\n'
    + '- a file is long and you need one thing out of it\n'
    + '- the question spans several files, or you do not yet know which file\n'
    + '- you need to trace where something is configured, registered or called from\n'
    + '- a build, a test run or a log produced more output than you need to keep\n'
    + '\n'
    + 'Do not reach for it when:\n'
    + '- you already know the file and want its contents — call read\n'
    + '- anything has to change — the sub-agent cannot write, edit, or drive the editor\n'
    + '- the question is about the running editor or the scene tree — use the godot_ tools\n'
    + '\n'
    + 'Ask one self-contained question per call. The sub-agent shares your checkout but none of '
    + 'your conversation, so name the files, symbols and terms it should start from. Several '
    + 'independent questions can be dispatched in one turn.'

export function subagentFailure(reason) {
    return (
        `The sub-agent did not answer: ${reason}. Nothing it read reached this conversation, so `
        + `treat the question as unanswered — ask again with a narrower, more specific question, or `
        + `do the reading yourself with read and bash.`
    )
}

function addUsage(total, usage) {
    if (!usage) return total
    return {
        input: total.input + (usage.input ?? 0),
        output: total.output + (usage.output ?? 0),
        cacheRead: total.cacheRead + (usage.cacheRead ?? 0),
        cacheWrite: total.cacheWrite + (usage.cacheWrite ?? 0),
        totalTokens: total.totalTokens + (usage.totalTokens ?? 0),
        cost: {
            input: total.cost.input + (usage.cost?.input ?? 0),
            output: total.cost.output + (usage.cost?.output ?? 0),
            cacheRead: total.cost.cacheRead + (usage.cost?.cacheRead ?? 0),
            cacheWrite: total.cost.cacheWrite + (usage.cost?.cacheWrite ?? 0),
            total: total.cost.total + (usage.cost?.total ?? 0)
        }
    }
}

export function assertChildTools(tools, allowed = CHILD_TOOL_NAMES) {
    const invented = allowed.filter(name => !CHILD_TOOL_NAMES.includes(name))
    if (invented.length > 0) {
        throw new Error(
            `A child was asked for ${invented.join(', ')}, which is not a tool a child may hold. `
                + `Widening a child's reach means editing CHILD_TOOL_NAMES on purpose.`
        )
    }
    const unexpected = tools.map(tool => tool.name).filter(name => !allowed.includes(name))
    if (unexpected.length === 0) return
    throw new Error(
        `The sub-agent was built with ${unexpected.length === 1 ? 'a tool' : 'tools'} it must not `
            + `have: ${unexpected.join(', ')}. This child may hold `
            + `${allowed.length === 0 ? 'no tools at all' : allowed.join(' and ')} `
            + `and nothing else — it must not write, must not reach the editor, and must not `
            + `delegate again.`
    )
}

export function commandOverrunMessage(toolName, timeoutMs) {
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

const CONFINED_CHILD_TOOLS = {read: createReadTool, bash: createBashTool}

const REACHING_CHILD_TOOLS = {
    godot_docs_search: ({domains, host}) => {
        if (!host || !Array.isArray(domains)) {
            throw new Error(
                'A child was asked for godot_docs_search without the tool host that answers it. '
                    + 'Pass `host` and `domains` to createChildTools.'
            )
        }
        const docs = domains.filter(domain => domain.name === 'godot_docs_search')
        if (docs.length === 0) {
            throw new Error(
                'A child was asked for godot_docs_search, but the backend did not offer that '
                    + 'domain for this turn.'
            )
        }
        return createGodotTools(docs, host)[0]
    },
    web_search: ({searchProvider = 'exa', braveApiKey}) =>
        createWebSearchTool({provider: searchProvider, apiKey: braveApiKey}),
    ask_user: ({host, ownerCallId, agreed}) => {
        if (!host) {
            throw new Error(
                'A child was asked for ask_user without the tool host that answers it. '
                    + 'Pass `host` to createChildTools.'
            )
        }
        if (typeof ownerCallId !== 'string' || ownerCallId === '') {
            throw new Error(
                'A child was asked for ask_user without the call it is asking on behalf of. That '
                    + 'identifier is the only link between a tool call and the questions it '
                    + 'produces: without it every round of one design lands in the feed as an '
                    + 'unrelated question. Pass `ownerCallId` to createChildTools.'
            )
        }
        return createAskUserTool({host, ownerCallId, agreed})
    }
}

export function createChildTools(
    workspacePath,
    {bounds = SUBAGENT_BOUNDS, timers = realTimers, toolNames = SUBAGENT_TOOL_NAMES, deps = {}} = {}
) {
    assertChildTools([], toolNames)
    const env = createToolEnv(workspacePath)
    const built = toolNames.map(name =>
        name in CONFINED_CHILD_TOOLS ?
            confineTool(CONFINED_CHILD_TOOLS[name](), workspacePath)
        :   REACHING_CHILD_TOOLS[name](deps)
    )
    const tools = decorateTools({
        env,
        tools: built,
        model: deps.model,
        extras: [tool => underCommandClock(tool, {timeoutMs: bounds.commandTimeoutMs, timers})]
    })
    assertChildTools(tools, toolNames)
    return {env, tools}
}

export {realTimers}

export function createSilenceClock({timeoutMs, timers, onSilent}) {
    const running = new Set()
    let last = timers.now()
    let handle
    let fired = false
    const paused = () => running.size > 0
    return {
        start() {
            if (!(timeoutMs > 0) || handle !== undefined) return
            last = timers.now()
            handle = timers.repeat(() => {
                if (fired || paused()) return
                if (timers.now() - last < timeoutMs) return
                fired = true
                this.stop()
                onSilent(timeoutMs)
            }, pollIntervalMs(timeoutMs))
        },
        note() {
            last = timers.now()
        },
        suspend(id) {
            running.add(id)
        },
        resume(id) {
            running.delete(id)
            if (!paused()) last = timers.now()
        },
        stop() {
            if (handle !== undefined) timers.stopRepeat(handle)
            handle = undefined
        }
    }
}

export function streamStallMessage(timeoutMs) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000))
    return (
        `Connection lost: the model sent nothing for ${String(seconds)} seconds and reported no `
        + `error. The request was aborted by Gofer, not by the provider.`
    )
}

export function createProgressReport({max = MAX_REPORTED_STEPS} = {}) {
    const steps = []
    let line
    const status = () => ({line, steps: steps.slice(-max), count: steps.length})
    return {
        step(toolName, args) {
            line = toolStepLine(toolName, args)
            steps.push(line)
            return status()
        },
        say(word) {
            line = word
            return status()
        },
        status
    }
}

function reportText({steps, count}) {
    return `Working — ${String(count)} step${count === 1 ? '' : 's'} so far:\n${steps.join('\n')}`
}

export const noProgress = () => {}

export function toolProgress(onUpdate) {
    if (typeof onUpdate !== 'function') return noProgress
    return status =>
        onUpdate({
            content: [{type: 'text', text: reportText(status)}],
            details: {steps: status.count, ...(status.line && {step: status.line})}
        })
}

export function eventProgress(emit, build, extra = {}) {
    if (typeof emit !== 'function') return noProgress
    if (typeof build !== 'function')
        throw new Error('A progress event was asked for without a constructor to build it with.')
    return status => emit(build({...extra, line: status.line ?? '', steps: status.count}))
}

async function attemptSubagent({
    prompt,
    images = [],
    systemPrompt = CHILD_SYSTEM_PROMPT,
    toolNames = SUBAGENT_TOOL_NAMES,
    workspacePath,
    models,
    model,
    thinkingLevel,
    streamOptions,
    signal,
    progress,
    bounds,
    timers,
    stopWhen,
    deps
}) {
    const {env, tools} = createChildTools(workspacePath, {
        bounds,
        timers,
        toolNames,
        deps: {...deps, model}
    })
    const pictures = modelReadsImages(model) ? images : []

    let requests = 0
    let overran = false
    let stalled = false
    let closedAt
    let closed = false
    const streamFn = (nextModel, context, options) => {
        requests += 1
        if (stopWhen?.() === true) {
            closedAt ??= requests
            if (requests > closedAt) {
                closed = true
                return endedStream(nextModel, 'The sub-agent was ended by the user.')
            }
        }
        if (!(bounds.maxTurns > 0) || requests <= bounds.maxTurns)
            return models.streamSimple(nextModel, context, {...options, ...streamOptions})
        overran = true
        return endedStream(
            nextModel,
            `The sub-agent used all ${String(bounds.maxTurns)} of its steps.`
        )
    }

    const agent = new Agent({
        initialState: {
            systemPrompt,
            model,
            thinkingLevel,
            tools,
            messages: []
        },
        streamFn,
        toolExecution: 'parallel'
    })

    const silence = createSilenceClock({
        timeoutMs: bounds.streamInactivityMs,
        timers,
        onSilent: () => {
            stalled = true
            agent.abort()
        }
    })

    const stop = () => agent.abort()
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, {once: true})

    let usage = zeroUsage()
    let answer = ''
    let lastFailure
    const report = createProgressReport()
    const unsubscribe = agent.subscribe(event => {
        if (event.type === 'message_update') {
            silence.note()
            const inner = event.assistantMessageEvent?.type
            if (inner === 'thinking_start') progress(report.say('thinking…'))
            else if (inner === 'text_start') progress(report.say('writing the answer…'))
            return
        }
        if (event.type === 'tool_execution_start') {
            silence.suspend(event.toolCallId)
            progress(report.step(event.toolName, event.args))
            return
        }
        if (event.type === 'tool_execution_end') {
            silence.resume(event.toolCallId)
            return
        }
        if (event.type !== 'turn_end' || event.message.role !== 'assistant') return
        silence.note()
        usage = addUsage(usage, event.message.usage)
        if (event.message.stopReason === 'error') lastFailure = event.message
        answer = textContent(event.message.content) || answer
    })

    try {
        silence.start()
        await agent.prompt(prompt, pictures)
        if (signal?.aborted) throw new SubagentStopped('the turn was stopped')
        if (stalled)
            throw new SubagentFailed(streamStallMessage(bounds.streamInactivityMs), {
                cause: 'stream-stall'
            })
        if (overran)
            throw new SubagentFailed(
                `it used all ${String(bounds.maxTurns)} of its steps without reaching an answer`,
                {retryable: false, cause: 'step-ceiling'}
            )
        if (lastFailure && !closed)
            throw new SubagentFailed(lastFailure.errorMessage || 'the model returned an error', {
                message: lastFailure,
                cause: 'model-error'
            })
        const failed = closed ? undefined : agent.state.errorMessage
        if (failed) throw new SubagentFailed(failed, {cause: 'model-error'})
        const text = answer.trim()
        if (!text && !closed)
            throw new SubagentFailed('it finished without writing an answer', {
                retryable: false,
                cause: 'no-answer'
            })
        return {text: cutAnswer(text, bounds.maxAnswerChars), usage, turns: requests}
    } finally {
        silence.stop()
        unsubscribe()
        signal?.removeEventListener('abort', stop)
        await env.cleanup()
    }
}

export class SubagentStopped extends Error {
    constructor(reason) {
        super(reason)
        this.reason = reason
        this.retryable = false
    }
}

export class SubagentFailed extends Error {
    constructor(reason, {retryable, message, cause} = {}) {
        super(reason)
        this.reason = reason
        this.retryable = retryable
        this.assistantMessage = message
        this.cause = cause ?? 'unknown'
    }
}

function endedStream(model, errorMessage) {
    const stream = createAssistantMessageEventStream()
    const message = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage(),
        stopReason: 'error',
        errorMessage,
        timestamp: Date.now()
    }
    stream.push({type: 'error', reason: 'error', error: message})
    stream.end(message)
    return stream
}

function cutAnswer(text, maxChars) {
    if (!(maxChars > 0) || text.length <= maxChars) return text
    return (
        `${text.slice(0, maxChars)}\n[cut here: the sub-agent's answer was `
        + `${String(text.length)} characters, which is not a distilled answer. Ask it something `
        + `narrower.]`
    )
}

export async function runSubagentOutcome({
    prompt,
    images = [],
    systemPrompt = CHILD_SYSTEM_PROMPT,
    toolNames = SUBAGENT_TOOL_NAMES,
    workspacePath,
    models,
    model,
    thinkingLevel = 'off',
    streamOptions = {},
    signal,
    progress,
    settings,
    timers = realTimers,
    stopWhen,
    deps
}) {
    if (typeof progress !== 'function')
        throw new Error(
            'A sub-agent was started without saying where its progress goes. Pass '
                + 'toolProgress(onUpdate) for a chat tool row, eventProgress(emit, build, extra) for '
                + 'a panel, or noProgress to run it silent on purpose.'
        )
    if (signal?.aborted) return {kind: 'stopped', reason: 'the turn was stopped'}
    const bounds = boundsFrom(settings)
    for (let attempt = 0; ; attempt += 1) {
        try {
            return {
                kind: 'ok',
                ...(await attemptSubagent({
                    prompt,
                    images,
                    systemPrompt,
                    toolNames,
                    workspacePath,
                    models,
                    model,
                    thinkingLevel,
                    streamOptions,
                    signal,
                    progress,
                    bounds,
                    timers,
                    stopWhen,
                    deps
                }))
            }
        } catch (error) {
            if (!(error instanceof SubagentFailed) && !(error instanceof SubagentStopped))
                throw error
            if (error instanceof SubagentStopped) return {kind: 'stopped', reason: error.reason}
            if (attempt >= bounds.retryAttempts || !isWorthRetrying(error, model))
                return {
                    kind: 'failed',
                    cause: error.cause,
                    reason: error.reason,
                    attempts: attempt + 1
                }
            await abortableWait(
                bounds.retryBaseDelayMs * 2 ** attempt,
                signal,
                timers,
                subagentFailure('the turn was stopped')
            )
        }
    }
}

export async function runSubagent(options) {
    const outcome = await runSubagentOutcome(options)
    if (outcome.kind === 'ok') return outcome
    throw new Error(subagentFailure(outcome.reason))
}

export function usageFooter({turns, usage}, model) {
    return (
        `[sub-agent: ${model.name || model.id}, `
        + `${String(turns)} step${turns === 1 ? '' : 's'}, `
        + `${usage.input.toLocaleString('en-US')} tokens in, `
        + `${usage.output.toLocaleString('en-US')} out]`
    )
}

export const PROBE_PROMPT = 'Reachability probe. Answer with one word and call no tools.'

export const SUBAGENT_PROBE_ANSWER = 'sub-agent-reachable'

export function cannedModels(model, answer = SUBAGENT_PROBE_ANSWER) {
    return {
        streamSimple: () => {
            const stream = createAssistantMessageEventStream()
            const message = {
                role: 'assistant',
                content: [{type: 'text', text: answer}],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: zeroUsage(),
                stopReason: 'stop'
            }
            stream.push({type: 'done', reason: 'stop', message})
            stream.end(message)
            return stream
        }
    }
}

export function createSubagentTool({
    workspacePath,
    models,
    model,
    thinkingLevel,
    streamOptions,
    settings,
    timers
}) {
    return {
        name: SUBAGENT_TOOL_NAME,
        label: 'sub-agent',
        description: SUBAGENT_DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description:
                        'The self-contained question for the sub-agent. Name the files, symbols '
                        + 'or terms it should start from, and say what shape of answer you want '
                        + 'back. It cannot see this conversation.'
                }
            },
            required: ['prompt']
        },
        execute: async (_toolCallId, params, signal, onUpdate) => {
            const probing = params?.probe === true
            if (!probing && (typeof params?.prompt !== 'string' || params.prompt.trim() === ''))
                throw new Error(subagentFailure('it was given no question to answer'))
            const result = await runSubagent({
                prompt: probing ? PROBE_PROMPT : params.prompt,
                workspacePath,
                models: probing ? cannedModels(model) : models,
                model,
                thinkingLevel,
                streamOptions,
                settings,
                timers,
                signal,
                progress: toolProgress(onUpdate)
            })
            return {
                content: [{type: 'text', text: `${result.text}\n\n${usageFooter(result, model)}`}],
                details: {turns: result.turns, usage: result.usage}
            }
        }
    }
}
