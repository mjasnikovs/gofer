/**
 * Asking the user a question, from inside a turn.
 *
 * Gofer's agent has had no way to do this. It could refuse, it could guess, or it could write down an
 * assumption and carry on — and on a decision only the user can make, all three are the same outcome
 * with different wording. This is the fourth option.
 *
 * The tool is built here and answered in Rust, for the same reason the web search is: the thing that
 * answers it is over there. Rust holds the window, and a question with no window to appear in cannot
 * be asked at all.
 *
 * It is deliberately NOT a catalogue domain. The catalogue is the Godot domains — each with an addon
 * handler, an `ops` list and a generated parameter contract — and a question has none of those. It is
 * routed by name ahead of the catalogue, which is why the closed-catalogue test still says ten.
 *
 * The blocking happens on the Rust side, on the thread the backend already gives every tool call.
 * Nothing here waits: this hands the question over and the answer comes back as a tool result, so a
 * question a user takes ten minutes over costs the same as one they answer at once.
 */

export const ASK_USER_TOOL_NAME = 'ask_user'

/**
 * What the model is told about the tool.
 *
 * Most of it is about when NOT to use it, and that is on purpose. An agent that can ask will ask, and
 * a question the user has to stop and answer is the most expensive thing it can do to them — far
 * worse than reading three more files. So the description spends its length on the bar rather than on
 * the mechanics.
 */
const DESCRIPTION =
    'Ask the user one question and wait for their answer. Use it ONLY for something you cannot '
    + 'settle any other way and that changes what you build: which of two designs they want, whether '
    + 'to keep or replace something that already exists, a trade-off only they can weigh. '
    + 'Read the project first — a question whose answer is in the files is a question you should not '
    + 'have asked. Never ask about naming, formatting, or anything you could reasonably decide and '
    + 'mention afterwards. Ask one thing at a time, in one sentence, and offer the two realistic '
    + 'answers so they can pick rather than compose. If they skip it, decide it yourself and say '
    + 'which way you went — do not ask again.'

export function createAskUserTool({host}) {
    return {
        name: ASK_USER_TOOL_NAME,
        label: 'ask the user',
        description: DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                question: {
                    type: 'string',
                    description:
                        'The one thing you want decided, as a single sentence the user can answer '
                        + 'without reading the rest of the conversation.'
                },
                options: {
                    type: 'array',
                    items: {type: 'string'},
                    description:
                        'The realistic answers, best first. Shortcuts, not a closed set — the user '
                        + 'can always write something else. Two is usually right.'
                },
                why: {
                    type: 'string',
                    description: 'One sentence on what turns on the answer.'
                }
            },
            required: ['question']
        },
        execute: async (_toolCallId, params, signal) => {
            const answer = await host.call(ASK_USER_TOOL_NAME, params ?? {}, signal)
            // A skip is a real answer and is worded as one. Handed back as an empty string it reads
            // to the model as a tool that failed, and the next thing it does is ask again.
            const text =
                answer?.skipped === true ?
                    'The user chose not to decide this. Make the call yourself and say which way you '
                    + 'went. Do not ask again.'
                :   String(answer?.answer ?? '')
            return {content: [{type: 'text', text}], details: {skipped: answer?.skipped === true}}
        }
    }
}
