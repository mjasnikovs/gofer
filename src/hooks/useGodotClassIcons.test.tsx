import {renderHook, waitFor} from '@testing-library/react'
import {describe, expect, it, vi} from 'vitest'
import {useGodotClassIcons} from './useGodotClassIcons'
import type {GodotCall} from '../models/workspace'
import type {GodotNode} from '../models/godot'

function node(type: string, children: GodotNode[] = []): GodotNode {
    return {name: type, type, icon: type, path: `/${type}`, children}
}

describe('useGodotClassIcons', () => {
    it('keeps asking for classes whose answer a redraw cancelled', async () => {
        let answer: (value: unknown) => void = () => undefined
        const call = vi.fn(
            () =>
                new Promise(resolve => {
                    answer = resolve
                })
        ) as unknown as GodotCall

        const first = node('Node2D', [node('SubViewport')])
        const {result, rerender} = renderHook(
            ({root}: {root: GodotNode}) => useGodotClassIcons(call, root, true),
            {initialProps: {root: first}}
        )

        // The editor touches the scene, so the tree is read again and comes back as a new object.
        rerender({root: node('Node2D', [node('SubViewport')])})
        answer({icons: {Node2D: 'AAA', SubViewport: 'BBB'}})

        await waitFor(() => {
            expect(Object.keys(result.current)).toContain('SubViewport')
        })
    })
})
