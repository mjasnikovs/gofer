export const ASK_USER_TOOL_NAME = 'ask_user'

export const ASK_PROBE_ANSWER = 'ask-user-reachable'

const COMMON_DESCRIPTION =
    'Ask the user one question and wait for their answer. Use it ONLY for something you cannot '
    + 'settle any other way and that changes what you build: which of two designs they want, whether '
    + 'to keep or replace something that already exists, a trade-off only they can weigh. '
    + 'Read the project first — a question whose answer is in the files is a question you should not '
    + 'have asked. Never ask about naming, formatting, or anything you could reasonably decide and '
    + 'mention afterwards. Ask one thing at a time, in one sentence, and offer the two realistic '
    + 'answers so they can pick rather than compose. If they skip it, decide it yourself and say '
    + 'which way you went — do not ask again.'

const DELEGATING_DESCRIPTION =
    `${COMMON_DESCRIPTION} `
    + 'When the answer is a LAYOUT — where something sits, how big it is, what is next to what — '
    + 'send a `brief` as well. A sentence describing a layout and the layout itself are not the same '
    + 'object, and the user cannot correct one they have to build in their head. With a brief, a '
    + 'designer drafts the layout, puts it in front of them, reads what they say and revises it until '
    + 'they agree it, and you are handed the agreed layout written down: the regions, where each '
    + 'sits, its size and the spacing between them. That is what you build from. You never write the '
    + 'markup and you never see the drafts. Send a brief only for a layout nobody has settled yet — '
    + 'not to confirm one that is already decided, and not to ask one question about one measurement.'

const DRAFTING_DESCRIPTION =
    `${COMMON_DESCRIPTION} `
    + 'When the question is about a LAYOUT, send sketches with it. A sentence describing a layout and '
    + 'the layout itself are not the same object, and the user cannot correct one they have to build '
    + 'in their head.'

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

const SKETCHES_PARAMETER = {
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
}

const BRIEF_PARAMETER = {
    type: 'string',
    description:
        'Send this instead of asking about a layout yourself, and a designer agrees it with the '
        + 'user for you. One paragraph, self-contained: what is being designed, the scene or screen '
        + 'it belongs to, everything that must appear on it, and any constraint already decided — '
        + 'the target resolution, an existing style, a control that has to stay where it is. The '
        + 'designer cannot see this conversation. Leave it out for every ordinary question.'
}

function parametersFor(delegating) {
    return {
        type: 'object',
        properties: {
            question: {
                type: 'string',
                description:
                    'The one thing you want decided, as a single sentence the user can answer '
                    + 'without reading the rest of the conversation.'
                    + (delegating ?
                        ' With a brief, this is what the designer is being asked to settle, and it '
                        + 'is what the user sees while the drafts are being made.'
                    :   '')
            },
            options: {
                type: 'array',
                items: {type: 'string'},
                description:
                    'The realistic answers, best first. Shortcuts, not a closed set — the user '
                    + 'can always write something else. Two is usually right.'
            },
            ...(delegating ? {brief: BRIEF_PARAMETER} : {sketches: SKETCHES_PARAMETER}),
            questionId: {
                type: 'string',
                description:
                    'Leave this out the first time. To ask again about the same thing — a revised '
                    + 'layout, or the same decision narrowed down — send the id that call came back '
                    + 'with. The user sees one thing changing rather than a pile of questions, and '
                    + 'you are told which revision they are on.'
            },
            why: {
                type: 'string',
                description: 'One sentence on what turns on the answer.'
            }
        },
        required: ['question']
    }
}

const SKIPPED =
    'The user chose not to decide this. Make the call yourself and say which way you went. Do not '
    + 'ask again.'

export const APPROVED =
    'The user ended the design here: this layout is agreed and there is nothing left to decide. '
    + 'Write the agreement down now. Do not show them anything else and do not ask them anything '
    + 'else.'

function again(questionId) {
    return (
        'They are NOT finished with this. Ask them again about the same decision once you have '
        + `acted on what they just said, and send questionId ${String(questionId ?? '')} with it so `
        + 'they see one thing changing rather than a pile of cards. Send the identifier exactly as '
        + 'written here, with no quotation marks around it. Do not carry on to anything else and do '
        + 'not treat this as settled.'
    )
}

const BOTH_SENT =
    'ask_user was sent a brief AND sketches. They are two different asks: a brief hands the layout '
    + 'to a designer who draws it with the user, and sketches are markup you drew yourself. Send one '
    + 'of them.'

const BRIEF_HERE =
    'ask_user does not take a brief here. You are the one drawing: send `sketches` with the markup '
    + 'you drew, and ask the user about them.'

