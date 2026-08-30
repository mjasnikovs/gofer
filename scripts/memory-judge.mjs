import {
    judgeDone,
    judgeFailed,
    judgeStarted,
    judgeStep,
    judgeStopped,
    judgeVerdict
} from './ai-events.mjs'
import {createModelContext} from './ai-provider.mjs'
import {createChildTools, eventProgress, runSubagentOutcome} from './ai-subagent.mjs'
import {probeTools} from './ai-reachability.mjs'

const JUDGE_SYSTEM_PROMPT =
    'You are checking one stored memory against the checkout you are standing in.\n'
    + '\n'
    + 'The memory was written automatically when an earlier piece of work finished. It records what '
    + 'somebody asked for and what was done about it. It is a record of the past, so it is not '
    + 'wrong merely because it is old: your question is whether what it says about this project is '
    + 'still true of the files as they are NOW.\n'
    + '\n'
    + 'Read what you need with read and bash. You cannot change anything and must not try.\n'
    + '\n'
    + 'Judge only the claims about the project. Ignore whether the request was reasonable, whether '
    + 'the work was good, and whether you would have done it that way.\n'
    + '\n'
    + 'A memory that says something was deleted HOLDS while that thing is still gone. A memory '
    + 'about a conversation — options offered, a question answered, nothing built — makes no claim '
    + 'about the files, and is UNCLEAR rather than either of the others.\n'
    + '\n'
    + 'Answer in exactly this shape:\n'
    + '\n'
    + 'VERDICT: holds\n'
    + 'One sentence saying what you read that decided it, naming the file.\n'
    + '\n'
    + 'The first line must be VERDICT: followed by one of holds, broken, or unclear, and nothing '
    + 'else. Use unclear when the checkout does not settle it — that is an ordinary answer, not a '
    + 'failure, and it is the right one whenever you would otherwise be guessing.'

export const JUDGE_TOOL_NAMES = ['read', 'bash']

export const VERDICTS = ['holds', 'broken', 'unclear']

const MAX_MEMORY_CHARS = 4_000

const MAX_REASON_CHARS = 400

export function parseVerdict(answer) {
    const text = String(answer ?? '').trim()
    const [first, ...rest] = text.split('\n')
    const marked = /^VERDICT:\s*([a-z]+)\s*$/iu.exec((first ?? '').trim())
    const named = marked?.[1]?.toLowerCase()
    if (!named || !VERDICTS.includes(named))
        return {
            verdict: 'unclear',
            reason:
                'The judge did not answer with a verdict line, so nothing it wrote is being read '
                + `as one. It said: ${cut(text, MAX_REASON_CHARS)}`
        }
    const reason = cut(rest.join(' ').trim(), MAX_REASON_CHARS)
    return {verdict: named, reason: reason || 'The judge gave no reason.'}
}

function cut(text, maximum) {
    return text.length > maximum ? `${text.slice(0, maximum)}…` : text
}

export function judgePrompt({content, anchors = []}) {
    const found = anchors.filter(anchor => anchor.resolved).map(anchor => anchor.resolved)
    const missing = anchors.filter(anchor => !anchor.resolved).map(anchor => anchor.named)
    const notes = []
    if (found.length > 0) notes.push(`Files it names that exist here: ${found.join(', ')}.`)
    if (missing.length > 0)
        notes.push(
            `Files it names that are NOT in this checkout: ${missing.join(', ')}. `
                + 'That has already been established — do not spend steps confirming it. What it '
                + 'means for this memory is the question.'
        )
    return (
        'Here is the stored memory, between the markers.\n\n'
        + '--- MEMORY BEGINS ---\n'
        + `${cut(String(content ?? '').trim(), MAX_MEMORY_CHARS)}\n`
        + '--- MEMORY ENDS ---\n'
        + (notes.length > 0 ? `\n${notes.join('\n')}\n` : '')
        + '\nIs what this says about the project still true of the files as they are now?'
    )
}

export const LIVE_WORLD = {createModelContext, createChildTools, probeTools, runSubagentOutcome}

export async function runMemoryJudge({
    settings,
    apiKey,
    openrouterApiKey,
    cerebrasApiKey,
    oauthCredential,
    sessionId,
    workspacePath,
    memory,
    tools: domains,
    host,
    credentialHost,
    emit,
    signal,
    world = LIVE_WORLD
}) {
    if (typeof memory?.content !== 'string' || memory.content.trim() === '') {
        throw new Error('The judge was given no memory to check')
    }
    const {models, model, subagent, streamOptions} = world.createModelContext({
        settings,
        apiKey,
        openrouterApiKey,
        cerebrasApiKey,
        oauthCredential,
        credentialHost,
        sessionId,
        signal
    })
    emit(judgeStarted())
    const childDeps = {domains, host}

    try {
        const {env, tools} = world.createChildTools(workspacePath, {
            toolNames: JUDGE_TOOL_NAMES,
            deps: childDeps
        })
        try {
            await world.probeTools({tools, host, workspacePath, signal})
        } finally {
            await env.cleanup()
        }

        const outcome = await world.runSubagentOutcome({
            prompt: judgePrompt(memory),
            systemPrompt: JUDGE_SYSTEM_PROMPT,
            toolNames: JUDGE_TOOL_NAMES,
            workspacePath,
            models,
            model: subagent.model,
            thinkingLevel: subagent.thinkingLevel,
            streamOptions,
            settings: settings?.subagent,
            deps: childDeps,
            progress: eventProgress(emit, judgeStep, {memoryId: memory.id}),
            signal
        })
        if (outcome.kind === 'stopped') {
            emit(judgeStopped())
            return null
        }
        if (outcome.kind === 'failed') {
            emit(judgeFailed(outcome.reason))
            return null
        }
        const {verdict, reason} = parseVerdict(outcome.text)
        emit(
            judgeVerdict({
                verdict,
                reason,
                model: subagent.model.name || subagent.model.id,
                input: outcome.usage?.input ?? 0,
                output: outcome.usage?.output ?? 0
            })
        )
        emit(judgeDone(verdict))
        return verdict
    } catch (error) {
        if (signal?.aborted) {
            emit(judgeStopped())
            return null
        }
        emit(judgeFailed(error instanceof Error ? error.message : String(error)))
        throw error
    }
}
