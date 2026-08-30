import {readFileSync} from 'node:fs'

type TauriWindow = Readonly<{
    width: number
    height: number
    minWidth: number
    minHeight: number
}>

const conf = JSON.parse(
    readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')
) as {
    app: {windows: readonly TauriWindow[]}
}

// Tauri's width/height IS the webview size, so a Playwright viewport of the same
// numbers is the shipped window and not an approximation of it.
const window = conf.app.windows[0]

if (!window) throw new Error('tauri.conf.json declares no window')

export const DEFAULT_WINDOW = {width: window.width, height: window.height}
export const SMALLEST_WINDOW = {width: window.minWidth, height: window.minHeight}

// Two points cannot find a layout that breaks in the middle and recovers, and this
// one does: the toolbar overflows near 800 while 720 and 880 are clean.
export const WINDOW_SWEEP = Array.from(
    {length: Math.floor((DEFAULT_WINDOW.width - SMALLEST_WINDOW.width) / 80) + 1},
    (_, step) => ({
        width: SMALLEST_WINDOW.width + step * 80,
        height: SMALLEST_WINDOW.height
    })
)
