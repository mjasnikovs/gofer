import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render} from '@testing-library/react'
import {flushSync} from 'react-dom'
import {createRoot} from 'react-dom/client'
import {SketchFrame} from './SketchFrame'

afterEach(cleanup)

const CANVAS = {width: 1280, height: 720}

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
        expect(frame?.style.transform).toBe('scale(0.5)')
        expect(frame?.style.transformOrigin).toBe('top left')
    })

    it('leaves the window height the rest of the dialog needs', () => {
        const {container} = render(
            <SketchFrame
                html='<p>hello</p>'
                canvasSize={CANVAS}
                spare={468}
            />
        )
        const wanted = (window.innerHeight - 468) / 720
        expect(container.querySelector('iframe')?.style.transform).toBe(`scale(${String(wanted)})`)
    })

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

    it('never scales a sketch above its own size', () => {
        const {container} = render(
            <SketchFrame
                html='<p>hello</p>'
                canvasSize={{width: 320, height: 180}}
            />
        )
        expect(container.querySelector('iframe')?.style.transform).toBe('scale(1)')
    })

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

        act(() => {
            frame.dispatchEvent(new Event('load'))
        })

        expect(frame.getAttribute('height')).toBe('900')
    })

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
