/**
 * A second in-process Agent, held inside one tool, that reads the noisy material so the main agent
 * never has to.
 *
 * The main agent holds a live shell, a live editor and a real worktree, and everything it reads
 * stays in its context for the rest of the task. Both facts are expensive. A thousand-line file read
 * to answer one question costs that question's answer plus the whole file, for every turn after it;
 * and any text that lands in that context — a log, a generated file, a page — is sitting next to a
 * shell that runs without asking. So the reading is delegated to a child that has its own context,
 * its own turn budget and a far smaller tool list, and only the child's conclusion is handed back.
 * The raw material is thrown away with the child.
 *
 * The child is an `Agent`, not a process. Rust cannot build one, and there is nothing to spawn: the
 * provider, the models and the streaming already exist in `ai-provider.mjs`, and the child reuses
 * them rather than standing up a second connection to the same local model.
 *
 * What the child is allowed is decided here and nowhere else. It gets `read` and `bash`, named one
 * at a time rather than filtered out of the parent's list, and both go through `confineTool` — the
 * worktree boundary is the whole safety story for a shell, and a child shell is still a shell. It
 * never gets `write`, `edit` or any `godot_*` tool, because a delegate that answers questions has no
 * business changing the project, and it never gets `subagent`, because a child that can delegate can
 * delegate forever.
 *
 * What bounds it is not decided here. Every ceiling is a setting, because none of them is a fact
 * about Gofer — they are facts about the machine the model runs on, and a number that suits a
 * workstation starves a laptop. `SUBAGENT_BOUNDS` below is the shipped set and the fallback for a
 * caller with no settings to hand; `settings.rs` is what actually writes them.
 *
 * Three things bound a delegation, and they are separate because each is blind to the others:
 *
 *   commandTimeoutMs   one tool call. A shell command the model did not bound runs until the machine
 *                      is rebooted, and while it does the model stream is perfectly healthy.
 *   streamInactivityMs silence from the model, with time spent inside tools excluded. A dropped
 *                      stream throws nothing and reports nothing; it just stops. Excluding tool time
 *                      is what stops a legitimate five-minute command reading as a hang.
 *   maxTurns           model requests. Neither clock can see a sub-agent that is busy and getting
 *                      nowhere: it is answering, it is calling tools, and it is spending the machine.
 */

import {
    Agent,
    NodeExecutionEnv,
    createBashTool,
    createReadTool
} from '@earendil-works/pi-agent-core/node'
import {createAssistantMessageEventStream, isRetryableAssistantError} from '@earendil-works/pi-ai'
import {isContextOverflow} from '@earendil-works/pi-ai/compat'
import {createGodotTools, withoutPictures, withoutRepeatingARefusal} from './ai-host.mjs'
import {createWebSearchTool} from './ai-search.mjs'
import {ASK_USER_TOOL_NAME, createAskUserTool} from './ai-ask.mjs'
import {toolStepLine} from './tool-target.mjs'
import {confineTool} from './workspace-confinement.mjs'

export const SUBAGENT_TOOL_NAME = 'subagent'

/**
 * Every tool a child may hold — the ceiling, not the ration. Read as an allow-list, not as a
 * starting point: `assertChildTools` refuses anything outside it, so widening any child's reach
 * means editing this line on purpose.
 *
 * Notably absent, and staying absent: `web_fetch` and `design_with_user`. Each is itself a
 * sub-agent — one hands a page to a toolless child so the raw text never reaches the caller, the
 * other hands a brief to a child that talks to the user — so a child holding either is a grandchild,
 * and "a child cannot delegate" stops being true with nothing in the code left to say so. A caller
 * that needs a page fetches it and puts the answer in the child's prompt.
 *
 * `ask_user` is on the list and is not an exception to that rule. It builds no agent; it is a call
 * to the window, the same shape as `godot_docs_search`'s call to the editor. What it needs instead
 * is a ceiling of its own, and that ceiling is a count rather than a name: nothing else in the
 * system can see a child spending somebody's attention. See `REACHING_CHILD_TOOLS`.
 */
