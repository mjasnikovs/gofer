// One ask for the one parameter whose note step 7 cut and nothing else said: runtime.inspect_node
// takes a node by its path in the running tree, and it is the only `path` in the catalogue that is
// not a file.
const SESSION =
    'Editor session: ready. Godot 4.7.2. The project is open and its game is running. Every tool runs'
    + ' in the project root and takes paths the way the project spells them, never an absolute one.'

const RUNNING = {
    tree: {
        path: '/root',
        type: 'Window',
        children: [
            {
                path: '/root/Main',
                type: 'Node2D',
                children: [
                    {path: '/root/Main/Player', type: 'CharacterBody2D', children: []},
                    {path: '/root/Main/Enemy', type: 'CharacterBody2D', children: []}
                ]
            }
        ]
    }
}

export const TASKS = [
    {
        id: 'inspectRunning',
        outside: 'none',
        ask:
            'Read the Player node in the running game: its class, its groups and its current'
            + ' property values. Do not touch the edited scene.',
        priming: [{id: 'call-tree', op: 'runtime.get_tree', params: {}, result: RUNNING}],
        wants: ops => ops.some(e => e.op === 'inspect_node' && e.path === '/root/Main/Player')
    }
]

export function answerOf({op, dotted, entry}) {
    if (dotted.startsWith('docs_search.'))
        return {answer: 'No documentation matched this question.', results: []}
    if (op === 'get_tree') return RUNNING
    if (dotted === 'runtime.inspect_node') {
        if (entry.path !== '/root/Main/Player')
            return {
                error: 'node_not_found',
                message: `No node at ${String(entry.path)} in the running tree`
            }
        return {
            path: '/root/Main/Player',
            type: 'CharacterBody2D',
            groups: ['player'],
            properties: {speed: 200}
        }
    }
    if (dotted === 'node.inspect')
        return {error: 'node_not_found', message: 'The edited scene has no node at that path'}
    return {ok: true}
}

export const HINTING = new Set()
export {SESSION}
