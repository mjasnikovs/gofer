import {useLayoutEffect, useRef, useState} from 'react'
import type {RefObject} from 'react'
import {settleCollapse} from '../utils/collapse'

type StackedLanes = readonly [
    isStacked: boolean,
    board: RefObject<HTMLDivElement | null>,
    lanes: RefObject<HTMLDivElement | null>
]

/**
 * The board is a centre tab, so its width follows the side panels rather than the window. The
 * lanes row only exists side by side; stacked, the board itself is what regains the width.
 */
export function useStackedLanes(): StackedLanes {
    const [isStacked, setIsStacked] = useState(false)
    const board = useRef<HTMLDivElement>(null)
    const lanes = useRef<HTMLDivElement>(null)
    const needed = useRef(0)

    useLayoutEffect(() => {
        const node = board.current
        if (!node) return undefined
        const measure = () => {
            const row = lanes.current
            const fit =
                row ?
                    {available: row.clientWidth, content: row.scrollWidth}
                :   {available: node.clientWidth, content: node.clientWidth}
            setIsStacked(wasStacked => settleCollapse(wasStacked, fit, needed))
        }
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        measure()
        return () => {
            observer.disconnect()
        }
    }, [isStacked])

    return [isStacked, board, lanes]
}
