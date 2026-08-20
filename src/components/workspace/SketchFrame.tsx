import {useCallback, useEffect, useRef, useState} from 'react'
import {IconButton} from '@astryxdesign/core/IconButton'
import {Icon} from '@astryxdesign/core/Icon'
import MagnifyingGlassPlusIcon from '@heroicons/react/24/outline/MagnifyingGlassPlusIcon'
import {sketchDocument} from '../../models/sketch'

type SketchFrameProps = Readonly<{
    /** The markup the agent wrote, before Gofer's reset is put in front of it. */
    html: string
    /**
     * The size the sketch is drawn at, before it is scaled to fit.
     *
     * A game's layout is a fixed number of pixels — 1280x720, not "whatever the column gives it".
     * Reflowed into the column's width it is a different design from the one being judged, and drawn
     * at its own width it is cut off by the column edge, which is what shipped first.
     */
    canvasSize: Readonly<{width: number; height: number}>
    /**
     * How much of the window height everything *else* needs, in pixels.
     *
     * Scaled to the column's width alone, a 1280x720 sketch is 650 pixels tall and pushes the button
     * that answers the question off the bottom of the dialog — the complaint this surface has had
     * twice. A share of the window did not fix it either: the rest of the dialog is a fixed number of
     * pixels, not a fraction, so on a short window a fraction still leaves too little. This says what
     * the sketch must leave behind, which is the thing that is actually known.
     */
    spare?: number | undefined
    /**
     * Whether the frame may grow past `canvasSize` to whatever the sketch laid out.
     *
     * Off when sketches are shown side by side. Each one measures its own content, so one that laid
     * out taller than another got a different scale, and two boxes of different heights are two
     * layouts that cannot be compared. On its own there is nothing to compare it with, and being cut
     * off at 720 is the worse mistake.
     */
    grows?: boolean | undefined
    /**
     * Called once per resource the policy refuses, as it is refused.
     *
     * The one thing the frame knows that nobody else can find out. Nothing inside it runs, so it has
     * no console anybody reads, and a webfont that never arrived would otherwise reach the agent as
     * "the user says it looks wrong" with no cause attached to it.
     */
    onBlocked?: ((uri: string) => void) | undefined
    /**
     * Opens this sketch on its own, as a magnifier over the corner of it.
     *
     * A button beside the label saying "Open" answers a question nobody asked — open what, and into
     * what. A magnifier on the picture says which picture and what will happen to it.
     */
    onOpen?: (() => void) | undefined
    /** What the magnifier is called to anything that cannot see it. */
    openLabel?: string | undefined
}>

/**
 * The sketch itself: the agent's markup, under glass.
 *
 * `srcdoc` rather than a `blob:` URL or a protocol of our own, and the reason is not convenience.
 * A `srcdoc` document's URL is `about:srcdoc`, which WebKit exempts from `frame-src` before the
 * directive is consulted at all, and which inherits the window's whole content policy — so the frame
 * runs under exactly the rules we would have written by hand and we did not have to write them.
 *
 * Measured against webkit2gtk-4.1 2.52.5, which is the engine this application ships on, under the
 * exact policy in `tauri.conf.json`: the frame loads, `contentDocument` is readable, an inline
 * `<style>` applies, and a remote `<img>` never arrives. A `blob:` URL would have needed the policy
 * widened, because `blob:` is not `about:`.
 *
 * `allow-same-origin` with no `allow-scripts` is the sandbox. It gives the *frame* nothing, because
 * no code in it runs; it gives *us* the one thing this surface needs — the policy violations above,
 * which are otherwise invisible to everybody including the agent that caused them.
 */
export function SketchFrame({
    html,
    canvasSize,
    spare = 340,
    grows = true,
    onBlocked,
    onOpen,
    openLabel = 'Open this sketch'
}: SketchFrameProps) {
    const column = useRef<HTMLDivElement>(null)
    const frame = useRef<HTMLIFrameElement>(null)
    // How wide the column turned out to be. Everything else follows from it.
    const [available, setAvailable] = useState({width: 0, height: 0})
    // How tall the sketch turned out to be, once it had laid itself out.
    //
    // The model is told to draw at 1280x720, and a model that draws 900 tall must not have the
    // bottom of its own layout hidden by a wrapper that trusted the instruction over the result.
    const [drawn, setDrawn] = useState(canvasSize.height)
    const height = grows ? Math.max(canvasSize.height, drawn) : canvasSize.height
    // Never smaller than a thumbnail: a window too short for both is a window the dialog scrolls in,
    // and a sketch shrunk to nothing there would be worse than the scrollbar.
    const room = Math.max(160, available.height - spare)
    const scale =
        available.width > 0 ? Math.min(1, available.width / canvasSize.width, room / height) : 0

    // Re-attached on every document, because setting `srcdoc` navigates the frame: the listener was
    // registered on a document that no longer exists, and a revision would silently stop reporting.
    const onLoaded = useCallback(() => {
        const document = frame.current?.contentDocument
        if (!document) return
        if (onBlocked)
            document.addEventListener('securitypolicyviolation', event => {
                onBlocked(event.blockedURI)
            })
        setDrawn(document.documentElement.scrollHeight)
    }, [onBlocked])

    useEffect(() => {
        const element = column.current
        if (!element) return
        const measure = () => {
            setAvailable({
                width: element.getBoundingClientRect().width,
                height: window.innerHeight
            })
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        window.addEventListener('resize', measure)
        return () => {
            observer.disconnect()
            window.removeEventListener('resize', measure)
        }
    }, [])

    return (
        <div
            ref={column}
            style={{
                // A flex or grid item sizes itself from its content unless told not to, and the
                // content here is 1280 pixels wide however small the column is. Two sketches side by
                // side became one sketch and a sliver.
                width: '100%',
                minWidth: 0,
                maxWidth: '100%',
                height: height * scale
            }}
        >
            {/*
             * Sized to the sketch, not to the column.
             *
             * When the window's height is what caps the scale, the sketch is narrower than the space
             * it sits in — and a magnifier pinned to the column's corner floats in the gap beside
             * the picture it belongs to. Centred, because a sketch off to one side under a
             * full-width button reads as a mistake.
             */}
            <div
                style={{
                    position: 'relative',
                    width: canvasSize.width * scale,
                    height: height * scale,
                    margin: '0 auto',
                    overflow: 'hidden'
                }}
            >
                <iframe
                    ref={frame}
                    title='Sketch'
                    sandbox='allow-same-origin'
                    srcDoc={sketchDocument(html)}
                    onLoad={onLoaded}
                    width={canvasSize.width}
                    height={height}
                    style={{
                        // Out of flow, so a 1280-wide frame can never be what an ancestor measures
                        // itself against.
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        border: 0,
                        display: 'block',
                        borderRadius: 'var(--radius-md)',
                        // Drawn full size and shrunk, rather than reflowed. `top left` so the shrunk
                        // sketch starts where its box does instead of drifting off its own middle.
                        transform: `scale(${String(scale)})`,
                        transformOrigin: 'top left',
                        // The sketch chooses its own ground. Left transparent it would borrow this
                        // application's, which is the one colour a game menu must not be judged
                        // against.
                        background: '#ffffff'
                    }}
                />
                {onOpen && (
                    <div style={{position: 'absolute', top: 8, right: 8}}>
                        <IconButton
                            label={openLabel}
                            icon={<Icon icon={MagnifyingGlassPlusIcon} />}
                            variant='secondary'
                            size='sm'
                            elevation='med'
                            onClick={onOpen}
                        />
                    </div>
                )}
            </div>
        </div>
    )
}
