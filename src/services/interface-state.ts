export type InterfaceStateStore = Readonly<{
    read: (key: string) => Promise<unknown>
    write: (key: string, value: unknown) => void
}>

export type RememberedState<Value> =
    Readonly<{isOpen: false}> | Readonly<{isOpen: true; value: Value}>

export type Remembered<Value> = Readonly<{
    state: () => RememberedState<Value>
    subscribe: (listener: () => void) => () => void
    open: (key: string | undefined) => Promise<void>
    change: (next: Value | ((current: Value) => Value)) => void
}>

type RememberOptions<Value> = Readonly<{
    restore: (stored: unknown) => Value
    isEmpty?: (value: Value) => boolean
}>

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
            if (opened !== undefined && opened.key === key) return
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
