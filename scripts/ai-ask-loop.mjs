import {modelReadsImages} from './agent-runtime.mjs'
import {
    DESIGN_TOOL_NAMES,
    PROBE_PROMPT,
    cannedModels,
    runSubagent,
    toolProgress,
    usageFooter
} from './ai-subagent.mjs'

export const ASK_LOOP_PROBE_ANSWER = 'ask-loop-reachable'

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

export function blindTo(images, model) {
    if (images.length === 0 || modelReadsImages(model)) return ''
    return (
        `\n\nThe ${String(images.length)} picture${images.length === 1 ? '' : 's'} attached to the `
        + `ask never reached the design loop: ${model.name || model.id} cannot read one. This `
        + 'layout was agreed from the project files alone, so say so before you build it.'
    )
}

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
        const pictures = probing ? [] : images
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
            stopWhen: () => agreed.approved === true,
            deps: {host, ownerCallId, agreed}
        })
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
