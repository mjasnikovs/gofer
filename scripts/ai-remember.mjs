export const REMEMBER_TOOL_NAME = 'remember'

export const REMEMBER_PROBE_ANSWER = 'remember-reachable'

export const MEMORY_KINDS = ['decision', 'preference', 'fact', 'issue']

const DESCRIPTION =
    'Store one thing this project should still know in a month. Call it when this turn established '
    + 'something a later turn would otherwise get wrong, and only then. '
    + 'Worth remembering: a preference or correction the user stated; a decision together with the '
    + 'option it rejected and why, because the code only ever shows the winner; a deliberate '
    + 'exception somebody would helpfully undo; a fact about this machine, project or toolchain '
    + 'that took real work to establish. '
    + 'Never worth remembering: anything the files, the git history or the project instructions '
    + 'already say; anything true only right now, like a test passing or a game running clean; an '
    + 'account of what you just did; something you already knew before you opened this project; a '
    + 'turn where nothing was decided or built. When in doubt, do not. An unnecessary memory is '
    + 'read by every later turn and costs more than the one you skipped. '
    + 'Write one fact per call, in a sentence or two that still reads true to somebody who was not '
    + 'here — no "I", no "we then", no reference to this conversation. The user is shown it and '
    + 'decides whether to keep it, so it does not reach any later turn until they do. Do not ask '
    + 'them about it and do not store the same thing twice.'

const PARAMETERS = {
    type: 'object',
    properties: {
        kind: {
            type: 'string',
            enum: MEMORY_KINDS,
            description:
                'decision — a choice made and the one turned down. preference — how the user wants '
                + 'things done. fact — something established about this project or machine. '
                + 'issue — a known problem nobody has fixed yet.'
        },
        content: {
            type: 'string',
            description:
                'The fact itself, self-contained, one or two sentences. Name the file or setting it '
                + 'is about so it can be checked later. A decision says what was rejected and why.'
        },
        why: {
            type: 'string',
            description: 'One sentence on what a later turn gets wrong without this.'
        }
    },
    required: ['kind', 'content']
}

export function createRememberTool({host}) {
    return {
        name: REMEMBER_TOOL_NAME,
        label: 'remember',
        description: DESCRIPTION,
        parameters: PARAMETERS,
        execute: async (toolCallId, params, signal) => {
            const given = params ?? {}
            if (given.probe === true) {
                await host.call(REMEMBER_TOOL_NAME, {probe: true}, signal)
                return {content: [{type: 'text', text: REMEMBER_PROBE_ANSWER}]}
            }
            const stored = await host.call(
                REMEMBER_TOOL_NAME,
                {kind: given.kind, content: given.content, callId: toolCallId},
                signal
            )
            return {
                content: [{type: 'text', text: String(stored?.stored ?? 'Stored.')}],
                details: {memoryId: stored?.memoryId}
            }
        }
    }
}