export const CHILD_TOOL_NAMES = ['read', 'bash', 'godot_docs_search', 'web_search', 'ask_user']

/**
 * What the `subagent` tool itself hands its child, and the default for any caller that does not ask.
 *
 * Separate from the ceiling above, because the two answer different questions. Widening the ceiling
 * so a research worker can look something up must not, by the same edit, hand the delegation tool a
 * search engine it was never reviewed for — a tool list that grows as a side effect of somebody
 * else's feature is precisely the invisible widening `assertChildTools` exists to catch.
 */
export const SUBAGENT_TOOL_NAMES = ['read', 'bash']

/**
 * What `design_with_user` hands its child: the delegation ration, plus the window.
 *
 * Named here rather than written at the call site so the one child allowed to interrupt the user is
 * a constant somebody can grep for, and so a test can assert that `SUBAGENT_TOOL_NAMES` did not
 * quietly become this.
 */
export const DESIGN_TOOL_NAMES = ['read', 'bash', 'ask_user']

/**
 * The shipped ceilings as the settings file stores them, and what a caller with no settings gets.
 *
 * The same numbers and the same names as `default_subagent_*` in `src-tauri/src/settings.rs`, which
 * is the side that writes the file and the side the settings page edits. Repeated here rather than
 * imported because Node cannot read Rust, and a sub-agent running with no ceiling at all is worse
 * than one running on a stale copy of them. Every one means "off" at 0.
 *
 * The units are the units a person chooses in: minutes for a clock they are guessing at, seconds for
 * one they are not. Milliseconds are what the code needs, which is a different question, so the
 * conversion happens once, in `boundsFrom`, and nowhere else.
 */
export const SUBAGENT_SETTINGS_DEFAULTS = {
    commandTimeoutMinutes: 5,
    streamInactivityMinutes: 10,
    maxTurns: 24,
    maxAnswerChars: 12_000,
    maxShows: 6,
    retryAttempts: 2,
    retryBaseDelaySeconds: 1
}

/** The same ceilings in the units the clocks below actually count in. */
export function boundsFrom(settings) {
    // Field by field, not a spread of the whole object: a settings file that predates one bound
    // arrives with it undefined, and an undefined ceiling is an absent ceiling.
    const chosen = settings ?? {}
    const pick = name =>
        typeof chosen[name] === 'number' ? chosen[name] : SUBAGENT_SETTINGS_DEFAULTS[name]
    return {
        commandTimeoutMs: pick('commandTimeoutMinutes') * 60_000,
        streamInactivityMs: pick('streamInactivityMinutes') * 60_000,
        maxTurns: pick('maxTurns'),
        maxAnswerChars: pick('maxAnswerChars'),
        maxShows: pick('maxShows'),
        retryAttempts: pick('retryAttempts'),
        retryBaseDelayMs: pick('retryBaseDelaySeconds') * 1_000
    }
}

/** The shipped ceilings, converted. What `createChildTools` uses when it is handed nothing. */
export const SUBAGENT_BOUNDS = boundsFrom(undefined)

/**
 * How often the clocks are read.
 *
 * A poll rather than a timer re-armed on every event, because a streaming turn emits thousands of
 * them. Derived from the ceiling it watches rather than fixed, so a short ceiling set for a test is
 * still checked often enough to fire, and a ten-minute one is not checked a thousand times.
 */
function pollIntervalMs(timeoutMs) {
    return Math.max(20, Math.min(Math.floor(timeoutMs / 4), 30_000))
}

/**
 * Progress lines kept in the live report.
 *
 * Not a setting: it decides how tall one tool row grows on screen, which is a fact about the window
 * rather than about the machine. Nothing is bounded by it.
 */
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

