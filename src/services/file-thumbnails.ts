import {invoke} from './desktop'

const MAX_IN_FLIGHT = 3

const known = new Map<string, string | null>()
const waiting: string[] = []
const inFlight = new Set<string>()
const listeners = new Set<() => void>()
let generation = 0

function fetchThumbnail(path: string): Promise<string | null> {
    return invoke('read_workspace_thumbnail', {path})
}

let request = fetchThumbnail

export function setThumbnailRequest(next: (path: string) => Promise<string | null>) {
    request = next
}

export function clearThumbnails() {
    known.clear()
    waiting.length = 0
    inFlight.clear()
    generation += 1
    announce()
}

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
        const started = generation
        const record = (url: string | null) => {
            if (started === generation) known.set(path, url)
        }
        void request(path)
            .then(record)
            .catch(() => {
                record(null)
            })
            .finally(() => {
                inFlight.delete(path)
                announce()
                pump()
            })
    }
}

export function thumbnailFor(path: string): string | null | undefined {
    return known.get(path)
}

export function requestThumbnail(path: string) {
    if (known.has(path) || inFlight.has(path) || waiting.includes(path)) return
    waiting.push(path)
    pump()
}

export function watchThumbnails(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}
