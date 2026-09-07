import {verifyPoint} from './ai-events.mjs'
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

/// A point that names a godot tool, run through the same channel the model's own calls take.
///
/// It carries no clock of its own. What it waits for is the router, which serialises every call to
/// one editor, and the turn's signal, which is what a user pressing Stop moves.
async function runToolPoint(point, host, signal) {
    if (!host) {
        return {
            passed: false,
            output:
                `${point.tool} cannot be called here: this turn has no channel to the editor. `
                + 'Check this with a shell command instead.'
        }
    }
    try {
        const answered = JSON.stringify((await host.call(point.tool, point.params, signal)) ?? null)
        if (point.contains && !answered.includes(point.contains)) {
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
    let outcome
    try {
        validateBashCommand(point.command)
        outcome = await env.exec(point.command, {
            timeout: POINT_TIMEOUT_SECONDS,
            abortSignal: signal
        })
    } catch (error) {
        outcome = {ok: false, error: {message: refusedPoint(error)}}
    }
    return {
        passed: outcome.ok && outcome.value.exitCode === 0,
        output:
            outcome.ok ?
                `${outcome.value.stdout ?? ''}\n${outcome.value.stderr ?? ''}`
            :   String(outcome.error?.message ?? outcome.error ?? 'the command did not run')
    }
}

export async function runVerifyPoints({points, env, host, emit, signal}) {
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
        const {passed, output: written} =
            point.tool ?
                await runToolPoint(point, host, signal)
            :   await runShellPoint(point, env, signal)
        const output = tail(written)
        results.push({name: point.name, command: point.command, passed, output})
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

export function verifySummary(results) {
    const failed = (results ?? []).filter(result => !result.passed)
    if (failed.length === 0) return undefined
    const lines = results.map(result => `  ${result.passed ? 'PASS' : 'FAIL'}  ${result.name}`)
    return (
        `Verification failed: ${failed.length} of ${results.length} points from this task's `
        + `specification did not pass.\n${lines.join('\n')}`
    )
}

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
