const MAX_TOOL_TEXT_CHARS = 24_000

function pictureOf(answer) {
    const frame = answer?.frame
    return frame?.encoding === 'png-base64' && typeof frame.data === 'string' ?
            {type: 'image', data: frame.data, mimeType: 'image/png'}
        :   undefined
}

function withoutPixels(answer) {
    const {encoding, width, height} = answer.frame
    return {...answer, frame: {encoding, width, height}}
}

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

export function withExecute(tool, handle) {
    return {...tool, execute: (...args) => handle(tool.execute, ...args)}
}

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

const REFUSALS_BEFORE_SAYING_SO = 2

export function sameWhateverTheOrder(value) {
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

export function withoutRepeatingARefusal(tool) {
    const heard = new Map()
    return withExecute(tool, async (execute, id, params, signal, onUpdate, context) => {
        try {
            return await execute(id, params, signal, onUpdate, context)
        } catch (error) {
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

function cutString(text, keep) {
    return `${text.slice(0, Math.max(0, keep))}… [truncated, ${String(text.length)} characters]`
}

function cutList(items, keep) {
    const kept = items.slice(0, Math.max(0, keep))
    return [...kept, `… [truncated, ${String(items.length - kept.length)} more entries]`]
}

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

function withStringsCappedAt(value, strings, cap) {
    return strings.reduce(
        (shaped, {path, text}) =>
            text.length <= cap ? shaped : replaceAt(shaped, path, cutString(text, cap)),
        value
    )
}

function withinBudget(value, budget) {
    const text = JSON.stringify(value ?? null)
    if (text.length <= budget) return text
    const strings = stringsIn(value)
    if (strings.length === 0) return cutString(text, budget)
    const capped = withStringsCappedAt(value, strings, largestCapThatFits(value, strings, budget))
    const shaped = JSON.stringify(capped ?? null)
    if (shaped.length <= budget) return shaped

    const trimmed = withLongestListsShortened(value, budget)
    const shortened = JSON.stringify(trimmed ?? null)
    if (shortened.length <= budget) return shortened
    return withinBudgetOfLastResort(trimmed, budget)
}

function withinBudgetOfLastResort(value, budget) {
    const strings = stringsIn(value)
    const text = JSON.stringify(value ?? null)
    if (strings.length === 0) return text.length > budget ? cutString(text, budget) : text
    const shaped = JSON.stringify(
        withStringsCappedAt(value, strings, largestCapThatFits(value, strings, budget)) ?? null
    )
    return shaped.length > budget ? cutString(text, budget) : shaped
}

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
        if (JSON.stringify(cut ?? null).length >= JSON.stringify(shaped ?? null).length) continue
        shaped = cut
        if (JSON.stringify(shaped ?? null).length <= budget) return shaped
    }
    return shaped
}

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
