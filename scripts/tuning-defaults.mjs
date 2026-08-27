/**
 * What a turn is tuned to when the request that started it named nothing.
 *
 * Rust owns these: they are `#[serde(default = "…")]` on `AiSettingsFile`, so a settings file
 * written before a field existed still loads with the shipped value in it. The worker carries them
 * anyway because a request that lost a field arrives here as `undefined` rather than as an error —
 * which is exactly what a `rename_all` attribute did once, silently, to four fields at a time.
 *
 * So this is a second copy on purpose, and the point of gathering it is that it is now *one* second
 * copy. It was five: three numbers in `ai-provider.mjs`, two of them again in `rag-expand.mjs`, and
 * a search provider spelled in two more places. `check:command-surface` reads this file against the
 * Rust defaults and the renderer's, the same way it already holds the reasoning vocabulary and the
 * sub-agent bounds — a commit that raised one of the three and not the others is the failure this
 * exists to catch, and it has happened before.
 */

/**
 * Mirrors `default_max_retries`, `default_timeout_ms` and `default_compaction_percent`.
 *
 * `compactionPercent` is how full the context may get before the old part of it is summarised away.
 * Pi states the same line as a token reserve — 16,384 of a 120,064-token window — which is 86.4%
 * full. A percentage is the number that survives a change of model, so that is what Gofer stores
 * and what the reserve is derived back from; 86 puts the line within ~400 tokens of Pi's.
 */
export const TUNING_DEFAULTS = Object.freeze({
    maxRetries: 2,
    timeoutMs: 120_000,
    compactionPercent: 86
})

/** Mirrors `default_search_provider`. The engines themselves are `SEARCH_PROVIDERS`. */
export const DEFAULT_SEARCH_PROVIDER = 'exa'
