/**
 * What a tool answers with, made small enough and safe enough to hand a model.
 *
 * Three separate things, and each one is a measurement rather than a preference: a captured frame
 * becomes a real image part, an answer past the budget is cut so it still parses, and the two
 * decorators take away what a particular model cannot use — pictures it cannot see, and a refusal
 * it has already been given twice.
 */

/** Beyond this, a tool result is summarized for the model. Details keep the whole value. */
const MAX_TOOL_TEXT_CHARS = 24_000

/** A captured frame as an image part, or nothing when this answer holds no frame. */
function pictureOf(answer) {
    const frame = answer?.frame
    return frame?.encoding === 'png-base64' && typeof frame.data === 'string' ?
            {type: 'image', data: frame.data, mimeType: 'image/png'}
        :   undefined
}

/** The same answer with the frame's bytes replaced by its shape. */
function withoutPixels(answer) {
    const {encoding, width, height} = answer.frame
    return {...answer, frame: {encoding, width, height}}
}

/**
 * Every captured frame in a call, lifted out of the JSON.
 *
 * A call is a list, so a capture can sit in any entry of it and a call may hold several — a run and
 * a capture, or one capture of the game beside one of the editor. Each becomes its own image part,
 * and the JSON keeps the frame's shape where the bytes were so the entry still reads as an answer.
 *
 * An `input` frame that another frame in the same call replaces is dropped instead. `runtime.input`
 * renders before it answers, so a batch that presses a key, waits, releases it and captures comes
 * back with a picture of every one of those moments: **58 of the 168 frames in the recorded live
 * runs are an input frame with another frame later in the same call**, a third of every picture the
 * loop has ever sent. The key-up frame shows what the key-down frame showed. The last frame is
 * never one of them, by construction — a model that wants an intermediate moment asks for it with
 * `capture`, which is always kept, and the `input` summary says so.
 *
 * Only the model's view. `toolResult` answers `details: result` — the original, every frame in it —
 * so the desktop still has the pictures to show the user.
 */
function withoutTheirPixels(result) {
    const entries = result?.ops
    if (!Array.isArray(entries)) {
        const image = pictureOf(result)
        return {described: image ? withoutPixels(result) : result, images: image ? [image] : []}
    }
    const last = entries.reduce(
        (found, entry, index) => (pictureOf(entry?.result) ? index : found),
        -1
    )
    const images = []
    const described = entries.map((entry, index) => {
        const image = pictureOf(entry?.result)
        if (!image) return entry
        if (entry.op === 'input' && index < last) {
            const {frame, ...rest} = entry.result
            return {...entry, result: rest}
        }
        images.push(image)
        return {...entry, result: withoutPixels(entry.result)}
    })
    return {described: {...result, ops: described}, images}
}

/**
 * The same tool with only its `execute` wrapped: the handler receives the original `execute`
 * and the five usual arguments, and every other property is copied over as it is.
 *
 * Two decorators below re-wrapped the same five-argument call, and the seam is one: both may be
 * stacked, and the wrap copies the tool's `execute` as it is — the wrapped one when one
 * decorator sits inside another, so the inner behaviour stays live inside the outer.
 */
function withExecute(tool, handle) {
    return {...tool, execute: (...args) => handle(tool.execute, ...args)}
}

/**
 * Turns a tool result into model-visible content. A captured frame becomes a real image part —
 * base64 PNG in a text blob is worth nothing to the model and would swamp the context — and the
 * remaining JSON is bounded, because a scene tree is allowed to be large.
 */
/**
 * The same tool, with every picture taken out of what it answers.
 *
 * `read` hands back a real image part for a PNG, and a model with no vision refuses the whole
 * request rather than the part it cannot use: one llama.cpp turn died on `failed to process mtmd
 * chunk` after the agent read a tileset to match the game's art. A tool result the model cannot use
 * must cost it nothing, so the bytes are replaced by a sentence saying what was there.
 *
 * Applied by whoever knows the model, because only they do — the parent and its child may be
 * different models with different eyes.
 */