/**
 * The one shape a sub-agent failure reaches the parent in.
 *
 * Every way this tool can fail — a child that ran out of turns, a child that stopped without saying
 * anything, a stream that errored, a cancelled parent turn — is written here and only here. Formatted
 * at each call site instead, the rule drifts: one path returns a bare provider string, another
 * returns a stack, and the parent model reads two different things as the same event. The second
 * sentence is the part that matters to the parent: the failure cost it context it did not receive,
 * so it has to be told the material is still unread rather than assumed empty.
 */
export function subagentFailure(reason) {
    return (
        `The sub-agent did not answer: ${reason}. Nothing it read reached this conversation, so `
        + `treat the question as unanswered — ask again with a narrower, more specific question, or `
        + `do the reading yourself with read and bash.`
    )
}

function zeroUsage() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
    }
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

function textContent(content) {
    return (content ?? [])
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
}

/**
 * Refuses a child tool list that grew.
 *
 * The list below is built from named constructors, so today this cannot fire. It exists because
 * the thing it guards is invisible: a tool added to the child later — by a filter that let one
 * through, by a helper that seemed to belong to both agents — hands a delegate a shell it may write
 * with, or hands it `subagent` and lets a chain of children spend a machine. Neither shows up as a
 * failure; both show up as the agent doing something nobody asked for. So the list is asserted every
 * time a child is built, and the assertion names what it found.
 *
 * `allowed` lets a caller ask for *less* — the page reader asks for nothing at all. It cannot ask
 * for more: a list holding a name `CHILD_TOOL_NAMES` does not is refused before the tools are even
 * read, so that constant stays the one place a child's reach grows, and it grows by being edited.
 */
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

/**
 * What a tool call is told when it is cut off for running too long.
 *
 * Two jobs, and the first is the one that is easy to miss: stop the model recording a killed command
 * as a finished one. A cut-off call returns nothing, and a model that reads "aborted" as "done"
 * carries on as though the build succeeded. The second is to name the one thing that prevents a
 * repeat — the bash tool takes its own `timeout`, in seconds — because "be faster" is not something
 * the model can act on.
 */
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

/**
 * One tool call, under a clock.
 *
 * The bash tool takes an optional timeout and has no default, so a command the model did not bound
 * runs forever — and while it does, everything else looks healthy: the stream is fine because it is
 * the model's turn to wait, the machine is fine, and the delegation simply never ends.
 *
 * pi-task guards the same hole by killing the whole child and re-spawning it with a hint, because a
 * child process has no per-call cancellation channel. Gofer's child is in-process and this wrapper
 * holds the call's own `AbortController`, so only the call dies. The sub-agent keeps its context,
 * gets the correction as that call's result, and carries on — which is why none of pi-task's restart,
 * carry-forward and salvage machinery is needed here.
 */
/**
 * The tools the command clock does not apply to, because their wait is a person.
 *
 * The clock exists to stop an unbounded shell command from ending a delegation by never returning.
 * A question in front of somebody is the opposite case: the wait is the feature, five minutes is a
 * short time to look at a layout and say what is wrong with it, and aborting one would report a
 * runaway command to a model whose tool was working perfectly. `scripts/brief/run.mjs` holds the
 * same time out of its own deadline, for the same reason and under the same name.
 */
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
                            // Aborting the call is what reaps the process: the execution
                            // environment kills the whole process group on abort, so the command
                            // dies with the call rather than outliving the delegation that ran it.
                            controller.abort()
                            resolve(undefined)
                        }, timeoutMs)
                    })
                ])
                if (overran) throw new Error(commandOverrunMessage(tool.name, timeoutMs))
                return result
            } catch (error) {
                // A call the clock stopped reports the clock, whichever of the two paths noticed
                // first: the race can settle on the tool's own "Command aborted" rejection, which
                // says nothing about why it was aborted.
                if (overran) throw new Error(commandOverrunMessage(tool.name, timeoutMs))
                throw error
            } finally {
                timers.cancel(timer)
                signal?.removeEventListener('abort', stop)
            }
        }
    }
}