const SKETCHES_HERE =
    'ask_user does not take sketches here. Do not write the markup yourself: send a `brief` saying '
    + 'what the layout is for, and it is drawn and agreed with the user for you.'

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

function unresolvedLine(unresolved) {
    if (!Array.isArray(unresolved) || unresolved.length === 0) return ''
    return (
        `\n\nThese project files did not go into the sketch: ${unresolved.join('; ')}. `
        + 'Check the path against the project before you use it again.'
    )
}

export function answerText(answer, {inDesign = false} = {}) {
    const trailing = unresolvedLine(answer?.unresolved) + blockedLine(answer?.blocked)
    if (answer?.skipped === true) return SKIPPED + trailing

    const said = String(answer?.answer ?? '').trim()
    const parts = []
    if (answer?.picked) {
        const {index, label} = answer.picked
        parts.push(`The user picked "${String(label)}" (sketch ${String(Number(index) + 1)}).`)
    }
    if (said) parts.push(`They said: "${said}".`)
    if (answer?.approved === true) parts.push(APPROVED)
    else if (answer?.again === true) parts.push(again(answer?.questionId))
    else if (answer?.picked && !said && inDesign)
        parts.push(
            'That is which one they prefer, not the end of the design. They end it by pressing the '
                + 'button that agrees it, and they have not. Improve this one and show it to them '
                + 'again.'
        )
    else if (answer?.picked && !said)
        parts.push(
            'They chose it and said nothing else, so that is the whole answer. Build it. Do not ask '
                + 'them to justify it and do not ask again.'
        )
    else if (answer?.picked || said)
        parts.push(
            `If you ask them anything else about this same decision — a narrower question, or a `
                + `revised layout — send questionId ${String(answer?.questionId ?? '')} with it `
                + 'rather than asking as a new question. They see one thing changing rather than a '
                + 'pile of cards. Send the identifier exactly as written here, with no quotation '
                + 'marks around it.'
        )
    if (parts.length === 0) parts.push('The user answered with nothing at all.')
    return parts.join(' ') + trailing
}

export function createAskUserTool({host, ownerCallId, delegate, agreed}) {
    const delegating = delegate !== undefined
    const inDesign = ownerCallId !== undefined
    if (agreed !== undefined) {
        delete agreed.label
        delete agreed.html
        delete agreed.approved
        delete agreed.rounds
    }
    return {
        name: ASK_USER_TOOL_NAME,
        label: 'ask the user',
        description: delegating ? DELEGATING_DESCRIPTION : DRAFTING_DESCRIPTION,
        parameters: parametersFor(delegating),
        execute: async (toolCallId, params, signal, onUpdate) => {
            const given = params ?? {}
            const probing = given.probe === true
            const {ownerCallId: _sent, ...rest} = given
            const owner = ownerCallId ?? toolCallId

            if (probing) {
                await host.call(ASK_USER_TOOL_NAME, {probe: true}, signal)
                const drafted =
                    delegate ?
                        await delegate({ownerCallId: owner, signal, onUpdate, probing: true})
                    :   undefined
                return {
                    content: [
                        {
                            type: 'text',
                            text: [ASK_PROBE_ANSWER, drafted?.text].filter(Boolean).join(' ')
                        }
                    ]
                }
            }

            const brief = typeof rest.brief === 'string' ? rest.brief.trim() : ''
            const drewItself = Array.isArray(rest.sketches) && rest.sketches.length > 0
            if (brief !== '' && drewItself) throw new Error(BOTH_SENT)
            if (delegating && drewItself) throw new Error(SKETCHES_HERE)
            if (!delegating && brief !== '') throw new Error(BRIEF_HERE)
            if (brief !== '') {
                const {text, details} = await delegate({
                    ownerCallId: owner,
                    brief,
                    signal,
                    onUpdate
                })
                return {content: [{type: 'text', text}], details}
            }

            const request = {...rest, ownerCallId: owner, ...(inDesign && {isDelegated: true})}
            const answer = await host.call(ASK_USER_TOOL_NAME, request, signal)
            if (agreed !== undefined) {
                agreed.rounds = (agreed.rounds ?? 0) + 1
                if (agreed.approved === true) return answered(answer, {inDesign})
                if (answer?.sketch?.html) {
                    agreed.label = answer.sketch.label
                    agreed.html = answer.sketch.html
                }
                if (answer?.approved === true) agreed.approved = true
            }
            return answered(answer, {inDesign})
        }
    }
}

function answered(answer, {inDesign}) {
    return {
        content: [{type: 'text', text: answerText(answer, {inDesign})}],
        details: {
            questionId: answer?.questionId,
            skipped: answer?.skipped === true,
            approved: answer?.approved === true,
            again: answer?.again === true
        }
    }
}
