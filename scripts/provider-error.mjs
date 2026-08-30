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