/**
 * Every tool a child can be built from, by the name a caller asks for it by.
 *
 * A table rather than a filter over the parent's list, and that is the whole point: a filter is a
 * rule about what to take away, so every tool added to the parent afterwards arrives here by default
 * and has to be noticed. A table is a rule about what to give, and nothing arrives that was not
 * typed into it.
 *
 * Two tables, because the tools are two shapes and confinement only fits one. `confineTool` resolves
 * a `path` parameter against the worktree and refuses anything outside it; run over a tool with no
 * path it rewrites `undefined` and rejects every call. So the file and shell tools are confined and
 * the reaching tools are not — which is not an oversight but the standing fact that confinement is
 * file-shaped and says nothing about the network.
 */
const CONFINED_CHILD_TOOLS = {read: createReadTool, bash: createBashTool}

/**
 * The tools that reach past the worktree, each built from what the caller had to supply.
 *
 * They are here rather than in the table above because none of them can be built from a workspace
 * path alone: a search needs a provider and a key, and a documentation lookup is not built in Node at
 * all — it is forwarded to Rust, so the child needs the same host handle the parent's tools use.
 * A caller asking for one without supplying what it needs is refused by name, because a tool built
 * from an absent dependency fails later, inside a turn, as something that reads like a model mistake.
 */
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
    ask_user: ({host, asks, sketchesRequired = false, sessionId, agreed}) => {
        if (!host) {
            throw new Error(
                'A child was asked for ask_user without the tool host that answers it. '
                    + 'Pass `host` to createChildTools.'
            )
        }
        if (!Number.isInteger(asks) || asks < 1) {
            throw new Error(
                'A child was asked for ask_user without a ration. A child that can interrupt the '
                    + 'user has to say how many times, because nothing else can see that it did: '
                    + 'the parent never learns a dialog was opened, and the clocks here do not tick '
                    + 'while a person is thinking.'
            )
        }
        return createAskUserTool({host, budget: asks, sketchesRequired, sessionId, agreed})
    }
}

/**
 * The child's tools: the file and shell ones confined to the same worktree the parent works in, the
 * reaching ones built from `deps`, and every one of them under its own command clock.
 *
 * `toolNames` defaults to the delegation tool's ration rather than to the ceiling, so a caller that
 * does not ask gets exactly what the `subagent` tool has always given. The page reader passes `[]`:
 * its material is already in its prompt, so a tool could only reach for something unsourced.
 */
export function createChildTools(
    workspacePath,
    {bounds = SUBAGENT_BOUNDS, timers = realTimers, toolNames = SUBAGENT_TOOL_NAMES, deps = {}} = {}
) {
    // Asked before anything is built: a name with no constructor behind it would otherwise fail as
    // `undefined is not a function`, which names neither the tool nor the rule it broke.
    assertChildTools([], toolNames)
    const env = new NodeExecutionEnv({cwd: workspacePath})
    const context = {env}
    const built = toolNames.map(name =>
        name in CONFINED_CHILD_TOOLS ?
            confineTool(CONFINED_CHILD_TOOLS[name](), workspacePath)
        :   REACHING_CHILD_TOOLS[name](deps)
    )
    const tools = built
        .map(tool => ({
            ...tool,
            execute: (id, params, signal, onUpdate) =>
                tool.execute(id, params, signal, onUpdate, context)
        }))
        // The child's own model, which may not be the parent's and may not have its eyes.
        .map(tool => (readsImages(deps.model) ? tool : withoutPictures(tool)))
        // A child loops the way a parent does, and its tools are built per call, so the counter is
        // per child.
        .map(withoutRepeatingARefusal)
        .map(tool => underCommandClock(tool, {timeoutMs: bounds.commandTimeoutMs, timers}))
    assertChildTools(tools, toolNames)
    return {env, tools}
}

