import {invoke} from './desktop'

/**
 * The `data:` squares the `@` menu draws, fetched once per path and kept.
 *
 * Three things shape this. The menu re-ranks on every keystroke, so a row mounts and unmounts
 * constantly and the cache has to outlive it — hence a module holding a `Map` rather than state in
 * a component. Twenty rows asking at once would put twenty full-size textures through a decoder
 * simultaneously, so the queue below runs a few at a time. And a square is decoration: a path that
 * fails is remembered as having no preview rather than retried on the next keystroke.
 *
 * Nothing expires. The agent can overwrite a sprite mid-turn and the menu will keep showing the old
 * square until the window is reopened. That is the trade for never re-reading a texture the user
 * has already scrolled past; a stale 16px square costs nothing, and the path it inserts is right
 * either way.
 */

/** How many decodes run at once. A 4K texture is tens of megabytes unpacked, so this stays small. */
const MAX_IN_FLIGHT = 3

/** `null` marks a path that has no preview, which is an answer and not a reason to ask again. */
const known = new Map<string, string | null>()
const waiting: string[] = []
/**
 * The paths being decoded right now.
 *
 * Without it a path in flight is in neither `known` nor `waiting`, so the next keystroke queues it
 * again and the same texture is decoded three times over.
 */
const inFlight = new Set<string>()
const listeners = new Set<() => void>()

function fetchThumbnail(path: string): Promise<string | null> {
    return invoke('read_workspace_thumbnail', {path})
}

let request = fetchThumbnail

/** Swaps the backend call. For tests, which have no Tauri to answer them. */
export function setThumbnailRequest(next: (path: string) => Promise<string | null>) {
    request = next
}

/**
 * Empties the cache and the queue.
 *
 * Called when the active task changes, which moves the one checkout onto another branch: the paths
 * stay the same and the files behind them do not, so every square held is now a picture of
 * something else.
 */
export function clearThumbnails() {
    known.clear()
    waiting.length = 0
    inFlight.clear()
    announce()
}

/** `clearThumbnails`, plus the real backend call back. For tests. */
export function resetThumbnails() {
    clearThumbnails()
    listeners.clear()
    request = fetchThumbnail
}

function announce() {
    for (const listener of listeners) listener()
}

function pump() {
    while (inFlight.size < MAX_IN_FLIGHT && waiting.length > 0) {
        const path = waiting.shift()
        if (path === undefined || known.has(path)) continue
        inFlight.add(path)
        void request(path)
            .then(url => {
                known.set(path, url)
            })
            .catch(() => {
                // A file the agent is half-way through writing, or one that will not decode. Either
                // way the row shows its kind icon and the name is still there to pick.
                known.set(path, null)
            })
            .finally(() => {
                inFlight.delete(path)
                announce()
                pump()
            })
    }
}

/** The square for a path, `null` when there is none, and `undefined` while it is still unknown. */
export function thumbnailFor(path: string): string | null | undefined {
    return known.get(path)
}

/** Puts a path in the queue. Does nothing for one already answered or already queued. */
export function requestThumbnail(path: string) {
    if (known.has(path) || inFlight.has(path) || waiting.includes(path)) return
    waiting.push(path)
    pump()
}

/** Calls back whenever a square arrives. Returns the unsubscribe. */
export function watchThumbnails(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}
