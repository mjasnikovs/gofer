import {useCallback, useLayoutEffect, useRef, useState} from 'react'

type CompactTabs = readonly [isCompact: boolean, onStrip: (node: HTMLElement | null) => void]

/**
 * Astryx caps a tab strip at its parent's width but lets tabs that do not fit paint
 * outside it, where they leave the window entirely. Rather than guess a breakpoint,
 * measure the strip: the labels come off exactly when they stop fitting, and go back
 * on when the width they needed is available again. Expanding into a width that turns
 * out too small records the larger requirement, so the two states settle rather than
 * trade places forever.
 */
export function useCompactTabs(): CompactTabs {
    const [isCompact, setIsCompact] = useState(false)
    const strip = useRef<HTMLElement | null>(null)
    const widthWithLabels = useRef(0)

    // TabList merges this with its own ref, which React detaches and re-attaches on
    // every render, so measuring here would set state in a loop. Only record the node.
    const onStrip = useCallback<(node: HTMLElement | null) => void>(node => {
        strip.current = node
    }, [])

    useLayoutEffect(() => {
        const node = strip.current
        if (!node) return undefined
        const measure = () => {
            setIsCompact(compact => {
                if (compact) return node.clientWidth < widthWithLabels.current
                widthWithLabels.current = node.scrollWidth
                return node.scrollWidth > node.clientWidth
            })
        }
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        // A tab gaining a badge widens that tab without resizing the strip, so
        // watching only the strip would never notice the content outgrowing it.
        const watchTabs = () => {
            for (const tab of node.children) observer.observe(tab)
            measure()
        }
        watchTabs()
        // Opening a script adds a tab. Hiding a label only rewrites a button's
        // contents, so childList on the strip itself cannot see its own effect.
        const tabs = new MutationObserver(watchTabs)
        tabs.observe(node, {childList: true})
        return () => {
            observer.disconnect()
            tabs.disconnect()
        }
    }, [])

    return [isCompact, onStrip]
}
