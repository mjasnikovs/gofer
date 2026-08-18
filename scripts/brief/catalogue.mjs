/**
 * The brief's vocabulary, in one place.
 *
 * Four words have to mean the same thing in Node, Rust and TypeScript: which phases there are, the
 * field each one fills, the statuses a run can end in, and how one research worker ended. Nothing
 * bound them, and the drift was real — a `cached` worker kind outlived the code that produced it,
 * and the phase table written here to be checkable had no consumer at all.
 *
 * This is the owner. `check-command-surface.mjs` reconciles the SQL, the Rust match arms and the
 * TypeScript unions against it, the same way it reconciles the Godot command catalogue. See
 * ADR-0002: the names live in one place, the shapes are hand-written next to what they describe.
 *
 * Data only. Nothing here imports anything, because a checker reads it and a checker that has to
 * start a provider to find out what a phase is called is not a checker.
 */

/**
 * The phases, in the order they run, each naming the field it fills.
 *
 * A table rather than four calls in a row, because the order and the outputs are the two things the
 * backend has to agree with the host loop about, and a list is checkable where a sequence of
 * statements is not.
 */
export const BRIEF_PHASES = [
    {name: 'refine', field: 'refined'},
    {name: 'research', field: 'research'},
    {name: 'grill', field: 'qa'},
    {name: 'compose', field: 'spec'}
]

/**
 * How a run ended, or that it has not.
 *
 * `stopped` and `failed` are kept apart because only one of them is worth offering to continue: a
 * user who pressed Stop knows why it stopped, and a run that broke needs to say what broke.
 */
export const BRIEF_STATUSES = ['running', 'done', 'failed', 'stopped']

/** The four research workers, in the order their sections are assembled. */
export const RESEARCH_SECTIONS = ['FILES', 'APIS', 'CONTEXT', 'TOOLING']

/**
 * How one research worker ended.
 *
 * Worth showing rather than counting. "Four of four" says a phase finished; it does not say the
 * APIS worker found nothing, or that the CONTEXT worker was cut off mid-explore and its section is
 * partial — and those are the two things that explain a thin specification afterwards.
 */
export const WORKER_KINDS = ['ok', 'empty', 'runaway']

/** Every event a run can emit. The window drops anything not on this list rather than guessing. */
export const BRIEF_EVENTS = [
    'brief-started',
    'brief-phase-start',
    'brief-phase',
    'brief-worker',
    'brief-worker-step',
    'brief-worker-done',
    'brief-question-settled',
    'brief-cost',
    'brief-log',
    'brief-stopped',
    'brief-failed'
]
