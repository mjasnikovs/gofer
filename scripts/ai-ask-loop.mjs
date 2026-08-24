/**
 * The delegating half of `ask_user`: agreeing a layout with the user, in a child.
 *
 * A question in words is one call to the window and one answer. Agreeing a *layout* takes more than
 * one: a draft, a reaction, a revision, another reaction. Run in the parent's own turn that costs the
 * transcript a full copy of the markup on every round, and the fourth revision of a pause menu pushes
 * the work that asked for it out of the context window.
 *
 * So the loop runs in a child, the same seam `web_fetch` uses for the same reason: the child holds
 * every draft and the parent is handed only what was agreed, in words. That is also why the child's
 * deliverable is specified so tightly below — a child that answers with the HTML has moved the
 * problem rather than solved it, and `cutAnswer` would truncate it mid-tag anyway.
 *
 * Nothing here is a tool the model holds. `ask_user` is the only tool, and it reaches this when the
 * call carries a `brief`. The child's own copy of `ask_user` is the drafting half of the same
 * factory: it is the only copy that can put markup in front of anybody.
 *
 * The child is the only agent in this codebase allowed to interrupt the user. It is not rationed —
 * if it needs to ask, it asks — and it is ended by the user pressing the button on the card, which
 * closes its loop rather than merely discouraging it. See `stopWhen` in `ai-subagent.mjs`.
 */

import {modelReadsImages} from './agent-runtime.mjs'
import {
    DESIGN_TOOL_NAMES,
    PROBE_PROMPT,
    cannedModels,
    runSubagent,
    toolProgress,
    usageFooter
} from './ai-subagent.mjs'

/** What the probe proves: the child builds, holds `ask_user`, runs a turn and answers. */
export const ASK_LOOP_PROBE_ANSWER = 'ask-loop-reachable'

/**
 * The child's contract.
 *
 * Three things it has to be told and would otherwise get wrong. It must draft before it shows, or
 * the first card the user sees is an empty one. It must revise under the same `questionId`, or the
 * user is asked to compare a layout against one that is no longer on screen. And its answer must be
 * the agreement in words — because the parent's whole reason for delegating is not to hold the
 * markup, and an answer holding the markup is an answer that gets cut in half on the way back.
 */
export const DESIGN_SYSTEM_PROMPT =
    'You are a design sub-agent. Another agent, working in this same checkout, has asked you to '
    + 'agree a layout with the user. It will see nothing you see — only what you write in your '
    + 'final message.\n'
    + '\n'
    + 'You can read files, run shell commands, and talk to the user with ask_user. A question about '
    + 'the layout carries sketches: draw it, do not describe it. Anything you can settle by reading '
    + 'the project, settle yourself. You cannot change anything: you have no write tool, no edit '
    + 'tool and no access to the Godot editor.\n'
    + '\n'
    + 'Any pictures beside this brief are the ones the user attached to the ask. They are what is '
    + 'there now, or what they want it to look like. Read them before you draft.\n'
    + '\n'
    + 'How to work:\n'
    + '1. Read enough of the project to know what this layout belongs to. Be quick about it.\n'
    + '2. Draft the layout as HTML and ask about it. When there is a real choice to make, show two or '
    + 'three variants that differ in a way a person sees at a glance.\n'
    + '3. Read what they say back. Revise, and ask again under the SAME questionId you were '
    + 'given, so they see one layout changing rather than a pile of them.\n'
    + '4. There is ONE ending: they press the button that says the design is agreed. Until they '
    + 'do you are not finished — picking a sketch, praising one, or saying nothing are the middle '
    + 'of the design, not the end of it. Keep revising and showing until they press it. Never decide '
    + 'on their behalf that it is agreed.\n'
    + '\n'
    + 'Your final message is the agreement, written down, and nothing else. Name each region, say '
    + 'where it is anchored, how big it is, and how much space is around it. Give the type sizes and '
    + 'the order things are read in. State what the user chose and, where they rejected something, '
    + 'what they rejected — the agent that asked has to build this and must not re-open a decision '
    + 'that is already made. Do NOT paste the HTML, and do not describe how you got there.'

/**
 * The layout that was agreed, drawn, appended to the agreement written down.
 *
 * The child is told not to paste its markup and that stays right: it would spend the child's own
 * output on it, on the round it should be summarising, and `cutAnswer` would truncate it mid-tag.
 * This is the same drawing arriving the other way — copied by the tool, after the answer is whole,
 * from what the window already had. Nothing is retyped and nothing can be cut in half.
 *
 * It is here because prose was not enough. A description of a dock — seven tiles, a cap column, the
 * gaps between them — reads as complete and still leaves the builder guessing at what the user
 * actually looked at, and the first build off one came back "close, but not really".
 *
 * Only on an approval, and that is the whole of the rule. Every other ending — a loop the user walked
 * away from, a child that gave up, a child out of steps — leaves behind a last sketch they did not
 * agree to and may have rejected in as many words. Appended anyway, under a sentence saying they
 * agreed it, it is the one layout they turned down arriving as the one to build.
 *
 * What bounds it is `MAX_SKETCH_CHARS` in `src-tauri/src/ask.rs`, which refuses a sketch over eight
 * thousand characters before it is ever shown. Not `maxAnswerChars`, which cut the child's words
 * before this was added to them — and deliberately not re-cut here, because half a layout is worse to
 * build from than none. The markup is the model's own, not the copy the window inlined the project's
 * artwork into: that one is eighty kilobytes of base64 saying nothing.
 */