/**
 * Can this model be shown a picture?
 *
 * Read off the model rather than assumed, because a model that cannot is not lenient about it: the
 * provider refuses the whole request, so an unchecked image ends the child at its first step rather
 * than going unnoticed in it. A model that says nothing about its inputs is taken at its word — no
 * claim to read images is not a claim to read them.
 */
export function readsImages(model) {
    return Array.isArray(model?.input) && model.input.includes('image')
}

/**
 * Real timers, and the seam every clock here is tested through.
 *
 * Injectable because the alternative is a test that waits out a five-minute ceiling to prove the
 * ceiling works. `now` is separate from `schedule` because the silence clock polls: it asks how long
 * it has been rather than being re-armed on every one of the thousands of events a stream emits.
 */
export const realTimers = {
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: handle => {
        clearTimeout(handle)
    },
    repeat: (fn, ms) => setInterval(fn, ms),
    stopRepeat: handle => {
        clearInterval(handle)
    }
}

/**
 * The clock on model silence.
 *
 * It measures time since the last stream event of any kind, and it is suspended for as long as any
 * tool is running. That suspension is the whole design: while a tool executes the model is
 * legitimately saying nothing, and without it every command longer than the ceiling would read as a
 * hang. What is left over is the failure it exists for — a stream that stops mid-answer, throwing
 * nothing and reporting nothing, which no error path can see because there is no error.
 *
 * The running set is keyed by tool call id rather than being a flag, because a turn runs its tools in
 * parallel. A flag is cleared by the first tool to finish and leaves the slow sibling exposed to a
 * clock that should still be paused.
 */
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

/**
 * How a stalled stream is worded, and why it is worded at all.
 *
 * Phrased so that Pi's own `isRetryableAssistantError` matches it. A stream that stops without
 * erroring is a connection that died quietly, which is the same fault as one that died loudly — so it
 * routes into the retry path that already exists rather than growing a second one beside it.
 */
export function streamStallMessage(timeoutMs) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000))
    return (
        `Connection lost: the model sent nothing for ${String(seconds)} seconds and reported no `
        + `error. The request was aborted by Gofer, not by the provider.`
    )
}

/**
 * What a delegation has done so far, as the little a screen can hold.
 *
 * One box, built here, so no caller keeps this by hand. Four sites in pi-task kept the same two
 * fields with the same two callbacks before it collapsed them into one class, and Gofer was on the
 * same road: the tool row grew its own accumulator inside a tool's `execute`, and every other caller
 * — the page reader, four research workers — grew nothing and showed nothing.
 *
 * Two fields, because they answer different questions. `line` is what it is doing NOW and belongs on
 * a row that has one line for it. `steps` is what it has done, which is only readable somewhere that
 * can be opened. `count` is not `steps.length`: the list is trimmed to what fits and the count is not.
 */
export function createProgressReport({max = MAX_REPORTED_STEPS} = {}) {
    const steps = []
    let line
    const status = () => ({line, steps: steps.slice(-max), count: steps.length})
    return {
        /** A tool call started. The only thing that adds to the history. */
        step(toolName, args) {
            line = toolStepLine(toolName, args)
            steps.push(line)
            return status()
        },
        /**
         * The child is busy with something that is not a tool call.
         *
         * Between two tool calls a child is thinking or writing, and both are silent — so a row that
         * only ever hears about tool calls sits on a stale line for as long as the model takes. The
         * word replaces the line and is deliberately kept out of the history: a step list is what it
         * DID, and "thinking…" twelve times over is not that.
         */
        say(word) {
            line = word
            return status()
        },
        status
    }
}

/** What the tool row's opened detail says, which is the history rather than the moment. */
function reportText({steps, count}) {
    return `Working — ${String(count)} step${count === 1 ? '' : 's'} so far:\n${steps.join('\n')}`
}

/**
 * Silence, chosen rather than forgotten.
 *
 * A delegation must be told where its progress goes, and this is the answer that means nowhere. It
 * exists so that saying nothing is a word somebody typed: the parameter used to be optional, and the
 * three callers that never passed it — a page reader and four research workers — ran silent for
 * weeks with nothing in the code saying they meant to.
 */
