/**
 * Agreeing a layout with the user, without spending the parent's context on the drafts.
 *
 * `show_user` lets any agent put one sketch in front of somebody and read what they say back.
 * Agreeing a *layout* takes more than one: a draft, a reaction, a revision, another reaction. Run in
 * the parent's own turn that costs the transcript a full copy of the markup on every round, and the
 * fourth revision of a pause menu pushes the work that asked for it out of the context window.
 *
 * So the loop runs in a child, the same seam `web_fetch` uses for the same reason: the child holds
 * every draft and the parent is handed only what was agreed, in words. That is also why the child's
 * deliverable is specified so tightly below — a child that answers with the HTML has moved the
 * problem rather than solved it, and `cutAnswer` would truncate it mid-tag anyway.
 *
 * The child is the only one in this codebase allowed to interrupt the user, and it is rationed by a
 * count rather than trusted with a rule. See `REACHING_CHILD_TOOLS` in `ai-subagent.mjs`.
 */

import {
    boundsFrom,
    cannedModels,
    DESIGN_TOOL_NAMES,
    PROBE_PROMPT,
    readsImages,
    runSubagent,
    toolProgress,
    usageFooter
} from './ai-subagent.mjs'

export const DESIGN_TOOL_NAME = 'design_with_user'

/**
 * The host call that tells the window a design loop is running.
 *
 * Not a tool the model holds and not a catalogue domain — it takes no operations, has no addon
 * handler and nothing chooses to call it. It exists because the window needs to know that the next
 * few questions are one layout being revised rather than a queue of unrelated ones, and only the
 * thing that starts and ends the loop knows where its edges are.
 */
export const DESIGN_SESSION_TOOL_NAME = 'design_session'

/** What the probe proves: the child builds, holds `show_user`, runs a turn and answers. */
export const DESIGN_PROBE_ANSWER = 'design-loop-reachable'

/** Session identifiers, distinct within a process, which is as far as one ever travels. */
let sessions = 0
function nextSessionId() {
    sessions += 1
    return `design-${String(process.pid)}-${String(sessions)}`
}

/**
 * What the model is told about the tool.
 *
 * The bar is higher than `show_user`'s, because this one spends the user's attention several times
 * over rather than once. It is for the case where nobody yet knows what the thing should look like —
 * not for confirming a layout that has already been described.
 */
const DESCRIPTION =
    'Agree a layout with the user by drafting it, showing it to them, and revising it until they '
    + 'say it is right. Hand it a brief and it comes back with the agreed layout written down — the '
    + 'regions, where each sits, its size and the spacing between them — which is what you build '
    + 'from. Use it when nobody yet knows what the thing should look like and the user has to see '
    + 'options to decide. Do NOT use it to confirm a layout that is already settled, to ask one '
    + 'question about one measurement, or for anything that is not a layout: show_user shows one '
    + 'sketch, ask_user asks one question, and both are far cheaper. This stops the user several '
    + 'times, so do not start it without being asked for a design.'

/**
 * The child's contract.
 *
 * Three things it has to be told and would otherwise get wrong. It must draft before it shows, or
 * the first dialog the user sees is an empty one. It must revise under the same `questionId`, or the
 * user is asked to compare a layout against one that is no longer on screen. And its answer must be
 * the agreement in words — because the parent's whole reason for delegating is not to hold the
 * markup, and an answer holding the markup is an answer that gets cut in half on the way back.
 */
const DESIGN_SYSTEM_PROMPT =
    'You are a design sub-agent. Another agent, working in this same checkout, has asked you to '
    + 'agree a layout with the user. It will see nothing you see — only what you write in your '
    + 'final message.\n'
    + '\n'
    + 'You can read files, run shell commands, and put sketches in front of the user with '
    + 'ask_user. Every question you ask them must carry sketches; anything else you decide '
    + 'yourself. You '
    + 'cannot change anything: you have no write tool, no edit tool and no access to the Godot '
    + 'editor.\n'
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
    + 'of the design, not the end of it. Keep revising and showing until they press it, or until '
    + 'you are told you have no asks left. Never decide on their behalf that it is agreed. You may '
    + 'interrupt them only a few times, so do not spend one on a change you were already told to '
    + 'make.\n'
    + '\n'
    + 'Your final message is the agreement, written down, and nothing else. Name each region, say '
    + 'where it is anchored, how big it is, and how much space is around it. Give the type sizes and '
    + 'the order things are read in. State what the user chose and, where they rejected something, '
    + 'what they rejected — the agent that asked has to build this and must not re-open a decision '
    + 'that is already made. Do NOT paste the HTML, and do not describe how you got there.'

const PARAMETERS = {
    type: 'object',
    properties: {
        brief: {
            type: 'string',
            description:
                'What is being designed and what it has to hold, self-contained. Name the scene or '
                + 'screen it belongs to, everything that must appear on it, and any constraint '
                + 'already decided — the target resolution, an existing style, a control that has '
                + 'to stay where it is. It cannot see this conversation.'
        }
    },
    required: ['brief']
}

/**
 * Tells the window a loop started or finished, and never fails because of it.
 *
 * Swallowed on purpose, both ways. An announcement that did not arrive costs the card its held-open
 * state, and that is a worse-looking design loop; an announcement that threw would cost the design
 * itself. The close is the one that matters and it is the one most likely to be refused — a
 * cancelled turn rejects every call back to Rust, which is exactly when it is sent — so the window
 * closes its own card when the turn stops rather than trusting this to arrive.
 */
