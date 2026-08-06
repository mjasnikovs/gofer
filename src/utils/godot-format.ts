import type {GodotNode, GodotValue} from '../models/godot'

/**
 * Presentation for the tagged values the addon encodes. Everything here is read-only text: a value
 * is written back through the typed command that owns it, never by parsing this string.
 */

/** Primitives keep their text; anything else falls back, so nothing renders as `[object Object]`. */
function asText(value: unknown, fallback = ''): string {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return fallback
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null ?
            (value as Readonly<Record<string, unknown>>)
        :   {}
}

function asGodotValue(value: unknown): GodotValue {
    const record = asRecord(value)
    return typeof record['type'] === 'string' ?
            (record as unknown as GodotValue)
        :   {type: 'opaque', value: record}
}

function formatEntries(value: unknown): string {
    if (!Array.isArray(value)) return ''
    return (value as readonly unknown[])
        .map(entry => {
            const record = asRecord(entry)
            return `${formatGodotValue(asGodotValue(record['key']))}: ${formatGodotValue(asGodotValue(record['value']))}`
        })
        .join(', ')
}

export function formatGodotValue(value: GodotValue): string {
    const inner = value.value
    switch (value.type) {
        case 'null':
            return 'null'
        case 'bool':
            return inner === true ? 'true' : 'false'
        case 'int':
        case 'float':
        case 'string':
            return asText(inner)
        case 'array':
            return `[${(Array.isArray(inner) ? (inner as readonly unknown[]) : [])
                .map(entry => formatGodotValue(asGodotValue(entry)))
                .join(', ')}]`
        case 'dictionary':
            return `{${formatEntries(inner)}}`
        case 'resource':
            return `${asText(asRecord(inner)['resourceType'], 'Resource')} ${asText(asRecord(inner)['path'])}`
        case 'node':
            return `${asText(asRecord(inner)['nodeType'], 'Node')} ${asText(asRecord(inner)['path'])}`
        case 'object':
            return asText(asRecord(inner)['className'], 'Object')
        case 'opaque':
            return asText(asRecord(inner)['text'], asText(asRecord(inner)['typeName']))
        default:
            // Vectors, colors, transforms, and quaternions all arrive as flat number arrays.
            return Array.isArray(inner) ?
                    `${value.type}(${(inner as readonly unknown[]).map(entry => asText(entry)).join(', ')})`
                :   asText(inner)
    }
}

export type PathTreeNode = Readonly<{
    name: string
    path: string
    isDirectory: boolean
    children: readonly PathTreeNode[]
}>

interface MutableTreeNode {
    name: string
    path: string
    isDirectory: boolean
    children: MutableTreeNode[]
}

/**
 * Folds a flat worktree listing into the folder hierarchy the explorer shows. Directories sort
 * before files so a deep project reads top-down rather than as an alphabetical mix.
 */
export function buildPathTree(paths: readonly string[]): readonly PathTreeNode[] {
    const roots: MutableTreeNode[] = []
    const directories = new Map<string, MutableTreeNode>()

    for (const path of [...paths].sort()) {
        const segments = path.split('/')
        let parent: MutableTreeNode | undefined
        let prefix = ''
        for (const [index, segment] of segments.entries()) {
            prefix = prefix === '' ? segment : `${prefix}/${segment}`
            const isDirectory = index < segments.length - 1
            const siblings = parent ? parent.children : roots
            let node = isDirectory ? directories.get(prefix) : undefined
            if (!node) {
                node = {name: segment, path: prefix, isDirectory, children: []}
                siblings.push(node)
                if (isDirectory) directories.set(prefix, node)
            }
            parent = node
        }
    }

    const sort = (nodes: MutableTreeNode[]): readonly PathTreeNode[] =>
        nodes
            .sort((left, right) =>
                left.isDirectory === right.isDirectory ?
                    left.name.localeCompare(right.name)
                :   Number(right.isDirectory) - Number(left.isDirectory)
            )
            .map(node => ({...node, children: sort(node.children)}))

    return sort(roots)
}

/**
 * Narrows a scene tree to what a filter names.
 *
 * A node matches on its name or its class, and a match keeps the branch that reaches it: a tree
 * pruned to bare matches would show `CollisionShape2D` with no clue which of five coins it belongs
 * to. Ancestors are kept for the path they draw, so what stays reads as the scene it came from.
 */
export function filterSceneTree(node: GodotNode, filter: string): GodotNode | undefined {
    const query = filter.trim().toLowerCase()
    if (query === '') return node
    const prune = (current: GodotNode): GodotNode | undefined => {
        const kept = current.children
            .map(child => prune(child))
            .filter((child): child is GodotNode => child !== undefined)
        const matches =
            current.name.toLowerCase().includes(query) || current.type.toLowerCase().includes(query)
        if (!matches && kept.length === 0) return undefined
        return {...current, children: kept}
    }
    return prune(node)
}