export const noProgress = () => {}

/**
 * Into the chat's tool row: the live line onto the row itself, the history under it.
 *
 * The line rides `details` rather than the content, because content is what a reader sees when the
 * row is opened and the row is closed by default. `ai-provider.mjs` lifts it onto the `tool-update`
 * event, and the row appends it to the question it was asked.
 */
export function toolProgress(onUpdate) {
    if (typeof onUpdate !== 'function') return noProgress
    return status =>
        onUpdate({
            content: [{type: 'text', text: reportText(status)}],
            details: {steps: status.count, ...(status.line && {step: status.line})}
        })
}

/**
 * Onto a worker event, for a panel that is not a tool row.
 *
 * A brief's research workers are not tool calls in anybody's conversation — they are the host loop's
 * own children — so they have no `onUpdate` to write to and reach their panel down the same event
 * pipe every other phase boundary uses. `type` and `extra` are the caller's because the vocabulary
 * is: `brief-worker-step` is a word `scripts/brief/catalogue.mjs` owns and a checker reconciles, and
 * a name invented here would be a second owner of it.
 */
export function eventProgress(emit, type, extra = {}) {
    if (typeof emit !== 'function') return noProgress
    if (typeof type !== 'string' || type === '')
        throw new Error('A progress event was asked for without a name to emit it under.')
    return status => emit({type, ...extra, line: status.line ?? '', steps: status.count})
}

