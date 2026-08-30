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
        `${reason} A verification point is one shell command and has no tools of its own — check `
        + 'this by booting the game instead, with `godot --headless --audio-driver Dummy --script '
        + '.gofer/checks/<name>.gd`.'
    )
}

export async function runVerifyPoints({points, env, emit, signal}) {
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
        const passed = outcome.ok && outcome.value.exitCode === 0
        const output =
            outcome.ok ?
                tail(`${outcome.value.stdout ?? ''}\n${outcome.value.stderr ?? ''}`)
            :   tail(String(outcome.error?.message ?? outcome.error ?? 'the command did not run'))
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
