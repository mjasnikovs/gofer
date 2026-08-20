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
    runSubagent,
    toolProgress,
    usageFooter
} from './ai-subagent.mjs'

export const DESIGN_TOOL_NAME = 'design_with_user'

/** What the probe proves: the child builds, holds `show_user`, runs a turn and answers. */
export const DESIGN_PROBE_ANSWER = 'design-loop-reachable'

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
    + 'How to work:\n'
    + '1. Read enough of the project to know what this layout belongs to. Be quick about it.\n'
    + '2. Draft the layout as HTML and ask about it. When there is a real choice to make, show two or '
    + 'three variants that differ in a way a person sees at a glance.\n'
    + '3. Read what they say back. Revise, and ask again under the SAME questionId you were '
    + 'given, so they see one layout changing rather than a pile of them.\n'
    + '4. They end it by choosing a sketch and saying nothing else. Words about a sketch are a '
    + 'change to make, not approval. Stop the moment they choose one. You may interrupt them only '
    + 'a few times, so do not spend one on a change you were already told to make.\n'
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
    host
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
            const result = await runSubagent({
                prompt: probing ? PROBE_PROMPT : params.brief,
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
                // somebody's attention: the parent is never told a dialog opened, and no clock ticks
                // while a person is looking at one.
                deps: {host, asks: probing ? 1 : shows, sketchesRequired: true}
            })
            return {
                content: [{type: 'text', text: `${result.text}\n\n${usageFooter(result, model)}`}],
                details: {turns: result.turns, usage: result.usage}
            }
        }
    }
}
