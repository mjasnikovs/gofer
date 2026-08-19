/**
 * Takes the packed binary out of a scene or resource file on its way to the model.
 *
 * A `.tscn` is text, so `read` answers with it, and the write tools refuse it precisely so that
 * reading is the way to look at one. What comes back is not all readable. A tilemap stores its
 * cells as one `PackedByteArray` literal on a single line: in a live project that line was 38,055
 * of the file's 43,897 characters, base64 the model can neither parse nor edit, and it read the
 * file whole three times. `offset` and `limit` are no escape — they count lines, and this is one
 * line — so a call asking for twenty lines still came back with 37,861 characters.
 *
 * Eliding it takes that same file to 5,894 characters and leaves every node, property and resource
 * reference where it was. What the bytes held is reachable through `godot_node get_cells`, which
 * answers in tile coordinates rather than in base64.
 */

/**
 * The literals worth taking out: Godot's packed arrays, in either spelling.
 *
 * A tilemap writes base64 inside quotes; a polygon or a UV set writes bare numbers. Both are the
 * same thing to a reader — a run of values with no names in it — so both match here. The body is
 * matched without allowing `)`, which is what keeps a `PackedVector2Array(Vector2(1, 2))` out of
 * this: its contents are constructor calls, short, and worth reading.
 *
 * The closing paren is optional so that a literal running past the end of the text still matches.
 * `read` caps its answer at 50KB before this sees it, and the file this exists for is the one large
 * enough to be cut there — a rule needing the `)` would have passed exactly those through whole.
 */
const PACKED_LITERAL = /Packed([A-Za-z0-9]*)Array\(([^()]*)(\)|$)/gu

/**
 * How long a literal has to be before its contents are worth more than a summary of them.
 *
 * Well under the smallest thing anyone would scroll past, and far above a hand-written
 * `PackedStringArray("idle", "walk")`, which is a property a reader wants to see.
 */
const ELIDE_OVER = 200

/**
 * The files this may take text out of.
 *
 * Only the two the write tool refuses. A `.tres` also holds packed literals — a mesh's vertices, a
 * polygon's points — but nothing stops the agent writing one, and a file read with its bytes
 * replaced by a summary and then written back is a file whose data is gone. Elision is safe exactly
 * where a round trip through the agent is impossible.
 */
const PACKED_FILE = /\.(?:tscn|scn)$/u

/** Whether this path is one Godot writes packed literals into. */
export function holdsPackedLiterals(path) {
    return typeof path === 'string' && PACKED_FILE.test(path)
}

/**
 * The same text with every oversized packed literal replaced by its shape.
 *
 * The replacement keeps the array's own type name and says how much was taken, so the reader can
 * tell a tilemap's cells from a mesh's vertices and knows the file is longer than what it read.
 */
export function elidePackedLiterals(text) {
    if (typeof text !== 'string') return text
    return text.replace(PACKED_LITERAL, (whole, kind, body, close) =>
        body.length > ELIDE_OVER ?
            `Packed${kind}Array(<${String(body.length)} characters elided; read the cells with godot_node get_cells>${close}`
        :   whole
    )
}

/**
 * A `read` tool that elides packed literals out of the scene and resource files it answers with.
 *
 * Wrapped rather than folded into confinement: confinement decides whether a path may be touched at
 * all, and this decides what a permitted read is worth showing. Only the text parts are rewritten —
 * an image read answers with pixels, and those are not text to begin with.
 */
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