export function withoutPictures(tool) {
    return withExecute(tool, async (execute, id, params, signal, onUpdate, context) => {
        const result = await execute(id, params, signal, onUpdate, context)
        const parts = result?.content
        if (!Array.isArray(parts) || !parts.some(part => part?.type === 'image')) return result
        return {
            ...result,
            content: parts.map(part =>
                part?.type === 'image' ?
                    {
                        type: 'text',
                        text:
                            `[a ${String(part.mimeType ?? 'image')} you cannot see: this model `
                            + 'takes text only. Ask the user about it, or capture the game and '
                            + 'describe what you need from the answer.]'
                    }
                :   part
            )
        }
    })
}

/**
 * How many times the same call may be refused with the same words before the words change.
 *
 * Two, so a caller hears the real refusal twice — once to read and once to act on — before it hears
 * anything else. The loops this exists for ran far past that: twelve, thirteen, seventeen and
 * twenty-four identical calls in four separate live turns, each answered identically every time.
 */
const REFUSALS_BEFORE_SAYING_SO = 2

/**
 * One value as a string, with every object's keys in the same order however they arrived.
 *
 * The loops this is for wrote byte-identical calls, but a model that reorders two keys between
 * attempts is sending the same call and would otherwise start the count again.
 */
function sameWhateverTheOrder(value) {
    return (
        JSON.stringify(value, (_, held) =>
            held && typeof held === 'object' && !Array.isArray(held) ?
                Object.fromEntries(
                    Object.keys(held)
                        .sort()
                        .map(key => [key, held[key]])
                )
            :   held
        ) ?? ''
    )
}

/**
 * Says so when a caller sends the same call again and gets the same refusal again.
 *
 * Four live turns went into loops that no wording escaped. The worst sent
 * `{"expression": "velocity", "expression}: ": ", ", …}` seventeen times running, and the refusal it
 * met was already the best one available — it named the parameter that was missing, listed the keys
 * that had survived, and said the object rather than the word was what went wrong. The model could
 * not see the key it had written, so it wrote it again.
 *
 * The lever left is not a better sentence, it is a *different* one. Both the arguments and the
 * answer have to match for a call to count as the same: a `runtime.wait` that times out twice is a
 * caller waiting, not a caller stuck, and its answer carries different output each time.
 *
 * It says nothing about *why* the call is refused, because it does not know. The first wording did
 * — "an object coming apart as it is written" — and a live turn met it on a
 * `method_not_found: /Pickup has no method _on_body_entered`, which is a well-formed call about a
 * method that is genuinely not there. A guard that guesses the cause is worse than one that names
 * only what it can see: this call, this answer, this many times.
 *
 * Measured now, and it does not break one. `scratchpad/bench-guard.mjs` poses the loop a live turn
 * actually reached — three refusals of
 * `{"op": "instantiate", "parent": "/Main", "path": …, "name': null}]…'}, {": null}` and then this
 * sentence — and scores whether the next call escapes. Interleaved, four seeds an arm:
 * **0 of 4 with this sentence alone, and 0 of 4 with the answer it replaced appended to it.**
 * Every one of the eight sent the identical torn call again.
 *
 * So the lever is not a sentence at all, and this one is not it either. What broke that loop was
 * `drop_the_wreckage_a_complete_call_can_spare` in `tool_params.rs`: the entry was a working call
 * with an empty key beside it, and taking the key away and running it is the only thing that
 * reached the goal. What this still guarantees is that the identical string stops going back a
 * third time.
 */
export function withoutRepeatingARefusal(tool) {
    const heard = new Map()
    return withExecute(tool, async (execute, id, params, signal, onUpdate, context) => {
        try {
            return await execute(id, params, signal, onUpdate, context)
        } catch (error) {
            // A cancelled call is not a refused one. The turn was stopped; the caller wrote
            // nothing wrong and must not be told it did.
            if (signal?.aborted || error?.name === 'AbortError') throw error
            const said = error instanceof Error ? error.message : String(error)
            const key = `${sameWhateverTheOrder(params)}\u0000${said}`
            const seen = (heard.get(key) ?? 0) + 1
            heard.set(key, seen)
            if (seen <= REFUSALS_BEFORE_SAYING_SO) throw error
            throw new Error(
                `${tool.name} has now refused this exact call ${String(seen)} times, with the `
                    + 'same answer every time, and nothing about the project changed between '
                    + 'them. A further one will be refused identically. Whatever is wrong is '
                    + 'in the call itself: build it again from nothing rather than sending the '
                    + 'one you have, or reach the same result another way.'
            )
        }
    })
}