/**
 * One attempt at a delegation: build a child, ask it, and return its conclusion.
 *
 * Throws on every ending that is not an answer. The throw carries the raw cause, and `runSubagent`
 * above it decides whether that cause is worth another attempt before wording it for the parent.
 */
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
    deps
}) {
    const {env, tools} = createChildTools(workspacePath, {
        bounds,
        timers,
        toolNames,
        deps: {...deps, model}
    })
    // Dropped here rather than at each call site, because the failure is the same one everywhere and
    // it is not a soft one: a picture sent to a text-only model has the provider refuse the whole
    // request, so an unchecked image ends the child at its first step instead of costing it a
    // detail. Every caller may pass what it has and let the model decide.
    const pictures = readsImages(model) ? images : []

    let requests = 0
    let overran = false
    let stalled = false
    /*
     * The step ceiling is spent here, in front of the provider, rather than by aborting the loop from
     * a listener — which does not work and is worth writing down. The agent loop never asks whether
     * it has been aborted: it starts the next request and lets the provider and the tools notice the
     * signal for it. A child whose provider ignores the signal therefore runs for ever, and the abort
     * that was meant to end the loop reads as an abort with no consequence. The loop does stop,
     * cleanly and by itself, on an assistant message that stopped with an error, so that is what the
     * request after the last affordable one is answered with. It also puts the ceiling on the thing
     * that costs: requests to the model, counted before one is made rather than after.
     */
    const streamFn = (nextModel, context, options) => {
        requests += 1
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
            // The provider honours the signal, so aborting is what ends the hung request. If it ever
            // did not, nothing here could end it — a request that ignores cancellation cannot be
            // taken back in-process — and that is the one hang this cannot cover.
            agent.abort()
        }
    })

    // The parent's turn owns the child's life. A cancelled turn that left a child reading files and
    // running shell commands would keep spending the machine with nobody watching it, and would land
    // its output in a turn that had already ended.
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
            // Only the two events that mark a beginning. `message_update` also carries one event per
            // token, and reporting on those would push a status across the pipe thousands of times
            // per answer to say the same word.
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
        // Kept rather than replaced when the next turn writes nothing: a child that answers and then
        // makes one more tool call has still answered, and the turn that ends the loop is often the
        // empty one.
        answer = textContent(event.message.content) || answer
    })

    try {
        silence.start()
        await agent.prompt(prompt, pictures)
        // Asked before anything else, and never retried: a stopped turn is the user's decision, not
        // a fault, and asking again would spend the machine they just asked to stop spending.
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
        if (lastFailure)
            throw new SubagentFailed(lastFailure.errorMessage || 'the model returned an error', {
                message: lastFailure,
                cause: 'model-error'
            })
        const failed = agent.state.errorMessage
        if (failed) throw new SubagentFailed(failed, {cause: 'model-error'})
        const text = answer.trim()
        if (!text)
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

/** An ending the user asked for. Never retried, and worded as a stop rather than as a fault. */
export class SubagentStopped extends Error {
    constructor(reason) {
        super(reason)
        this.reason = reason
    }
}

/**
 * An ending that was not an answer, carrying enough for the retry decision to be made once.
 *
 * `cause` names WHICH ending, as a tag rather than as the sentence. The sentence is written for a
 * person and for a model, and it changes when the wording improves; anything deciding what to *do*
 * about a failure has to key off something that does not. Without it the only handle is the prose,
 * and a caller reading prose is a ladder that drifts silently the first time a message is reworded.
 */
export class SubagentFailed extends Error {
    constructor(reason, {retryable, message, cause} = {}) {
        super(reason)
        this.reason = reason
        this.retryable = retryable
        this.assistantMessage = message
        this.cause = cause ?? 'unknown'
    }
}

/** A stream that is over before it starts, carrying the reason the loop should stop. */
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

/**
 * Whether asking again is worth anything.
 *
 * Pi's own classifier, not a second list of provider wording kept in step with it by hand. Context
 * overflow is asked first and always answered no, exactly as the parent turn does: it is
 * deterministic, it fails identically every time, and the child has no compaction to repair it with —
 * a narrower question is the repair, and only the parent can ask one.
 */
function isWorthAnotherAttempt(failure, model) {
    if (failure instanceof SubagentStopped) return false
    if (failure.retryable !== undefined) return failure.retryable
    const message = failure.assistantMessage ?? {
        stopReason: 'error',
        errorMessage: failure.reason
    }
    if (isContextOverflow(message, model.contextWindow)) return false
    return isRetryableAssistantError(message)
}

/**
 * Runs one delegation, asking again when the failure was the kind that fixes itself, and answers
 * WHICH of the three endings happened rather than only whether there is an answer.
 *
 * A local server with one slot, briefly saturated by the parent and the child it just started, drops
 * a connection the next request would have got. The parent turn already waits that out for itself;
 * without this the child does not, and a delegation dies for a blip the turn around it would have
 * survived. Nothing else is retried: a step ceiling reached, an answer never written and a context
 * that will not fit all fail the same way every time.
 *
 * The three endings are kept apart because one caller — a host loop running phases — has to treat
 * them differently and cannot. `runSubagent` below flattens all of them into one `Error` carrying
 * prose written for a *model* to read, which is right for a tool result and useless to code: a
 * pipeline that degrades past a failure would, on that contract, also degrade past the stop the user
 * just asked for and carry on spending the machine.
 *
 *   ok       an answer, with what it cost.
 *   stopped  the user's doing. Never retried, and never degraded past.
 *   failed   everything else, with the reason and whether the retries were spent.
 */
export async function runSubagentOutcome({
    prompt,
    /**
     * The pictures the ask is about, as `{type, data, mimeType}` beside the text.
     *
     * Empty for every caller but one. A brief's refine worker is asked about a screenshot the user
     * pasted, and a picture cannot be described into a prompt by the code passing it along.
     */
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
    deps
}) {
    // Asked before the abort check, so a stopped turn does not hide the mistake until the next run.
    // Required rather than optional, and the reason is the history: it was optional, and of the three
    // callers only one ever passed it — so a page reader and four research workers spent minutes each
    // with nothing on screen, and no line of code anywhere said that was the intention.
    if (typeof progress !== 'function')
        throw new Error(
            'A sub-agent was started without saying where its progress goes. Pass '
                + 'toolProgress(onUpdate) for a chat tool row, eventProgress(emit, type, extra) for '
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
                    deps
                }))
            }
        } catch (error) {
            // Anything that is not one of the two endings is a fault in this file rather than an
            // ending of the delegation, and is raised so it is seen as one.
            if (!(error instanceof SubagentFailed) && !(error instanceof SubagentStopped))
                throw error
            if (error instanceof SubagentStopped) return {kind: 'stopped', reason: error.reason}
            if (attempt >= bounds.retryAttempts || !isWorthAnotherAttempt(error, model))
                return {
                    kind: 'failed',
                    cause: error.cause,
                    reason: error.reason,
                    attempts: attempt + 1
                }
            await wait(bounds.retryBaseDelayMs * 2 ** attempt, signal, timers)
        }
    }
}

