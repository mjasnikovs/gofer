import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render} from '@testing-library/react'
import {flushSync} from 'react-dom'
import {createRoot} from 'react-dom/client'
import {SketchFrame} from './SketchFrame'

afterEach(cleanup)

const CANVAS = {width: 1280, height: 720}

/** jsdom measures everything as zero, and a sketch in a zero-wide column has no scale. */
const COLUMN = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 640,
    bottom: 360,
    width: 640,
    height: 360
} as DOMRect

beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(COLUMN)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('SketchFrame', () => {
    /**
     * The sandbox is the whole security story and it is one attribute.
     *
     * `allow-same-origin` gives the frame nothing, because without `allow-scripts` no code in it
     * runs. Adding `allow-scripts` beside it would turn a safe pair into the unsafe one, so the
     * absence is asserted rather than assumed.
     */
    it('runs the sketch with no way to execute anything', () => {
        const {container} = render(
            <SketchFrame
                html='<p>hello</p>'
                canvasSize={CANVAS}
            />
        )
        const frame = container.querySelector('iframe')
        expect(frame?.getAttribute('sandbox')).toBe('allow-same-origin')
        expect(frame?.getAttribute('sandbox')).not.toContain('allow-scripts')
    })

    /** Gofer's reset goes in front of the agent's markup, and nothing else does. */
    it('serves the reset before whatever the agent wrote', () => {
        const {container} = render(
            <SketchFrame
                html='<p>hello</p>'
                canvasSize={CANVAS}
            />
        )
        const document = container.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
        expect(document).toMatch(/^<style>\*,\*::before/u)
        expect(document).toContain('<p>hello</p>')
        expect(document).not.toMatch(/--color-/u)
    })

    /**
     * The sketch is drawn at its own size and shrunk, not reflowed into the column.
     *
     * A game's layout is a fixed number of pixels. Reflowed it is a different design from the one
     * being judged; drawn at its own width it is cut off by the column edge, which shipped first.
     */
    it('draws at the sketch size and scales it to the column', () => {
        const {container} = render(
            <SketchFrame
                html='<p>hello</p>'
                canvasSize={CANVAS}
            />
        )
        const frame = container.querySelector('iframe')
        expect(frame?.getAttribute('width')).toBe('1280')
        expect(frame?.getAttribute('height')).toBe('720')
        // 640 of column for 1280 of sketch.
        expect(frame?.style.transform).toBe('scale(0.5)')
        expect(frame?.style.transformOrigin).toBe('top left')
    })

    /**
     * The sketch leaves room for everything under it.
     *
     * Scaled to the column alone, a 1280x720 sketch is 650 pixels tall and pushes the button that
     * answers the question off the bottom of the dialog. A share of the window did not fix it
     * either: the rest of the dialog is a fixed number of pixels, not a fraction, so on a short
     * window a fraction still left too little.
     */
    it('leaves the window height the rest of the dialog needs', () => {
        const {container} = render(
            <SketchFrame
                html='<p>hello</p>'
                canvasSize={CANVAS}
                spare={468}
            />
        )
        // jsdom reports a 768-tall window, so 300 pixels are left for 720 of sketch — tighter than
        // the half the column width would have allowed.
        const wanted = (window.innerHeight - 468) / 720
        expect(container.querySelector('iframe')?.style.transform).toBe(`scale(${String(wanted)})`)
    })

    /** A window too short for both keeps a thumbnail rather than shrinking the sketch to nothing. */
    it('never shrinks below a thumbnail', () => {
        const {container} = render(
            <SketchFrame
                html='<p>hello</p>'
                canvasSize={CANVAS}
                spare={10_000}
            />
        )
        expect(container.querySelector('iframe')?.style.transform).toBe(
            `scale(${String(160 / 720)})`
        )
    })

    /** A sketch smaller than the column is left alone rather than blown up. */
    it('never scales a sketch above its own size', () => {
        const {container} = render(
            <SketchFrame
                html='<p>hello</p>'
                canvasSize={{width: 320, height: 180}}
            />
        )
        expect(container.querySelector('iframe')?.style.transform).toBe('scale(1)')
    })

    /**
     * The first frame the browser paints already has the sketch in it.
     *
     * The scale is nothing until the column has been measured, and the measurement is what a mount
     * does. Taken in a passive effect it lands *after* the browser has painted, so every mount put
     * one frame of a zero-height, zero-scale box on screen and then jumped — which is a blink on
     * first open and a blink on every reopen now that the closed rows are unmounted.
     *
     * `flushSync` commits the render and its layout effects and returns; the passive queue is still
     * pending. So this is exactly what the browser would have had to paint.
     */
    it('has measured itself before the first paint', () => {
        const container = document.createElement('div')
        document.body.append(container)
        const root = createRoot(container)
        const environment = globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean | undefined}
        const wasActing = environment.IS_REACT_ACT_ENVIRONMENT
        environment.IS_REACT_ACT_ENVIRONMENT = false
        try {
            flushSync(() => {
                root.render(
                    <SketchFrame
                        html='<p>hello</p>'
                        canvasSize={CANVAS}
                    />
                )
            })
            expect(container.querySelector('iframe')?.style.transform).toBe('scale(0.5)')
        } finally {
            environment.IS_REACT_ACT_ENVIRONMENT = wasActing
            act(() => {
                root.unmount()
            })
            container.remove()
        }
    })

    /**
     * A sketch taller than it was asked to be is shown in full, not cut off at the line.
     *
     * The model is told to draw at 1280x720. One that draws 900 tall must not have the bottom of its
     * own layout hidden by a wrapper that trusted the instruction over the result.
     */
    it('grows to whatever the sketch actually laid out', () => {
        const {container} = render(
            <SketchFrame
                html='<p>hello</p>'
                canvasSize={CANVAS}
            />
        )
        const frame = container.querySelector('iframe')
        if (!frame) throw new Error('the frame is an iframe')
        const document = frame.contentDocument
        if (!document) throw new Error('jsdom gives an iframe a document')
        Object.defineProperty(document.documentElement, 'scrollHeight', {value: 900})

        // The height lives in state, so the load has to be flushed before the attribute is read.
        act(() => {
            frame.dispatchEvent(new Event('load'))
        })

        expect(frame.getAttribute('height')).toBe('900')
    })

    /**
     * The listener is re-attached on every document, because setting `srcdoc` navigates the frame.
     *
     * Attached once, it would sit on a document that no longer exists and a revision would silently
     * stop reporting what it could not load — the one thing nobody else can find out.
     */
    it('watches each document it is handed for what the policy refuses', () => {
        const onBlocked = vi.fn()
        const {container} = render(
            <SketchFrame
                html='<p>hello</p>'
                canvasSize={CANVAS}
                onBlocked={onBlocked}
            />
        )
        const frame = container.querySelector('iframe')
        if (!frame) throw new Error('the frame is an iframe')
        const document = frame.contentDocument
        if (!document) throw new Error('jsdom gives an iframe a document')

        frame.dispatchEvent(new Event('load'))
        const violation = new Event('securitypolicyviolation')
        Object.defineProperty(violation, 'blockedURI', {value: 'https://fonts.test/a.woff'})
        document.dispatchEvent(violation)

        expect(onBlocked).toHaveBeenCalledWith('https://fonts.test/a.woff')
    })
})
