/**
 * A provider's refusal, made readable wherever one is shown.
 *
 * Its own module because two callers need it and one of them is a sidecar. `ai-provider.mjs` is the
 * whole agent loop; importing it into `rag-retrieve.mjs` would bundle the loop into the retrieve
 * worker to reach one function. See `readableProviderError` for what it does and why.
 */

/**
 * A provider's refusal as a sentence, rather than as the JSON body it arrived in.
 *
 * Pi hands over `"<status>: <body>"` whenever the SDK error carries both, so what the user was
 * shown for a rate-limited turn was 400 characters of JSON with the one actionable line —
 * OpenRouter's `remedy_hint` — buried in the middle of it. The body is the right thing to have
 * kept; it is the wrong thing to have shown.
 *
 * Every part is optional because no two providers fill the same fields: OpenRouter states the real
 * cause in `metadata.raw` and the fix in `metadata.remedy_hint`, llama.cpp and OpenAI state both in
 * `error.message`, and anything this cannot read is handed back exactly as it came. The status is
 * kept in the sentence so a bug report still names it.
 */
export function readableProviderError(errorMessage) {
    if (typeof errorMessage !== 'string') return errorMessage
    const framed = /^(?<status>\d{3}): (?<body>[[{].*)$/su.exec(errorMessage)
    if (!framed?.groups) return errorMessage
    let body
    try {
        body = JSON.parse(framed.groups.body)
    } catch {
        return errorMessage
    }
    const error = body?.error ?? body
    const metadata = error?.metadata ?? {}
    const detail = metadata.raw ?? error?.message ?? body?.message
    if (typeof detail !== 'string' || detail === '') return errorMessage
    const remedy = typeof metadata.remedy_hint === 'string' ? ` ${metadata.remedy_hint}` : ''
    const stop = /[.!?]$/u.test(detail.trim()) ? '' : '.'
    return `The provider refused this request (${framed.groups.status}): ${detail.trim()}${stop}${remedy}`
}
