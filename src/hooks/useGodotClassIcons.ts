import {useEffect, useRef, useState} from 'react'
import type {GodotCall} from '../models/workspace'
import type {GodotNode} from '../models/godot'

/** The addon answers at most this many classes at once, so one request covers one tree. */
const MAX_CLASSES_PER_REQUEST = 200

export type ClassIcons = Readonly<Record<string, string>>

/** Every class a tree draws with, in the order first met, each named once. */
export function iconClasses(root: GodotNode | null | undefined): string[] {
    const names: string[] = []
    const seen = new Set<string>()
    const walk = (node: GodotNode) => {
        const name = node.icon ?? node.type
        if (name !== '' && !seen.has(name)) {
            seen.add(name)
            names.push(name)
        }
        for (const child of node.children) walk(child)
    }
    if (root) walk(root)
    return names
}

/**
 * The editor icons a scene tree needs, as `data:` URLs keyed by class.
 *
 * The editor is asked once per class and the answers are kept: a class icon does not change while
 * a session runs, and a tree that refetches every time the editor touches the scene would
 * otherwise re-fetch the same artwork on every keystroke. A request that fails leaves its classes
 * unasked, so the next refetch tries again — the icons are decoration, never a reason to fail the
 * tree, and the panel draws without them until they arrive.
 *
 * Nothing here is cancelled on cleanup. A class icon is not an answer to the tree that asked for
 * it, so a newer tree never makes it stale — and this effect re-runs on every tree, because the
 * editor hands back a new object each time it touches the scene. Dropping the answer there lost
 * the artwork for good: the classes were already marked asked, so no later tree asked again, and
 * a scene built while the agent was editing it came out with icons on the nodes added between
 * edits and blank rows for every node added during one.
 */
export function useGodotClassIcons(
    call: GodotCall,
    root: GodotNode | null | undefined,
    isEnabled: boolean
): ClassIcons {
    const [icons, setIcons] = useState<ClassIcons>({})
    const asked = useRef(new Set<string>())

    useEffect(() => {
        if (!isEnabled) return
        const missing = iconClasses(root)
            .filter(name => !asked.current.has(name))
            .slice(0, MAX_CLASSES_PER_REQUEST)
        if (missing.length === 0) return
        for (const name of missing) asked.current.add(name)
        void call('editor.get_class_icons', {classes: missing})
            .then(answer => {
                const fetched: Record<string, string> = {}
                // An addon too old to know the command answers an empty result rather than a map.
                for (const [name, data] of Object.entries(answer.icons ?? {})) {
                    fetched[name] = `data:image/png;base64,${data}`
                }
                setIcons(current => ({...current, ...fetched}))
            })
            .catch(() => {
                for (const name of missing) asked.current.delete(name)
            })
    }, [call, isEnabled, root])

    return icons
}