/** One string, cut, saying how long it was. */
function cutString(text, keep) {
    return `${text.slice(0, Math.max(0, keep))}… [truncated, ${String(text.length)} characters]`
}

/** One list, shortened, with a last entry saying how many are missing. */
function cutList(items, keep) {
    const kept = items.slice(0, Math.max(0, keep))
    return [...kept, `… [truncated, ${String(items.length - kept.length)} more entries]`]
}

/** Every list in a value, longest first, with the path that reaches it. */
function listsIn(value) {
    const found = []
    const walk = (node, path) => {
        if (Array.isArray(node)) {
            found.push({path, items: node})
            node.forEach((item, index) => walk(item, [...path, index]))
            return
        }
        if (node !== null && typeof node === 'object')
            for (const [key, item] of Object.entries(node)) walk(item, [...path, key])
    }
    walk(value, [])
    return found.sort((one, other) => other.items.length - one.items.length)
}

/** Every string in a value, with the path that reaches it. */
function stringsIn(value) {
    const found = []
    const walk = (node, path) => {
        if (typeof node === 'string') {
            found.push({path, text: node})
            return
        }
        if (Array.isArray(node)) {
            node.forEach((item, index) => walk(item, [...path, index]))
            return
        }
        if (node !== null && typeof node === 'object')
            for (const [key, item] of Object.entries(node)) walk(item, [...path, key])
    }
    walk(value, [])
    return found
}

function replaceAt(value, path, replacement) {
    if (path.length === 0) return replacement
    const [step, ...rest] = path
    if (Array.isArray(value)) {
        const copy = [...value]
        copy[step] = replaceAt(value[step], rest, replacement)
        return copy
    }
    return {...value, [step]: replaceAt(value[step], rest, replacement)}
}

/** The same answer with no string longer than `cap`. */
function withStringsCappedAt(value, strings, cap) {
    return strings.reduce(
        (shaped, {path, text}) =>
            text.length <= cap ? shaped : replaceAt(shaped, path, cutString(text, cap)),
        value
    )
}

/**
 * The answer, small enough to send, with its structure intact.
 *
 * Slicing the serialized answer was what this did, and it cost the model whole operations. A call
 * is a list, so a `[inspect, inspect, inspect]` whose first node carried a 380,000-character
 * property was cut in the middle of that first entry: the second and third operations were not
 * answered, not refused, and not mentioned — the model had asked three questions and could not tell
 * that two of them were missing. Measured over one project's recorded turns: 71 answers were cut,
 * 36 of them lists, and 23 operations produced nothing the model could see.
 *
 * The strings are cut instead, all of them to one length, which is the largest length they can all
 * keep and still fit. Every operation keeps its entry, every entry keeps its keys, the JSON stays
 * parseable, and each cut says inside itself how long the value really was — the sentence a model
 * needs to decide whether to ask again for less. One length rather than one budget each, because a
 * hundred scripts should each come back with its path and its first lines, not the first one whole
 * and ninety-nine missing.
 *
 * Capping cannot save every answer, and on one shape it makes things worse: four hundred short
 * properties whose longest string is 35 characters, where the marker that replaces one is 28. There
 * the lists are shortened instead, longest first, and each says how many entries went — see
 * [`withLongestListsShortened`]. The slice is what is left for an answer with neither a long string
 * nor a list in it, thousands of small keys and nothing to cut, which is what every oversized answer
 * used to get.
 */
function withinBudget(value, budget) {
    const text = JSON.stringify(value ?? null)
    if (text.length <= budget) return text
    const strings = stringsIn(value)
    if (strings.length === 0) return cutString(text, budget)
    const capped = withStringsCappedAt(value, strings, largestCapThatFits(value, strings, budget))
    const shaped = JSON.stringify(capped ?? null)
    if (shaped.length <= budget) return shaped

    // Capping alone was not enough, so start again from the answer as it arrived rather than from
    // the wreckage. Trimming lists keeps every string it keeps whole, and an answer whose problem
    // is repetition — four hundred properties, a thousand cells — is far more readable as sixty
    // whole entries and a count than as four hundred stubs.
    const trimmed = withLongestListsShortened(value, budget)
    const shortened = JSON.stringify(trimmed ?? null)
    if (shortened.length <= budget) return shortened
    // Both, for an answer that is long lists of long strings.
    return withinBudgetOfLastResort(trimmed, budget)
}