export function agreedSketch({label, html, approved}) {
    if (approved !== true || typeof html !== 'string' || html === '') return ''
    return (
        `\n\nThis is the layout they agreed, as it was drawn for them${
            label ? ` ("${label}")` : ''
        }. It is a picture of the result, not code to port: build it with the project's own nodes, `
        + 'and read it for what sits where, how big each region is and what the spacing is.\n\n'
        + `${html}`
    )
}

/**
 * Said first when the user never ended the design.
 *
 * The loop has exactly one ending that means agreement: the button on the card. Everything else is a
 * child that stopped — out of steps, out of patience, or because it decided on the user's behalf that
 * the last sketch was good enough. All three produce the same confident specification, and without
 * this line the parent reads it as a decision and tells the user they agreed to it. That is what
 * happened: a layout nobody approved came back as "agreed on a larger, readable squad list".
 *
 * Loud, and before the specification rather than after it. A caveat under a page of measurements is
 * a caveat nobody acts on.
 *
 * `rounds` is what catches the worst of the three: a child that wrote a specification without ever
 * putting anything in front of anybody. It counts every answer that came back, a skip included.
 */
export function notAgreed({rounds, approved}) {
    if (approved === true) return ''
    const shown =
        rounds > 0 ?
            `They were shown ${String(rounds)} round${rounds === 1 ? '' : 's'} and never pressed `
            + 'the button that ends a design.'
        :   'They were never shown anything at all: not one sketch reached them.'
    return (
        `THE USER DID NOT AGREE THIS. ${shown} What follows is a proposal, not a decision. Say so `
        + 'in your own words before you do anything with it, do not tell them it was agreed, and '
        + 'show it to them yourself with ask_user before you build it.\n\n'
    )
}

/**
 * Said out loud when the child was designing blind.
 *
 * The brief's worker says the same thing on its own log, for the same reason: a layout drawn
 * without the screenshot it was asked about is wrong in a way only the person who attached the
 * screenshot can see. A silent drop is how this seam's first build failed, and a second silent drop
 * for a different reason would look exactly like the first.
 */
export function blindTo(images, model) {
    if (images.length === 0 || modelReadsImages(model)) return ''
    return (
        `\n\nThe ${String(images.length)} picture${images.length === 1 ? '' : 's'} attached to the `
        + `ask never reached the design loop: ${model.name || model.id} cannot read one. This `
        + 'layout was agreed from the project files alone, so say so before you build it.'
    )
}

/**
 * @param host the tool channel back to Rust, which holds the window the sketches appear in
 * @param images the pictures the user attached to the message that started this turn
 *
 * Everything else is the parent's own — one provider, one connection, one model per session — for
 * the reason `createSubagentTool` gives: a second of any of them is a second thing to configure, to
 * fail, and to disagree with the settings page.
 *
 * The images are not optional and are not decoration. A design brief is written about something the
 * user can see, and for the first build it was something only the *parent* could see: the screenshot
 * went into the parent's context and the child was handed a sentence saying "the provided
 * screenshot", with nothing provided. It then drew from the project files alone, and what came back
 * was close and not right.
 */
export function createAskDelegate({
    workspacePath,
    models,
    model,
    thinkingLevel,
    streamOptions,
    settings,
    timers,
    host,
    images = []
}) {
    return async ({ownerCallId, brief, signal, onUpdate, probing = false}) => {
        // The probe carries none: it draws nothing and shows nobody. A child whose model has no eyes
        // drops them in `runSubagent`, which is where every caller's images pass.
        const pictures = probing ? [] : images
        // What the user agreed, filled in by the child's `ask_user` round by round. Read once, below.
        const agreed = {}
        const result = await runSubagent({
            prompt: probing ? PROBE_PROMPT : brief,
            images: pictures,
            systemPrompt: DESIGN_SYSTEM_PROMPT,
            toolNames: DESIGN_TOOL_NAMES,
            workspacePath,
            models: probing ? cannedModels(model, ASK_LOOP_PROBE_ANSWER) : models,
            model,
            thinkingLevel,
            streamOptions,
            settings,
            timers,
            signal,
            progress: toolProgress(onUpdate),
            /*
             * The button on the card, as the thing that actually ends the loop.
             *
             * Deliberately NOT the abort signal. The agent loop never asks whether it has been
             * aborted, and the path that does fire throws `SubagentStopped`, which discards the
             * child's answer — so aborting a design would report a stopped turn instead of the
             * agreed layout. This is the shape the step ceiling already uses: the loop is closed in
             * front of the provider, after one more request, so the child writes its answer from
             * `APPROVED` and then stops cleanly and by itself.
             */
            stopWhen: () => agreed.approved === true,
            deps: {host, ownerCallId, agreed}
        })
        // Nothing wrapped around a probe. It proves the child answers; the endings below are about a
        // design somebody was actually shown.
        if (probing) return {text: result.text, details: {turns: result.turns}}
        return {
            text:
                `${notAgreed(agreed)}${result.text}${agreedSketch(agreed)}`
                + `${blindTo(pictures, model)}`
                + `\n\n${usageFooter(result, model)}`,
            details: {turns: result.turns, usage: result.usage}
        }
    }
}
