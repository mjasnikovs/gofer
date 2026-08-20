/**
 * Asking the user something, from inside a turn.
 *
 * Gofer's agent has had no way to do this. It could refuse, it could guess, or it could write down an
 * assumption and carry on — and on a decision only the user can make, all three are the same outcome
 * with different wording. This is the fourth option.
 *
 * A question may carry pictures. That is not a second feature bolted on: some decisions cannot be
 * put into a sentence at all. "Where does the health bar sit" described in prose asks the user to
 * build the layout in their head before they can correct it, and they will not. So the question
 * carries sketches when it needs to and carries none when it does not, which is most of the time.
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
    + 'which way you went — do not ask again. '
    + 'When the question is about a LAYOUT — where something sits, how big it is, what is next to '
    + 'what — send sketches with it. A sentence describing a layout and the layout itself are not '
    + 'the same object, and the user cannot correct one they have to build in their head.'

/**
 * The one stylesheet Gofer puts in front of the model's own.
 *
 * A reset and nothing else, on purpose. A pause menu for a game has to be free to look like a game,
 * and injecting this application's palette would mean judging every sketch against how well it
 * imitates a developer tool. What the model writes is what the user sees.
 */
export const SKETCH_RESET =
    '*,*::before,*::after{box-sizing:border-box}'
    + 'html,body{margin:0;padding:0;height:100%}'
    + 'img,svg{max-width:100%;display:block}'
    + 'html,body{overflow:hidden}'

const HTML_RULES =
    'One self-contained HTML fragment. Inline <style> blocks and style= attributes work. '
    + 'Nothing script-shaped runs and nothing remote loads: no <script>, no onclick, no external '
    + 'stylesheet, font or image. Anything you reference that could not load is named back to you '
    + 'in the answer, so read that before deciding the user disliked your layout. '
    + "Use the project's own artwork. A `res://` path — the same one you would write in Godot — is "
    + 'read out of the project and put into the page for you, so '
    + '`@font-face{src:url(res://fonts/Title.ttf)}` and `<img src="res://ui/hero.png">` both work. '
    + 'Prefer that over a web font or a drawn approximation: the user is judging how this looks in '
    + 'their game. Pictures and fonts only, half a megabyte each. '
    + 'Draw the layout at 1280 by 720. It is shrunk to fit the window, so anything smaller is '
    + 'judged blown up and anything larger is judged shrunk twice.'

const PARAMETERS = {
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
        sketches: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            description:
                'Leave this out for an ordinary question. One entry shows a single layout. Two or '
                + 'three put alternatives side by side so the user can pick rather than describe; '
                + 'only send more than one when they differ in a way a person sees at a glance.',
            items: {
                type: 'object',
                properties: {
                    label: {
                        type: 'string',
                        description:
                            'Two or three words naming what makes this one different, shown above '
                            + 'it. "Bar across the top", not "Option A".'
                    },
                    html: {type: 'string', description: HTML_RULES}
                },
                required: ['label', 'html']
            }
        },
        questionId: {
            type: 'string',
            description:
                'Leave this out the first time. To ask again about the same thing — a revised '
                + 'layout, or the same decision narrowed down — send the id that call came back '
                + 'with. The user sees one thing changing rather than a pile of questions, and you '
                + 'are told which revision they are on.'
        },
        why: {
            type: 'string',
            description: 'One sentence on what turns on the answer.'
        }
    },
    required: ['question']
}

/** A skip is a decision and is worded as one, so the model does not read it as a failed tool. */
const SKIPPED =
    'The user chose not to decide this. Make the call yourself and say which way you went. Do not '
    + 'ask again.'

/** What the model is told when a child has interrupted the user as often as it may. */
export const BUDGET_SPENT =
    'You have asked the user everything you are allowed to ask them in this delegation. Write your '
    + 'answer now, from what they have already told you. Do not ask anything else.'

/**
 * What the policy refused while a sketch was on screen, in a sentence the model can act on.
 *
 * In the text and not only in `details`, because the model reads content parts and nothing else. A
 * blocked webfont that is recorded but never said is a sketch that rendered in the wrong typeface
 * for a reason nobody in the loop can see — least of all the model, which has no console in there.
 */
