export const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

// Calendar months and years vary; a label that says "3 months ago" needs only the rough length.
const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
    ['year', 365 * DAY_MS],
    ['month', 30 * DAY_MS],
    ['week', 7 * DAY_MS],
    ['day', DAY_MS],
    ['hour', HOUR_MS],
    ['minute', MINUTE_MS]
]

// English because the label sits inside English text. Counts, never "yesterday": the spans
// above are fixed lengths, and 26 hours can be two dates back.
const FORMAT = new Intl.RelativeTimeFormat('en', {numeric: 'always'})

/** "5 minutes ago", "1 day ago", "just now". A time ahead of the clock reads as just now. */
export function relativeTime(then: number, now: number): string {
    const elapsed = Math.max(0, now - then)
    for (const [unit, size] of UNITS)
        if (elapsed >= size) return FORMAT.format(-Math.floor(elapsed / size), unit)
    return 'just now'
}