/**
 * The same delegation, as the `subagent` tool needs it: an answer, or a throw whose message is the
 * one sentence a parent model should read about a child that did not answer.
 *
 * Kept as the tool's contract rather than pushed into every call site, because a tool result is read
 * by a model and `subagentFailure` is the one place that wording is decided.
 */
export async function runSubagent(options) {
    const outcome = await runSubagentOutcome(options)
    if (outcome.kind === 'ok') return outcome
    throw new Error(subagentFailure(outcome.reason))
}

/** A wait a stopped turn does not have to sit through. */
function wait(ms, signal, timers) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error(subagentFailure('the turn was stopped')))
        const handle = timers.schedule(resolve, ms)
        signal?.addEventListener(
            'abort',
            () => {
                timers.cancel(handle)
                reject(new Error(subagentFailure('the turn was stopped')))
            },
            {once: true}
        )
    })
}

/**
 * What the delegation cost, said where it was spent.
 *
 * Not emitted as a `usage` event, and deliberately. That event sets the turn's token count, and the
 * conversation reads the last one as how full the model's context is — but the child's tokens are
 * precisely the ones that are *not* in the parent's context, because the child's context was thrown
 * away. Reported there, they would make the context bar lie in the direction that matters. Reported
 * here they are attached to the call that spent them, visible in the tool row while it runs and
 * afterwards, and on the transcript where the parent model can see what its own delegation cost.
 *
 * The model is named for the same reason the tokens are. The child may be given a model of its own,
 * and a count with no model against it cannot be read: two hundred thousand tokens is a runaway on
 * the connection the parent is paying for and an ordinary read on a local one.
 */
export function usageFooter({turns, usage}, model) {
    return (
        `[sub-agent: ${model.name || model.id}, `
        + `${String(turns)} step${turns === 1 ? '' : 's'}, `
        + `${usage.input.toLocaleString('en-US')} tokens in, `
        + `${usage.output.toLocaleString('en-US')} out]`
    )
}

export const PROBE_PROMPT = 'Reachability probe. Answer with one word and call no tools.'

/** The word a probed sub-agent has to come back with. Shared with `ai-reachability.mjs`. */
export const SUBAGENT_PROBE_ANSWER = 'sub-agent-reachable'

/**
 * A model that answers once, immediately, without a network call.
 *
 * The probe has to prove a child can be built and can answer, and a real request would put a model
 * call in front of every turn the user takes — on a local model that is seconds, every time, for a
 * tool they may not use. So the loop is driven for real and only the provider is canned: the tool is
 * constructed, the child's tool list is built and asserted, the `Agent` runs a turn, and the answer
 * comes back out through the same extraction and the same footer the real path uses. What it cannot
 * prove is that the model server is up, which is not this tool's to prove — the parent's own turn
 * fails on that within seconds, saying so.
 */
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

/**
 * The `subagent` tool as the main agent sees it.
 *
 * `models` and `model` are the parent's own. There is one provider, one connection and one model in
 * a Gofer session, and a second one built here would be a second thing to configure, to fail, and to
 * disagree with the settings page.
 */
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