function blockedLine(blocked) {
    if (!Array.isArray(blocked) || blocked.length === 0) return ''
    const named = blocked.slice(0, 5).join(', ')
    const rest = blocked.length > 5 ? ` and ${String(blocked.length - 5)} more` : ''
    return (
        `\n\nThe sketch asked for ${named}${rest}, and the policy refused ${
            blocked.length === 1 ? 'it' : 'them'
        }. Nothing remote loads. Inline the styling, or use a res:// path for a file that is in the `
        + 'project.'
    )
}

/**
 * The project files a sketch named and did not get, and why each one.
 *
 * Separate from `blocked`, which is the policy refusing something remote. This one is the model
 * naming a file in its own project that is not there, or is too big, or is not a picture — a
 * different mistake with a different fix, and worth saying which.
 */
function unresolvedLine(unresolved) {
    if (!Array.isArray(unresolved) || unresolved.length === 0) return ''
    return (
        `\n\nThese project files did not go into the sketch: ${unresolved.join('; ')}. `
        + 'Check the path against the project before you use it again.'
    )
}

/** Everything that came back, as one paragraph: the verdict first, then the detail. */
export function answerText(answer) {
    const trailing = unresolvedLine(answer?.unresolved) + blockedLine(answer?.blocked)
    if (answer?.skipped === true) return SKIPPED + trailing

    const said = String(answer?.answer ?? '').trim()
    const parts = []
    if (answer?.picked) {
        const {index, label} = answer.picked
        parts.push(`The user picked "${String(label)}" (sketch ${String(Number(index) + 1)}).`)
    }
    if (said) parts.push(`They said: "${said}".`)
    // A pick with nothing written is a whole answer, and it is the end of the matter. Left to speak
    // for itself it reads as half of one, and the next thing the model does is ask the user to
    // justify a choice they have already made.
    if (answer?.picked && !said)
        parts.push(
            'They chose it and said nothing else, so that is the whole answer. Build it. Do not ask '
                + 'them to justify it and do not ask again.'
        )
    // Words about a sketch are a change to it, and a changed layout is the same question again.
    else if (answer?.picked || (said && Number(answer?.sketches) > 0))
        parts.push(
            `If you show them a revision, ask under questionId "${String(answer?.questionId ?? '')}" `
                + 'rather than as a new question.'
        )
    if (parts.length === 0) parts.push('The user answered with nothing at all.')
    return parts.join(' ') + trailing
}

/**
 * @param host the tool channel back to Rust, which holds the window
 * @param budget how many times this holder may interrupt the user, or `undefined` for no ceiling
 * @param sketchesRequired refuse a question with no sketches, for a holder that may only show things
 *
 * The budget is a number rather than a name because the two catch different failures. A tool list
 * catches a tool that appeared; nothing in a tool list catches a tool used ninety times, which is
 * what a delegated child with twenty-four steps and a modal can do to somebody. Over budget the tool
 * *answers* rather than throwing: a throw reads to the model as a fault worth retrying, and an
 * answer telling it to wrap up is the thing it should actually do.
 */
export function createAskUserTool({host, budget, sketchesRequired = false}) {
    let asked = 0
    return {
        name: ASK_USER_TOOL_NAME,
        label: 'ask the user',
        description: DESCRIPTION,
        parameters: PARAMETERS,
        execute: async (_toolCallId, params, signal) => {
            const request = params ?? {}
            if (request.probe !== true) {
                if (sketchesRequired && !(request.sketches?.length > 0))
                    throw new Error(
                        'Here you may only put a layout in front of the user, so every question '
                            + 'needs sketches with it. Decide anything else yourself.'
                    )
                if (budget !== undefined && asked >= budget)
                    return {content: [{type: 'text', text: BUDGET_SPENT}], details: {spent: true}}
                asked += 1
            }
            const answer = await host.call(ASK_USER_TOOL_NAME, request, signal)
            return {
                content: [{type: 'text', text: answerText(answer)}],
                details: {
                    questionId: answer?.questionId,
                    skipped: answer?.skipped === true,
                    approved: answer?.approved === true
                }
            }
        }
    }
}
