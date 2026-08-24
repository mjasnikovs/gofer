/**
 * Asking the user something, from inside a turn.
 *
 * Gofer's agent has had no way to do this. It could refuse, it could guess, or it could write down an
 * assumption and carry on — and on a decision only the user can make, all three are the same outcome
 * with different wording. This is the fourth option.
 *
 * A question may be about a LAYOUT, and that is not a second feature bolted on: some decisions cannot
 * be put into a sentence at all. "Where does the health bar sit" described in prose asks the user to
 * build the layout in their head before they can correct it, and they will not. So a layout question
 * is drawn rather than written — and it is drawn by a child, because agreeing a layout takes a draft,
 * a reaction, a revision and another reaction, and every one of those in the parent's own transcript
 * is a full copy of the markup.
 *
 * That is the whole of the split. One tool, two shapes of the same tool, chosen by whether the call
 * carries a `brief`:
 *
 *   - no brief — the question goes straight to the window and the answer comes back;
 *   - a brief  — the question goes to a child that drafts, shows, reads and revises, and the parent
 *                is handed what was agreed.
 *
 * The child holds this same tool, built from the same factory, with the drafting half of the schema
 * instead of the delegating half. So there is no line for a model to draw between "one question" and
 * "a design", and no call that can carry both.
 *
 * The tool is answered in Rust, for the same reason the web search is: the thing that answers it is
 * over there. Rust holds the window, and a question with no window to appear in cannot be asked.
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

/** What the probe proves: the backend routes the question, and a delegate can be built and run. */
export const ASK_PROBE_ANSWER = 'ask-user-reachable'

/**
 * What the model is told about the tool.
 *
 * Most of it is about when NOT to use it, and that is on purpose. An agent that can ask will ask, and
 * a question the user has to stop and answer is the most expensive thing it can do to them — far
 * worse than reading three more files. So the description spends its length on the bar rather than on
 * the mechanics.
 *
 * The last paragraph differs by which copy of the tool this is, and that is the only difference the
 * model ever sees. The parent is told to hand a layout over; the child is told to draw one. Neither
 * is told about the other's parameter, because neither has it.
 */
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

/**
 * The schema, which half of it depends on which copy of the tool this is.
 *
 * One factory, two schemas, no overlap. The delegating copy — the parent's — carries `brief` and no
 * `sketches`; the drafting copy — the child's — carries `sketches` and no `brief`. So the model is
 * never offered both, there is no line for it to draw between them, and the only call that can carry
 * both is one that invented a parameter, which is refused below.
 */
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

/** A skip is a decision and is worded as one, so the model does not read it as a failed tool. */
const SKIPPED =
    'The user chose not to decide this. Make the call yourself and say which way you went. Do not '
    + 'ask again.'

/**
 * What the model is told when the user pressed the button that ends a delegation.
 *
 * The wording is only half of it. The child's loop is closed at the same moment — see `stopWhen` in
 * `ai-subagent.mjs` — so a model that reads this and asks anyway gets one more request to write its
 * answer in and then nothing. Nothing in this codebase relies on a sentence to stop a model from
 * doing something it can still do.
 */
export const APPROVED =
    'The user ended the design here: this layout is agreed and there is nothing left to decide. '
    + 'Write the agreement down now. Do not show them anything else and do not ask them anything '
    + 'else.'

/**
 * What the model is told when the user pressed the button asking for another round.
 *
 * The middle of the three endings, and the one the user has to be able to reach for ANY question.
 * A model reads an answer and decides for itself whether to come back; this is the user saying they
 * expect it to, which is not a thing they could say before without hoping the model inferred it.
 *
 * Loud, because it is competing with the model's own judgement that the answer was enough.
 *
 * It names the identifier itself rather than saying "the same questionId", and that is not a
 * flourish. This branch comes before the one that used to name it, so for one build the model was
 * told to ask again under an identifier nothing had given it — and every revision of a design landed
 * as a fresh card, which is the pile this seam replaced a modal to remove. Measured in the real
 * window: two rounds, no round badge on either.
 */
function again(questionId) {
    return (
        'They are NOT finished with this. Ask them again about the same decision once you have '
        + `acted on what they just said, and send questionId ${String(questionId ?? '')} with it so `
        + 'they see one thing changing rather than a pile of cards. Send the identifier exactly as '
        + 'written here, with no quotation marks around it. Do not carry on to anything else and do '
        + 'not treat this as settled.'
    )
}

/** Refused rather than guessed at: the two halves of the schema are never both right. */
const BOTH_SENT =
    'ask_user was sent a brief AND sketches. They are two different asks: a brief hands the layout '
    + 'to a designer who draws it with the user, and sketches are markup you drew yourself. Send one '
    + 'of them.'

/** The child has no delegating half, and a child that tried to hand the work on is told so. */
const BRIEF_HERE =
    'ask_user does not take a brief here. You are the one drawing: send `sketches` with the markup '
    + 'you drew, and ask the user about them.'

/** The parent has no drafting half, and a parent that tried to draw is told where to send it. */
const SKETCHES_HERE =
    'ask_user does not take sketches here. Do not write the markup yourself: send a `brief` saying '
    + 'what the layout is for, and it is drawn and agreed with the user for you.'

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

