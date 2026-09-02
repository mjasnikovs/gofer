import {useCallback, useLayoutEffect, useRef, useState} from 'react'

type CompactTabs = readonly [isCompact: boolean, onStrip: (node: HTMLElement | null) => void]

// TabList's ref lands on its outer landmark, and the tabs live in a scrolling strip
// inside it. That strip is the only box whose overflow is the tabs' own.
function stripOf(node: HTMLElement): HTMLElement {
    return node.querySelector<HTMLElement>('.astryx-tab-strip') ?? node
}

/**
 * Astryx answers tabs that do not fit by scrolling them out of sight, where they are
 * gone as far as anyone using a strip with no scrollbar can tell. Rather than guess a
 * breakpoint, measure the strip: the labels come off exactly when they stop fitting,
 * and go back on when the width they needed is available again. Expanding into a width
 * that turns out too small records the larger requirement, so the two states settle
 * rather than trade places forever.
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
        const root = strip.current
        if (!root) return undefined
        const node = stripOf(root)
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
