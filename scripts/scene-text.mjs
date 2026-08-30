const PACKED_LITERAL = /Packed([A-Za-z0-9]*)Array\(([^()]*)(\)|$)/gu

const ELIDE_OVER = 200

const PACKED_FILE = /\.(?:tscn|scn)$/u

export function holdsPackedLiterals(path) {
    return typeof path === 'string' && PACKED_FILE.test(path)
}

export function elidePackedLiterals(text) {
    if (typeof text !== 'string') return text
    return text.replace(PACKED_LITERAL, (whole, kind, body, close) =>
        body.length > ELIDE_OVER ?
            `Packed${kind}Array(<${String(body.length)} characters elided; read the cells with godot_node get_cells>${close}`
        :   whole
    )
}

export function withoutPackedLiterals(tool) {
    return {
        ...tool,
        execute: async (id, params, signal, onUpdate, context) => {
            const answer = await tool.execute(id, params, signal, onUpdate, context)
            if (!holdsPackedLiterals(params?.path) || !Array.isArray(answer?.content)) return answer
            return {
                ...answer,
                content: answer.content.map(part =>
                    part?.type === 'text' ? {...part, text: elidePackedLiterals(part.text)} : part
                )
            }
        }
    }
}
