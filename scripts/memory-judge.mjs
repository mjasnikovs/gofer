/**
 * The other half of checking a memory: a model that reads the checkout and says whether the memory
 * is still true of it.
 *
 * The check beside this one is deterministic and free — it pulls the file paths out of a memory's
 * text and looks for them. Measured over 87 real memories it decided 55 of them and found 9 that
 * name a file the project no longer has. What it cannot do is read a sentence. "Drag-to-deploy
 * still works", "the roster is a tactical list", "the boss dies on the third hit" name no file, and
 * a memory that has quietly stopped being true is indistinguishable to it from one that never made
 * a claim at all. Those went out as `Names no file` — 32 of the 87.
 *
 * So this one is a delegation. It costs a model request and about a minute, which is why it is one
 * memory at a time and only when a person asks for it, and why the verdict is stored rather than
 * recomputed on every read the way the path check is.
 *
 * The child is `read` and `bash` and nothing else. Judging is reading, a judge that could write
 * would be a judge that can make its own verdict true, and `assertChildTools` refuses the rest.
 */

import {createModelContext} from './ai-provider.mjs'
import {createChildTools, eventProgress, runSubagentOutcome} from './ai-subagent.mjs'
import {probeTools} from './ai-reachability.mjs'

/** What the child is asked to be, as distinct from the research sub-agent's own prompt. */
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

/**
 * What the judge's child holds.
 *
 * Named rather than written at the call site, so the one delegation whose whole job is to be
 * trusted is a constant somebody can grep for. It is the delegation tool's own ration and must stay
 * a subset of it: a judge that could write is a judge that can make its own verdict true.
 */
export const JUDGE_TOOL_NAMES = ['read', 'bash']

/** The three answers a judge may give. Anything else is not a verdict. */
export const VERDICTS = ['holds', 'broken', 'unclear']

/** How much of the memory is put in front of the child. */
const MAX_MEMORY_CHARS = 4_000

/** How much of the child's own sentence is kept as the reason. */
const MAX_REASON_CHARS = 400

/**
 * The verdict a child's answer carries, and the reason it gave.
 *
 * An answer with no `VERDICT:` line is `unclear`, never `holds`. This is the same rule the verify
 * points keep for a shell command — the exit code decides and reading the output to guess at a
 * verdict is how you get a check that passes on the word ERROR in a filename. There is no exit code
 * here, so the marker is it, and a missing marker means the model did not answer the question it
 * was asked. Defaulting the other way would turn every malformed answer into a memory confirmed.
 */
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

/**
 * The one question the child is asked.
 *
 * The paths the deterministic check already resolved are handed over rather than left to be
 * rediscovered. It costs nothing to say and it is the difference between a child that spends three
 * steps running `find` and one that opens the file.
 */
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

/** Everything a judgement reaches outside this process, substituted whole by the tests. */
export const LIVE_WORLD = {createModelContext, createChildTools, probeTools, runSubagentOutcome}

/**
 * Judges one memory and says so on exactly one event before it returns.
 *
 * Every ending goes out as `judge-verdict`, `judge-stopped` or `judge-failed`, because the Rust side
 * is the only side that survives a stop — a run is cancelled by killing this process — and a panel
 * with no ending sits on a spinner for ever. A child that could not be built and a child that
 * answered nonsense are both endings.
 */
export async function runMemoryJudge({
    settings,
    apiKey,
    openrouterApiKey,
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
        oauthCredential,
        credentialHost,
        sessionId,
        signal
    })
    emit({type: 'judge-started'})
    const childDeps = {domains, host}

    try {
        // Before the model is reached, and for the same reason the brief probes: a tool that is
        // silently dead looks exactly like a model choosing not to call it, so a judgement made
        // without ever reading a file would come back as a confident `unclear`.
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
            progress: eventProgress(emit, 'judge-step', {memoryId: memory.id}),
            signal
        })
        if (outcome.kind === 'stopped') {
            emit({type: 'judge-stopped'})
            return null
        }
        if (outcome.kind === 'failed') {
            emit({type: 'judge-failed', reason: outcome.reason})
            return null
        }
        const {verdict, reason} = parseVerdict(outcome.text)
        emit({
            type: 'judge-verdict',
            verdict,
            reason,
            // The child's model, not the parent's. They are allowed to differ and usually do —
            // a large model drives the conversation while a small local one reads — and a verdict
            // filed under the wrong name cannot be weighed: the same sentence is worth different
            // things from a 27B running locally and from the model the user is paying for.
            model: subagent.model.name || subagent.model.id,
            input: outcome.usage?.input ?? 0,
            output: outcome.usage?.output ?? 0
        })
        emit({type: 'done', verdict})
        return verdict
    } catch (error) {
        // A probe that refused, a child that could not be built, a fault in here. All three used to
        // be the same thing to the window: nothing, for ever.
        emit({
            type: 'judge-failed',
            reason: error instanceof Error ? error.message : String(error)
        })
        throw error
    }
}
