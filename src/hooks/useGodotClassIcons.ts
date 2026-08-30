import {useEffect, useRef, useState} from 'react'
import type {GodotCall} from '../models/workspace'
import type {GodotNode} from '../models/godot'

const MAX_CLASSES_PER_REQUEST = 200

export type ClassIcons = Readonly<Record<string, string>>

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
