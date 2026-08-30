export type TurnKind = 'chat' | 'brief' | 'memory'

const running = new Set<TurnKind>()
const watchers = new Set<() => void>()

export function watchTurn(notify: () => void) {
    watchers.add(notify)
    return () => {
        watchers.delete(notify)
    }
}

export function isTurnRunning() {
    return running.size > 0
}

export function setTurnRunning(kind: TurnKind, next: boolean) {
    const was = isTurnRunning()
    if (next) running.add(kind)
    else running.delete(kind)
    if (was === isTurnRunning()) return
    for (const notify of watchers) notify()
}

export function clearTurnActivity() {
    running.clear()
    for (const notify of watchers) notify()
}
