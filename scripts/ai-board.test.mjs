import assert from 'node:assert/strict'
import test from 'node:test'
import {validateToolArguments} from '@earendil-works/pi-ai'
import {BOARD_PROBE_ANSWER, BOARD_TOOL_NAME, CARD_STATUSES, createBoardTool} from './ai-board.mjs'
import {toolStepLine} from './tool-target.mjs'

function recording(answer = {id: 'card-1', title: 'Jump'}) {
    const calls = []
    return {
        calls,
        call: (name, params) => {
            calls.push({name, params})
            return Promise.resolve(answer)
        }
    }
}

test('the schema is one flat object with an op, and only the columns that exist', () => {
    const tool = createBoardTool({host: recording()})

    assert.equal(tool.name, BOARD_TOOL_NAME)
    assert.equal(
        tool.parameters.type,
        'object',
        'a root oneOf leaves the local sampler emitting {}'
    )
    assert.equal(tool.parameters.oneOf, undefined)
    assert.deepEqual(tool.parameters.properties.op.enum, [
        'list',
        'read',
        'create',
        'move',
        'comment',
        'edit'
    ])
    assert.deepEqual(tool.parameters.required, ['op'])
    assert.deepEqual(tool.parameters.properties.status.enum, CARD_STATUSES)
    assert.equal(tool.parameters.additionalProperties, false)
})

test('pi hands the board a number id as text and drops a null one', () => {
    const tool = createBoardTool({host: recording()})
    const validated = args =>
        validateToolArguments(tool, {
            type: 'toolCall',
            id: 'call-1',
            name: BOARD_TOOL_NAME,
            arguments: args
        })

    assert.deepEqual(validated({op: 'comment', id: 7, body: 'Done'}), {
        op: 'comment',
        id: '7',
        body: 'Done'
    })
    assert.deepEqual(validated({op: 'comment', id: '#7', body: 'Done'}), {
        op: 'comment',
        id: '#7',
        body: 'Done'
    })
    assert.deepEqual(validated({op: 'comment', id: null, body: 'Done'}), {
        op: 'comment',
        body: 'Done'
    })
    assert.deepEqual(validated({op: 'read', id: true}), {op: 'read', id: 'true'})
})

test('the description says the model never finishes a card', () => {
    const {description} = createBoardTool({host: recording()})

    assert.match(description, /never move a card to done/u)
    assert.match(description, /Comment on your own card/u)
    assert.match(description, /Leave id out/u)
})

test('a call reaches the backend as it was written', async () => {
    const host = recording({id: 'comment-1'})
    const tool = createBoardTool({host})

    const {content, details} = await tool.execute('call-1', {
        op: 'comment',
        id: 'card-1',
        body: 'Done, the jump is twice as high.'
    })

    assert.deepEqual(host.calls, [
        {
            name: BOARD_TOOL_NAME,
            params: {op: 'comment', id: 'card-1', body: 'Done, the jump is twice as high.'}
        }
    ])
    assert.equal(details.id, 'comment-1')
    assert.match(content[0].text, /comment-1/u)
})

test('a probe routes the name without touching the board', async () => {
    const host = recording({tool: BOARD_TOOL_NAME, reachable: true})
    const tool = createBoardTool({host})

    const {content} = await tool.execute('call-1', {probe: true})

    assert.deepEqual(host.calls, [{name: BOARD_TOOL_NAME, params: {probe: true}}])
    assert.equal(content[0].text, BOARD_PROBE_ANSWER)
})

test('the step line names the op and the card', () => {
    assert.equal(
        toolStepLine(BOARD_TOOL_NAME, {op: 'comment', id: 'card-1'}),
        'board: comment card-1'
    )
    assert.equal(
        toolStepLine(BOARD_TOOL_NAME, {op: 'create', title: 'Jump  higher'}),
        'board: create Jump higher'
    )
    assert.equal(toolStepLine(BOARD_TOOL_NAME, {op: 'list'}), 'board: list')
})
