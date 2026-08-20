/**
 * The reasoning level Gofer stores, translated into one pi-ai understands.
 *
 * Gofer has a level pi-ai does not: `on`. It is the whole menu for a local server whose chat
 * template thinks but names no efforts — llama.cpp reports that as `supports_preserve_reasoning`
 * with `supports_reasoning_effort` false, and the template raises on any effort it is handed. So
 * the only two states are on and off, and `on` is the word for the first of them.
 *
 * pi-ai's scale is `off · minimal · low · medium · high · xhigh · max`, and every request is passed
 * through `clampThinkingLevel` before it is built. An unrecognised level is not passed through: it
 * is clamped to the lowest level the model offers, which is `off`. The chat-template argument then
 * resolves `enable_thinking` from whether an effort survived, so every request went out saying
 * thinking was disabled — the exact opposite of the setting the user chose, and worse than sending
 * nothing at all.
 *
 * Which level `on` becomes does not reach the server. A template with no efforts is never told one:
 * `reasoning_effort` is left out of the chat-template arguments entirely, and the top-level field is
 * only written for a connection that said it takes efforts. All that matters is that it is above
 * `off`, so the switch resolves to true.
 */
export function piThinkingLevel(level) {
    if (level === 'on') return 'medium'
    return level || 'off'
}

/**
 * Every effort Gofer has a word for, which is every one a settings file can hold.
 *
 * `off` is not among them: it is the absence of an effort, not one of them. The same list, in the
 * same order, is `KNOWN_EFFORTS` in `model_server.rs`, which is what reads them out of a template.
 */
const KNOWN_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The levels a local model may be asked at, as pi-ai needs them written down.
 *
 * pi-ai keeps its own idea of which levels a model has. `xhigh` and `max` are only available to a
 * model that maps them, and every other level is available unless it is mapped to null. Whatever is
 * unavailable is not refused — it is clamped to the nearest thing that is.
 *
 * Left unwritten, that clamp is silent and wrong in both directions. Measured against a real
 * Qwen3.8 build whose template accepts `('xhigh', 'medium', 'low')` and raises on anything else:
 * Gofer offered xhigh because the server named it, pi-ai found no map, and the request went out
 * saying `high`. It survived only because that template aliases high onto xhigh one line earlier.
 * Without the alias, llama.cpp answers every request with HTTP 500.
 *
 * So the map is the server's own list: what it named maps to itself, and what it did not is null,
 * which puts it out of the clamp's reach entirely. `off` is never mapped — pi-ai reads a mapped
 * `off` as an instruction of its own.
 *
 * Nothing when the server named no efforts. That connection has one level, `on`, and the effort
 * field never leaves the building.
 */
export function piThinkingLevelMap(levels) {
    const named = new Set(levels ?? [])
    if (named.size === 0) return undefined
    return Object.fromEntries(
        KNOWN_EFFORTS.map(effort => [effort, named.has(effort) ? effort : null])
    )
}
