import {toolResult} from './tool-result.mjs'

export const BOARD_TOOL_NAME = 'board'

export const BOARD_PROBE_ANSWER = 'board-reachable'

export const CARD_STATUSES = ['backlog', 'ready', 'doing', 'review', 'done']

const DESCRIPTION =
    'The project board: cards in five columns — backlog, ready, doing, review, done. '
    + "The user and other agents write cards here. A card's id is its number. "
    + 'Leave id out of read, move, comment or edit to act on the card this task was opened for, '
    + 'which list marks yours. '
    + 'list shows every card without its body; read opens one with its body and comments. '
    + 'Comment on your own card when you finish, when you are stuck, or when you found something '
    + 'the card did not say — that is where the user and the reviewer look. '
    + 'create a card only for work you found and are not doing in this turn. '
    + 'A done card cannot be touched, and you never move a card to done: the user does, by merging.'

// One flat object with an `op` enum rather than a root-level oneOf. The local sampler could not
// fill a root oneOf at all: it emitted `{}` 835 times in one turn until the output ceiling. The
// per-op branches the godot tool uses are proven only as the items of its `ops` array.
const PARAMETERS = {
    type: 'object',
    properties: {
        op: {type: 'string', enum: ['list', 'read', 'create', 'move', 'comment', 'edit']},
        id: {type: 'string'},
        title: {type: 'string'},
        body: {type: 'string'},
        status: {type: 'string', enum: CARD_STATUSES}
    },
    required: ['op'],
    additionalProperties: false
}

export function createBoardTool({host}) {
    return {
        name: BOARD_TOOL_NAME,
        label: 'board',
        description: DESCRIPTION,
        parameters: PARAMETERS,
        execute: async (_toolCallId, params, signal) => {
            const given = params ?? {}
            if (given.probe === true) {
                await host.call(BOARD_TOOL_NAME, {probe: true}, signal)
                return {content: [{type: 'text', text: BOARD_PROBE_ANSWER}]}
            }
            return toolResult(await host.call(BOARD_TOOL_NAME, given, signal))
        }
    }
}