/**
 * Everything that came back, as one paragraph: the verdict first, then the detail.
 *
 * `inDesign` is the difference between a question and a round of a delegation. Outside one a pick
 * with no words is the whole answer, because there is nothing else the user could press. Inside one
 * there is: the button that ends the delegation. So the same click means "this one, carry on" there,
 * and reading it as the end is how a loop nobody agreed to came back saying it was agreed.
 */
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
    // A pick with nothing written is a whole answer, and it is the end of the matter. Left to speak
    // for itself it reads as half of one, and the next thing the model does is ask the user to
    // justify a choice they have already made.
    // Checked before either of the two below, because both of them ask for another round and this
    // is the user saying there is not going to be one. Words alongside it are the last note on a
    // layout that is already agreed, not a change to make.
    if (answer?.approved === true) parts.push(APPROVED)
    // Before every branch below, because all of them are the model deciding what happens next and
    // this is the user having decided it for them.
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
    // Anything the user wrote may be the middle of a decision rather than the end of one, and asking
    // again about it is the same question, not a new one.
    //
    // This used to be told only to a model that had shown a sketch, and that was the whole of the
    // old split leaking back in: a layout could be refined and a question could not. It is the same
    // block either way — one tool call, one card, a round counter on it — and a follow-up asked as a
    // NEW question is the pile of unrelated cards this seam replaced a modal to remove.
    //
    // The identifier is written bare. Quoted, the real model copied the quotation marks into the
    // parameter — `"question-1"` rather than `question-1` — which is a different identifier, so the
    // revision counter started again at one and the card stopped saying which round it was on. The
    // reader trims them too; this is the half that stops it happening.
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

/**
 * @param host the tool channel back to Rust, which holds the window
 * @param ownerCallId the tool call the questions belong to, for a copy built inside a delegation
 * @param delegate hands a brief to a child that draws and iterates, for the parent's copy
 * @param agreed the record a delegation reads its ending off, filled in round by round
 *
 * `ownerCallId` is the one link between a tool call and the questions it produces, and it is put on
 * the request here rather than left to the model, and for a reason the design session it replaces
 * learned the hard way. It tells the window which block in the feed a question belongs to, so a delegation's rounds
 * render as one card being revised rather than a pile of unrelated questions. A model asked to
 * remember to send it would forget on the round that mattered.
 *
 * A copy built without one uses its own call id, which is the same link drawn one step shorter: an
 * ordinary question belongs to the call that asked it. A copy built *with* one is a child's, and it
 * carries the PARENT's call id — that is what makes several rounds render as one block.
 */
export function createAskUserTool({host, ownerCallId, delegate, agreed}) {
    const delegating = delegate !== undefined
    // A copy built for a child of a delegation. Its questions carry the button that ends one, and a
    // pick inside one means "this one, carry on" rather than "we are done".
    const inDesign = ownerCallId !== undefined
    // Cleared as the tool is built, which is once per attempt. A delegation that showed a sketch and
    // then died on a stream timeout is retried from nothing, and the record has to start from
    // nothing with it — otherwise the retry hands back a layout from a run the user's final answer
    // never saw.
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
            // The owner is ours, not the model's. Written over what was sent under that name, the
            // way the design session was: the word is in nothing the model reads, and forwarding a
            // model's guess at it would attach a question to somebody else's card.
            const {ownerCallId: _sent, ...rest} = given
            const owner = ownerCallId ?? toolCallId

            // Both halves, because both can be absent for their own reason: the backend may not
            // route the name, and the child may not build. Answered before the turn starts, where
            // the reason can be read, rather than mid-design with the user waiting on it.
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
            // The mirror of the line above, and it is the one that used to be missing. `brief` is
            // absent from the child's schema, which is not the same as absent from what a model
            // sends: unguarded, a child that wrote one reached `await delegate(...)` with nothing
            // there and got `delegate is not a function` as its tool result.
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
            // The drawing the user reacted to, kept for whoever built this tool rather than put in
            // front of the model that drew it. Overwritten every round, so what is left at the end
            // is the last layout the user saw — which, when they ended the loop, is the agreed one.
            if (agreed !== undefined) {
                // Counted whatever came back, including a skip. It is the delegation's only way to
                // know the user was ever in the room: a child that answered without asking anybody
                // leaves this at zero, and an agreement nobody was shown is the one thing that must
                // not be handed back as agreed.
                agreed.rounds = (agreed.rounds ?? 0) + 1
                // Nothing after an approval changes what was approved. The loop is closed in front
                // of the provider rather than under it, so the child gets one more request — and a
                // child that asks in it is answered by a user who has already finished. Without this
                // guard that answer's sketch overwrote the agreed one, and the layout handed back
                // under "This is the layout they agreed" was one they never saw agreed. Parallel
                // tool execution reaches the same interleaving by a shorter route.
                if (agreed.approved === true) return answered(answer, {inDesign})
                if (answer?.sketch?.html) {
                    agreed.label = answer.sketch.label
                    agreed.html = answer.sketch.html
                }
                // Set after the markup and on its own. It is what closes the child's loop, and a
                // child that ended a delegation on a question with no sketch in it has still been
                // ended.
                if (answer?.approved === true) agreed.approved = true
            }
            return answered(answer, {inDesign})
        }
    }
}

/** One answer, as the tool result the model reads and the details the row keeps. */
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
