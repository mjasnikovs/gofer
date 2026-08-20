/**
 * The verify points a planned task carries, and the run that answers them.
 *
 * The failure this closes, measured over one project: 11 of 38 tasks were planned, every spec was
 * gated on a VERIFY block, and of the 12 command lines written across all 11 specs, 3 were ever
 * run. Nothing in the product executed one. So a task shipped a boss that could not move, be shot
 * or die, and closed on "fresh runtime launch completed with no new errors" — which was true, and
 * meant nothing. Of 29 defects that shipped in that project, a behavioural check catches 27; the
 * startup gate catches 2; static diagnostics catch none.
 *
 * The points are read back out of the conversation rather than passed in. A planned task's
 * specification IS its first user message — the brief sends it with an ordinary `startTurn` — so
 * the transcript already carries the block, and reading it there is what keeps this out of the
 * Rust job, the schema and the event vocabulary.
 */

import {parseVerifyPoints} from './brief/phases.mjs'

/**
 * How long one point may run before it is called a failure.
 *
 * A headless Godot boot is about one second on a warm import, and the startup gate this project
 * writes runs 600 frames at a fixed 60 FPS, so ten. Two minutes is far past anything measured and
 * still short enough that a hung check ends a turn rather than holding it open.
 */
const POINT_TIMEOUT_SECONDS = 120

/** How much of a failing point's output is handed back. */
const OUTPUT_BUDGET = 2000

/**
 * The points the newest specification in this conversation declares, or null when there are none.
 *
 * Newest first, because a task can be re-planned and the later block is the one that binds. Only
 * the user's own messages are read: an assistant that writes a VERIFY block into its answer is
 * describing what it did, not being held to it.
 */
export function verifyPointsIn(messages) {
    for (let index = (messages ?? []).length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (!message || message.sender !== 'user') continue
        const points = parseVerifyPoints(message.text ?? '')
        if (points) return points
    }
    return null
}

function tail(text) {
    const trimmed = (text ?? '').trim()
    return trimmed.length > OUTPUT_BUDGET ? trimmed.slice(-OUTPUT_BUDGET) : trimmed
}

/**
 * Runs every point and answers with what each one did.
 *
 * Every point runs, even after one has failed: a run that stopped at the first red would report one
 * broken thing where there are three, and the whole reason to name the points is to say which.
 *
 * The exit code decides, and nothing else. Reading a command's output to guess at a verdict is how
 * you get a check that passes on `ERROR` in a filename — the command is the author's to write, and
 * the prompt tells them to make its status mean something. The one trap worth knowing is that
 * `godot --headless --quit-after` exits 0 while printing errors, which is why the tooling phase is
 * told to say so.
 */
export async function runVerifyPoints({points, env, emit, signal}) {
    const results = []
    for (const [index, point] of points.entries()) {
        emit({
            type: 'verify-point',
            status: 'running',
            name: point.name,
            command: point.command,
            index,
            of: points.length
        })
        const outcome = await env.exec(point.command, {
            timeout: POINT_TIMEOUT_SECONDS,
            abortSignal: signal
        })
        const passed = outcome.ok && outcome.value.exitCode === 0
        const output =
            outcome.ok ?
                tail(`${outcome.value.stdout ?? ''}\n${outcome.value.stderr ?? ''}`)
            :   tail(String(outcome.error?.message ?? outcome.error ?? 'the command did not run'))
        results.push({name: point.name, command: point.command, passed, output})
        emit({
            type: 'verify-point',
            status: passed ? 'complete' : 'error',
            name: point.name,
            command: point.command,
            index,
            of: points.length,
            output: passed ? '' : output
        })
    }
    return results
}

/**
 * What a finished turn says about its own verification, in the answer the user reads.
 *
 * The failure this closes was measured live, on this code. A point failed twice, the model was
 * handed the report and asked again, and it still ended the turn with "The verification passes. The
 * code is already correct." — four seconds after the second red. The red was on the transcript and
 * nowhere near the sentence anyone reads, so the turn presented as clean.
 *
 * Appended after the model's own words rather than before them, because the last line is the one
 * that is believed, and every point is named so the summary cannot be read as being about something
 * else.
 */
export function verifySummary(results) {
    const failed = (results ?? []).filter(result => !result.passed)
    if (failed.length === 0) return undefined
    const lines = results.map(result => `  ${result.passed ? 'PASS' : 'FAIL'}  ${result.name}`)
    return (
        `Verification failed: ${failed.length} of ${results.length} points from this task's `
        + `specification did not pass.\n${lines.join('\n')}`
    )
}

/**
 * What a failing run says to the model that has just called itself finished.
 *
 * Written as the user's own words rather than a system note, because that is the seam the turn
 * has: the model is asked again, with the thing it did not do in front of it. Passing points are
 * named too — a report that lists only the red one invites a fix that breaks a green one.
 */
export function verifyReport(results) {
    const failed = results.filter(result => !result.passed)
    if (failed.length === 0) return undefined
    const lines = results.map(
        result => `${result.passed ? 'PASS' : 'FAIL'}  ${result.name}\n      ${result.command}`
    )
    const detail = failed
        .map(result => `--- ${result.name}\n${result.output || '(no output)'}`)
        .join('\n\n')
    return (
        `${failed.length} of ${results.length} verification points from this task's specification `
        + `failed. The work is not done until they pass.\n\n${lines.join('\n')}\n\n${detail}\n\n`
        + 'Fix the code so these pass. Do not edit or delete the check to make it green.'
    )
}
