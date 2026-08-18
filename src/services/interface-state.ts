/**
 * One remembered piece of interface state, and the rule that makes remembering it safe.
 *
 * The rule is always the same: the read is asynchronous, so anything that writes before it has
 * answered writes over the value it is waiting for. Three places needed it and each solved it
 * differently — the frame held itself closed, the router gated the whole application on a splash
 * screen, and the composer kept a ref naming the task its read was for. Two of the three were
 * inside components, where the join between reading and writing is the one part nothing tested.
 *
 * This is that join, once. A value is `isOpen: false` until its key has answered, `change` does
 * nothing while it is, and opening a different key closes what was open — which is what makes a
 * per-task value follow the task without a guard of its own.
 */

/**
 * Where a project's interface state is kept.
 *
 * Two methods, because that is all this needs and a test wants to supply both. `read` never
 * throws — a database that will not answer and a value written by an older version both mean
 * "there is nothing remembered", which is a value, not a failure.
 */
export type InterfaceStateStore = Readonly<{
    read: (key: string) => Promise<unknown>
    write: (key: string, value: unknown) => void
}>

export type RememberedState<Value> =
    Readonly<{isOpen: false}> | Readonly<{isOpen: true; value: Value}>

export type Remembered<Value> = Readonly<{
    /** Whether the key has been read yet, and what it said. */
    state: () => RememberedState<Value>
    subscribe: (listener: () => void) => () => void
    /**
     * Reads one key. Reading the same key twice reads it once; reading a different one closes what
     * was open first, so nothing writes one key's value under another key's name.
     *
     * A key of `undefined` means there is nowhere to remember this yet — a composer whose task has
     * not loaded. It opens on the default straight away and keeps what it is given in memory, so
     * the control it belongs to still works and nothing is written under a name nobody has.
     */
    open: (key: string | undefined) => Promise<void>
    /** Replaces the value and records it. Does nothing before the read has answered. */
    change: (next: Value | ((current: Value) => Value)) => void
}>

type RememberOptions<Value> = Readonly<{
    /** Turns whatever was stored — including nothing at all — into a value worth mounting on. */
    restore: (stored: unknown) => Value
    /**
     * Whether this value is not worth keeping. The key is forgotten rather than written, so an
     * emptied composer leaves no row behind rather than a row holding an empty string.
     */
    isEmpty?: (value: Value) => boolean
}>

/** What `open` was last asked for. Held by identity so a stale read can tell that it is stale. */
type OpenKey = Readonly<{key: string | undefined}>

const CLOSED = {isOpen: false} as const

export function rememberValue<Value>(
    store: InterfaceStateStore,
    {restore, isEmpty}: RememberOptions<Value>
): Remembered<Value> {
    let current: RememberedState<Value> = CLOSED
    let opened: OpenKey | undefined
    const listeners = new Set<() => void>()

    const publish = (next: RememberedState<Value>) => {
        current = next
        for (const listener of [...listeners]) listener()
    }

    return {
        state: () => current,
        subscribe(listener) {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
        async open(key) {
            // `opened` is compared before its key, because "never opened" and "opened on no key at
            // all" are both `undefined` and only one of them is already open.
            if (opened !== undefined && opened.key === key) return
            // Claimed before the read starts, so a second open of the same key does not read it
            // twice and a read that lands after the key moved on knows it is stale.
            const claim: OpenKey = {key}
            opened = claim
            if (current.isOpen) publish(CLOSED)
            if (key === undefined) {
                publish({isOpen: true, value: restore(undefined)})
                return
            }
            const stored = await store.read(key)
            if (opened !== claim) return
            publish({isOpen: true, value: restore(stored)})
        },
        change(next) {
            if (!current.isOpen || opened === undefined) return
            // The updater form, for the same reason React has one: a caller that appends to what is
            // already there does not have to hold a copy of it.
            const value =
                typeof next === 'function' ?
                    (next as (current: Value) => Value)(current.value)
                :   next
            if (value === current.value) return
            publish({isOpen: true, value})
            if (opened.key === undefined) return
            store.write(opened.key, isEmpty?.(value) === true ? undefined : value)
        }
    }
}
