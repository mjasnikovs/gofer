import {extname} from 'node:path'
import {GODOT_TOOL_NAME} from './godot-tools.mjs'
import {toolResult} from './tool-result.mjs'

/**
 * Sends an `edit` or `write` of a script through the language server, as script.edit or
 * script.save.
 *
 * Both tools refused a .gd with a sentence naming the operation to use instead, and one live turn
 * sent the same refused edit six times running, then ran the game without the change until the
 * turn was killed. There is nothing to guess: an edit carries the anchors script.edit takes and a
 * write the text script.save takes, so the call is made for the model, and the answer says which
 * operation made it. A refusal from the server comes back the same way, named.
 */
export function forwardsScriptsToTheServer(tool, host) {
    if (!host || (tool.name !== 'edit' && tool.name !== 'write')) return tool
    return {
        ...tool,
        execute: async (id, params, signal, onUpdate, context) => {
            if (!isAScript(params?.path)) return tool.execute(id, params, signal, onUpdate, context)
            const entry = asScriptOperation(tool.name, params)
            const opened = `${tool.name} does not touch a .gd, so this went through ${entry.op}`
            let answer
            try {
                answer = await host.call(GODOT_TOOL_NAME, {ops: [entry]}, signal)
            } catch (error) {
                throw new Error(`${opened}, which refused it. ${error.message}`)
            }
            const result = toolResult(answer)
            const [first, ...rest] = result.content
            return {...result, content: [{...first, text: `${opened}: ${first.text}`}, ...rest]}
        }
    }
}

function isAScript(path) {
    return typeof path === 'string' && extname(path.replace(/^res:\/\//u, '')) === '.gd'
}

function asScriptOperation(name, params) {
    if (name === 'edit')
        return {op: 'script.edit', files: [{path: params.path, edits: params.edits}]}
    return {op: 'script.save', path: params.path, text: params.content}
}
