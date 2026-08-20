import assert from 'node:assert/strict'
import test from 'node:test'
import {createDesignWithUserTool, DESIGN_PROBE_ANSWER, DESIGN_TOOL_NAME} from './ai-design.mjs'
import {CHILD_TOOL_NAMES, DESIGN_TOOL_NAMES, SUBAGENT_TOOL_NAMES} from './ai-subagent.mjs'

/*
 * The design loop is the only child in this codebase allowed to interrupt the user, and everything
 * here is about that being deliberate rather than accidental.
 */

const model = {id: 'test-model', api: 'openai-completions', provider: 'test'}

function designTool(overrides = {}) {
    return createDesignWithUserTool({
        workspacePath: process.cwd(),
        models: {streamSimple: () => assert.fail('the probe must not reach a provider')},
        model,
        thinkingLevel: 'off',
        streamOptions: {},
        settings: {maxShows: 4},
        host: {call: () => assert.fail('a probe must not open a dialog')},
        ...overrides
    })
}

/**
 * The delegation tool must not gain the window as a side effect of the design loop having it.
 *
 * That split is the whole reason `CHILD_TOOL_NAMES` and the per-caller rations are separate
 * constants: widening the ceiling for one caller must not hand every other caller the same reach.
 */
test('only the design loop may reach the user, and the ceiling was widened on purpose', () => {
    assert.ok(CHILD_TOOL_NAMES.includes('ask_user'))
    assert.ok(DESIGN_TOOL_NAMES.includes('ask_user'))
    assert.ok(!SUBAGENT_TOOL_NAMES.includes('ask_user'))
})

/**
 * A child that could delegate again, write, or reach the editor would stop being a child.
 *
 * `design_with_user` is on this list for the reason `web_fetch` is: it holds a child of its own, so
 * a child holding it is a grandchild. `ask_user` is not, because it builds no agent — it is rationed
 * by a count instead, which is the thing a tool list cannot check.
 */
test('nothing that would make a child something else is on the ceiling', () => {
    for (const name of ['write', 'edit', 'subagent', 'web_fetch', DESIGN_TOOL_NAME])
        assert.ok(!CHILD_TOOL_NAMES.includes(name), `${name} must not be a tool a child may hold`)
})

test('a delegation with no brief is refused by name rather than started empty', async () => {
    const tool = designTool()
    await assert.rejects(() => tool.execute('id', {brief: '   '}), /no brief/u)
})

/**
 * A machine set never to be interrupted has nobody for a design loop to talk to.
 *
 * Refused here rather than discovered inside the child, where it would arrive as a tool that
 * mysteriously refuses every showing and a delegation that answers with nothing.
 */
test('a ration of zero is refused with somewhere else to go', async () => {
    const tool = designTool({settings: {maxShows: 0}})
    await assert.rejects(() => tool.execute('id', {brief: 'a pause menu'}), /ask_user/u)
})

/** The probe drives the real child against a canned provider, so it costs no network call. */
test('the probe builds the child, runs a turn and answers without a provider', async () => {
    const tool = designTool({host: {call: () => Promise.resolve({})}})
    const result = await tool.execute('id', {probe: true})
    assert.match(result.content[0].text, new RegExp(DESIGN_PROBE_ANSWER, 'u'))
})
