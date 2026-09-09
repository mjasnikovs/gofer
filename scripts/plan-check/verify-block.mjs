// The VERIFY section's commands, in the two shapes real plans use: fenced
// shell, and bare `godot_runtime {json}` lines. A plan that has neither yields
// nothing.

import {sections} from './extract.mjs'

const FENCE = /```(?:sh|bash|shell)?\n([\s\S]*?)```/g

export function verifyCommands(text) {
    const body = sections(text)['VERIFY']
    if (!body) return {shell: [], runtime: []}
    const shell = []
    for (const m of body.matchAll(FENCE)) {
        for (const line of m[1].split('\n')) {
            const t = line.trim()
            if (t.length === 0 || t.startsWith('#')) continue
            shell.push(t)
        }
    }
    const runtime = []
    for (const line of body.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('godot_runtime')) continue
        const json = t.slice('godot_runtime'.length).trim()
        try {
            runtime.push({raw: t, spec: JSON.parse(json)})
        } catch {
            // Unparseable payload is undecided, never a finding.
            runtime.push({raw: t, spec: null})
        }
    }
    return {shell, runtime}
}

/** The scene a runtime spec runs, and every node path it then inspects. */
export function runtimeTargets(spec) {
    const ops = Array.isArray(spec?.ops) ? spec.ops : []
    const scene = ops.find(o => o?.op === 'run')?.scene ?? null
    const paths = ops.filter(o => typeof o?.path === 'string').map(o => o.path)
    return {scene, paths}
}
