import {useCallback, useLayoutEffect, useRef, useState} from 'react'
import {IconButton} from '@astryxdesign/core/IconButton'
import {Icon} from '@astryxdesign/core/Icon'
import MagnifyingGlassPlusIcon from '@heroicons/react/24/outline/MagnifyingGlassPlusIcon'
import {VStack} from '@astryxdesign/core/Stack'
import {sketchDocument} from '../../models/sketch'

type SketchFrameProps = Readonly<{
    html: string
    canvasSize: Readonly<{width: number; height: number}>
    spare?: number | undefined
    grows?: boolean | undefined
    onBlocked?: ((uri: string) => void) | undefined
    onOpen?: (() => void) | undefined
    openLabel?: string | undefined
}>

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
    const [available, setAvailable] = useState({width: 0, height: 0})
    const [drawn, setDrawn] = useState(canvasSize.height)
    const height = grows ? Math.max(canvasSize.height, drawn) : canvasSize.height
    const room = Math.max(160, available.height - spare)
    const scale =
        available.width > 0 ? Math.min(1, available.width / canvasSize.width, room / height) : 0

    const onLoaded = useCallback(() => {
        const document = frame.current?.contentDocument
        if (!document) return
        if (onBlocked)
            document.addEventListener('securitypolicyviolation', event => {
                onBlocked(event.blockedURI)
            })
        setDrawn(document.documentElement.scrollHeight)
    }, [onBlocked])

    useLayoutEffect(() => {
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
        <VStack
            ref={column}
            width='100%'
            maxWidth='100%'
            height={height * scale}
            style={{
                minWidth: 0
            }}
        >
            <VStack
                width={canvasSize.width * scale}
                height={height * scale}
                style={{
                    position: 'relative',
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
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        border: 0,
                        display: 'block',
                        borderRadius: 'var(--radius-md)',
                        transform: `scale(${String(scale)})`,
                        transformOrigin: 'top left',
                        background: 'var(--gofer-sketch-paper, #ffffff)'
                    }}
                />
                {onOpen && (
                    <VStack
                        style={{
                            position: 'absolute',
                            top: 'var(--spacing-2)',
                            right: 'var(--spacing-2)'
                        }}
                    >
                        <IconButton
                            label={openLabel}
                            icon={<Icon icon={MagnifyingGlassPlusIcon} />}
                            variant='secondary'
                            size='sm'
                            elevation='med'
                            onClick={onOpen}
                        />
                    </VStack>
                )}
            </VStack>
        </VStack>
    )
}
