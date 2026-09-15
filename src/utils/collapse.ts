export type CollapseFit = Readonly<{
    /** Width the box has now. */
    available: number
    /** Width its content takes; read only while expanded. */
    content: number
}>

/**
 * Collapses when the content overflows, and expands only once the width it needed is there
 * again, so the two layouts settle rather than trade places forever.
 */
export function settleCollapse(
    wasCollapsed: boolean,
    fit: CollapseFit,
    needed: {current: number}
): boolean {
    if (wasCollapsed) return fit.available < needed.current
    needed.current = fit.content
    return fit.content > fit.available
}