async function tellWindow(host, sessionId, state, signal) {
    if (sessionId === undefined) return
    try {
        await host.call(
            DESIGN_SESSION_TOOL_NAME,
            {sessionId, state},
            // The close is deliberately unsignalled: it is sent while unwinding, and the signal it
            // would be given is usually the one that caused the unwind.
            state === 'open' ? signal : undefined
        )
    } catch {
        // Nothing to do and nobody to tell. See above.
    }
}

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
 * Only on an approval, and that is the whole of the rule. Every other ending — a ration spent, a
 * loop the user walked away from, a child that gave up — leaves behind a last sketch they did not
 * agree to and may have rejected in as many words. Appended anyway, under a sentence saying they
 * agreed it, it is the one layout they turned down arriving as the one to build.
 *
 * What bounds it is `MAX_SKETCH_CHARS` in `src-tauri/src/ai_tools.rs`, which refuses a sketch over
 * eight thousand characters before it is ever shown. Not `maxAnswerChars`, which cut the child's
 * words before this was added to them — and deliberately not re-cut here, because half a layout is
 * worse to build from than none. The markup is the model's own, not the copy the window inlined the
 * project's artwork into: that one is eighty kilobytes of base64 saying nothing.
 */
function agreedSketch({label, html, approved}) {
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
 * child that stopped — out of ration, out of patience, or because it decided on the user's behalf
 * that the last sketch was good enough. All three produce the same confident specification, and
 * without this line the parent reads it as a decision and tells the user they agreed to it. That is
 * what happened: a layout nobody approved came back as "agreed on a larger, readable squad list".
 *
 * Loud, and before the specification rather than after it. A caveat under a page of measurements is
 * a caveat nobody acts on.
 */
function notAgreed({rounds, approved}) {
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
 * screenshot can see. A silent drop is how this tool's first build failed, and a second silent drop
 * for a different reason would look exactly like the first.
 */
function blindTo(images, model) {
    if (images.length === 0 || readsImages(model)) return ''
    return (
        `\n\nThe ${String(images.length)} picture${images.length === 1 ? '' : 's'} attached to the `
        + `ask never reached the design loop: ${model.name || model.id} cannot read one. This `
        + 'layout was agreed from the project files alone, so say so before you build it.'
    )
}

/**
 * @param host the tool channel back to Rust, which holds the window the sketches appear in
 *
 * Everything else is the parent's own — one provider, one connection, one model per session — for
 * the reason `createSubagentTool` gives: a second of any of them is a second thing to configure, to
 * fail, and to disagree with the settings page.
 */
export function createDesignWithUserTool({
    workspacePath,
    models,
    model,
    thinkingLevel,
    streamOptions,
    settings,
    timers,
    host,
    /**
     * The pictures the user attached to the message that started this turn.
     *
     * A design brief is written about something the user can see, and for the first build it was
     * something only the *parent* could see: the screenshot went into the parent's context and the
     * child was handed a sentence saying "the provided screenshot", with nothing provided. It then
     * drew from the project files alone, and what came back was close and not right.
     */
    images = []
}) {
    return {
        name: DESIGN_TOOL_NAME,
        label: 'design with the user',
        description: DESCRIPTION,
        parameters: PARAMETERS,
        execute: async (_toolCallId, params, signal, onUpdate) => {
            const probing = params?.probe === true
            if (!probing && (typeof params?.brief !== 'string' || params.brief.trim() === ''))
                throw new Error(
                    'design_with_user was given no brief. Say what is being designed, what it has '
                        + 'to hold, and what is already decided.'
                )
            const shows = boundsFrom(settings).maxShows
            if (!probing && !(shows > 0))
                throw new Error(
                    'This machine is set never to be interrupted by a sub-agent, so there is '
                        + 'nobody for a design loop to talk to. Propose the layout in your answer '
                        + 'instead, or put one sketch in front of them yourself with ask_user.'
                )
            // Opened before the child exists and closed in a `finally`, because the window has no
            // other way to learn the loop is over. A child that throws, is cancelled mid-draft or
            // runs out of ration ends the same way from the user's side: nothing more is coming.
            // The probe opens none — it must not put anything on screen.
            const sessionId = probing ? undefined : nextSessionId()
            // The probe carries none: it draws nothing and shows nobody. A child whose model has
            // no eyes drops them in `runSubagent`, which is where every caller's images pass.
            const pictures = probing ? [] : images
            // What the user agreed, filled in by `ask_user` round by round. Read once, below.
            const agreed = {}
            await tellWindow(host, sessionId, 'open', signal)
            try {
                const result = await runSubagent({
                    prompt: probing ? PROBE_PROMPT : params.brief,
                    images: pictures,
                    systemPrompt: DESIGN_SYSTEM_PROMPT,
                    toolNames: DESIGN_TOOL_NAMES,
                    workspacePath,
                    models: probing ? cannedModels(model, DESIGN_PROBE_ANSWER) : models,
                    model,
                    thinkingLevel,
                    streamOptions,
                    settings,
                    timers,
                    signal,
                    progress: toolProgress(onUpdate),
                    // A ration, not a rule. Nothing else in the system can see a delegation spending
                    // somebody's attention: the parent is never told a dialog opened, and no clock
                    // ticks while a person is looking at one.
                    deps: {
                        host,
                        asks: probing ? 1 : shows,
                        sketchesRequired: true,
                        sessionId,
                        agreed
                    }
                })
                return {
                    content: [
                        {
                            type: 'text',
                            text:
                                `${notAgreed(agreed)}${result.text}${agreedSketch(agreed)}`
                                + `${blindTo(images, model)}`
                                + `\n\n${usageFooter(result, model)}`
                        }
                    ],
                    details: {turns: result.turns, usage: result.usage}
                }
            } finally {
                await tellWindow(host, sessionId, 'closed', signal)
            }
        }
    }
}