/** Strings capped over an already-shortened answer, and the slice only if even that will not fit. */
function withinBudgetOfLastResort(value, budget) {
    const strings = stringsIn(value)
    const text = JSON.stringify(value ?? null)
    if (strings.length === 0) return text.length > budget ? cutString(text, budget) : text
    const shaped = JSON.stringify(
        withStringsCappedAt(value, strings, largestCapThatFits(value, strings, budget)) ?? null
    )
    return shaped.length > budget ? cutString(text, budget) : shaped
}

/**
 * The longest every string can be cut to and still leave the whole answer inside the budget.
 *
 * Searched over that length rather than over the answer: the structure around the strings costs the
 * same whatever they are cut to, so only the strings are measured again per candidate.
 */
function largestCapThatFits(value, strings, budget) {
    const text = JSON.stringify(value ?? null)
    const structure =
        text.length - strings.reduce((total, one) => total + JSON.stringify(one.text).length, 0)
    const sizeAt = cap =>
        strings.reduce(
            (total, one) =>
                total
                + JSON.stringify(one.text.length <= cap ? one.text : cutString(one.text, cap))
                    .length,
            structure
        )
    let low = 0
    let high = Math.max(...strings.map(one => one.text.length))
    while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (sizeAt(middle) <= budget) low = middle
        else high = middle - 1
    }
    return low
}

/**
 * The answer with its longest list shortened until the whole thing fits, and its shape still intact.
 *
 * Capping strings cannot save an answer that is mostly structure. `godot_node inspect` on a Control
 * is four hundred short properties: a 38,719-character answer whose longest string is 35 characters,
 * so there is no cap that helps — and every cap makes it *worse*, because `… [truncated, N
 * characters]` is 28 characters and most of the strings are shorter than that. Measured on exactly
 * that answer: the search bottomed out, every property name became `… [truncated, 35 characters]`,
 * and the result was sliced anyway. What the model received was 24,031 characters of unparseable
 * rubble claiming 45,680 characters had been dropped — more than the answer had ever held.
 *
 * The list is what to cut there, because the entries are the repetition. The longest one loses its
 * tail, then the next longest, and each says how many entries went. Every key survives, every entry
 * that survives is whole, and the JSON still parses — which is the promise the string capping was
 * written to keep and cannot keep alone.
 *
 * The slice is still the last resort, for an answer with neither a long string nor a list in it.
 */
function withLongestListsShortened(value, budget) {
    let shaped = value
    for (const {path} of listsIn(value)) {
        const items = at(shaped, path)
        if (!Array.isArray(items) || items.length < 2) continue
        let low = 0
        let high = items.length - 1
        while (low < high) {
            const middle = Math.ceil((low + high) / 2)
            const fits =
                JSON.stringify(replaceAt(shaped, path, cutList(items, middle)) ?? null).length
                <= budget
            if (fits) low = middle
            else high = middle - 1
        }
        const cut = replaceAt(shaped, path, cutList(items, low))
        // Only if it actually helped. `… [truncated, N more entries]` is 32 characters, and a list
        // shorter than that costs more to shorten than to keep — an encoded `vector2` is twelve.
        // Every list was cut whether it helped or not, so four hundred vector2 properties went from
        // 31,833 characters to 33,143 with every pair replaced by the marker, and were sliced
        // anyway: the unparseable rubble this was written to stop the string capping making, now
        // with the values gone as well.
        if (JSON.stringify(cut ?? null).length >= JSON.stringify(shaped ?? null).length) continue
        shaped = cut
        if (JSON.stringify(shaped ?? null).length <= budget) return shaped
    }
    return shaped
}

/** The value at a path, or undefined where the path does not reach one. */
function at(value, path) {
    return path.reduce(
        (held, step) => (held === undefined || held === null ? undefined : held[step]),
        value
    )
}

export function toolResult(result) {
    const {described, images} = withoutTheirPixels(result)
    return {
        content: [{type: 'text', text: withinBudget(described, MAX_TOOL_TEXT_CHARS)}, ...images],
        details: result
    }
}
