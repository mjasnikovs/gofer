import {verifyPoint} from './ai-events.mjs'
import {normalizeGodotCall} from './godot-tools.mjs'
import {parseVerifyPoints} from './brief/phases.mjs'
import {validateBashCommand} from './workspace-confinement.mjs'

const POINT_TIMEOUT_SECONDS = 120

const OUTPUT_BUDGET = 2000

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

function refusedPoint(error) {
    const reason = String(error?.message ?? error ?? 'the command was refused')
    return (
        `${reason} A verification point is one line: a shell command, or a call to the running `
        + 'game written as `godot_runtime {"ops": [...], "contains": "<the text the answer must '
        + 'hold>"}`, which reaches the editor without the shell.'
    )
}

/// The answer is JSON, so text the spec wrote plainly — a quote, a backslash, an accent — is
/// escaped in it and never matches itself. Both spellings are tried.
const holds = (answered, wanted) =>
    answered.includes(wanted) || answered.includes(JSON.stringify(wanted).slice(1, -1))

/// A point that names a godot tool, run through the same channel the model's own calls take.
///
/// It carries no clock of its own. What it waits for is the router, which serialises every call to
/// one editor, and the turn's signal, which is what a user pressing Stop moves.
async function runToolPoint(point, host, domains, signal) {
    if (!host) {
        return {
            passed: false,
            output:
                `${point.tool} cannot be called here: this turn has no channel to the editor. `
                + 'Check this with a shell command instead.'
        }
    }
    try {
        const written = normalizeGodotCall(domains, point.tool, point.params)
        const answered = JSON.stringify((await host.call(point.tool, written, signal)) ?? null)
        if (point.contains && !holds(answered, point.contains)) {
            return {
                passed: false,
                output:
                    `The call was answered, and nothing in the answer holds \`${point.contains}\`.`
                    + `\n${answered}`
            }
        }
        return {passed: true, output: answered}
    } catch (error) {
        return {passed: false, output: String(error?.message ?? error ?? 'the call did not run')}
    }
}

async function runShellPoint(point, env, signal) {
    try {
        validateBashCommand(point.command)
    } catch (error) {
        return {passed: false, refused: true, output: refusedPoint(error)}
    }
    let outcome
    try {
        outcome = await env.exec(point.command, {
            timeout: POINT_TIMEOUT_SECONDS,
            abortSignal: signal
        })
    } catch (error) {
        outcome = {ok: false, error}
    }
    return {
        passed: outcome.ok && outcome.value.exitCode === 0,
        output:
            outcome.ok ?
                `${outcome.value.stdout ?? ''}\n${outcome.value.stderr ?? ''}`
            :   String(outcome.error?.message ?? outcome.error ?? 'the command did not run')
    }
}

export async function runVerifyPoints({points, env, host, domains, emit, signal}) {
    const results = []
    for (const [index, point] of points.entries()) {
        emit(
            verifyPoint({
                status: 'running',
                name: point.name,
                command: point.command,
                index,
                of: points.length
            })
        )
        const {
            passed,
            refused,
            output: written
        } =
            point.tool ?
                await runToolPoint(point, host, domains, signal)
            :   await runShellPoint(point, env, signal)
        const output = tail(written)
        results.push({name: point.name, command: point.command, passed, refused, output})
        emit(
            verifyPoint({
                status: passed ? 'complete' : 'error',
                name: point.name,
                command: point.command,
                index,
                of: points.length,
                output: passed ? '' : output
            })
        )
    }
    return results
}

const verdict = result =>
    result.passed ? 'PASS'
    : result.refused ? 'REFUSED'
    : 'FAIL'

const points = count => (count === 1 ? '1 point' : `${count} points`)

/// A refused point never ran, so it is counted apart from the ones that ran and failed: the
/// first is the specification's to fix, the second the code's.
function sorted(results) {
    const all = results ?? []
    return {
        all,
        failed: all.filter(result => !result.passed && !result.refused),
        refused: all.filter(result => result.refused)
    }
}

export function verifySummary(results) {
    const {all, failed, refused} = sorted(results)
    if (failed.length === 0 && refused.length === 0) return undefined
    const lines = all.map(result => `  ${verdict(result)}  ${result.name}`)
    const heading =
        failed.length > 0 ?
            `Verification failed: ${failed.length} of ${all.length} points from this task's `
            + 'specification did not pass.'
        :   ''
    const unrun =
        refused.length > 0 ?
            `${points(refused.length)} could not run: the shell refused the line as written.`
        :   ''
    return [heading, unrun, lines.join('\n')].filter(Boolean).join('\n')
}

/// A refused point is named and not asked for: no change to the code turns it green, and a model
/// told to fix the code without touching the check will go looking for a third way.
export function verifyReport(results) {
    const {all, failed, refused} = sorted(results)
    if (failed.length === 0) return undefined
    const lines = all.map(result => `${verdict(result)}  ${result.name}\n      ${result.command}`)
    const detail = failed
        .map(result => `--- ${result.name}\n${result.output || '(no output)'}`)
        .join('\n\n')
    const unrun =
        refused.length > 0 ?
            `\n\n${points(refused.length)} marked REFUSED never ran: the shell refuses the line `
            + 'as the specification wrote it. That is not yours to fix. Say so in your answer '
            + 'and leave it.'
        :   ''
    return (
        `${failed.length} of ${all.length} verification points from this task's specification `
        + `failed. The work is not done until they pass.\n\n${lines.join('\n')}\n\n${detail}\n\n`
        + `Fix the code so these pass. Do not edit or delete the check to make it green.${unrun}`
    )
}
