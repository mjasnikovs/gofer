import {useCallback, useEffect, useRef, useState} from 'react'
import {listCards} from '../services/board'
import {listProjectMemory} from '../services/project-memory'
import {listProjectSketches} from '../services/project-sketches'
import {listTaskChanges} from '../services/task-changes'
import {watchProjectChange} from '../services/project-changes'
import type {ProjectValue} from '../models/project-changes'

/** Where a value is read from, and what says it may have moved since. */
export type ValueSource<T> = Readonly<{
    read: () => Promise<T>
    /** Calls `changed` whenever the value may have moved; answers the stop. */
    watch: (changed: () => void) => () => void
}>

export type StoredValue<S> = Readonly<{
    value: S
    /** Why the latest read failed. The value it leaves is the last one a read answered, if any. */
    failure: unknown
    /** A read this screen asked for has not answered yet. A change read quietly never sets it. */
    isLoading: boolean
    /** Reads again, loading until it answers. */
    reload: () => void
    /** Reads again quietly, for a trigger the source does not watch. */
    changed: () => void
}>

interface Store<T> {
    value: T | undefined
    failure: unknown
    started: number
    answered: number
    isReading: boolean
    /** A read is owed: after the one running, or on the next microtask when none is. */
    isDue: boolean
    readonly looks: Set<() => void>
    stop: () => void
}

type Seen<S> = Readonly<{value: S; failure: unknown; isLoading: boolean}>

// One store per source while anything shows it, so screens and cards that show one value share
// its reads and its one subscription.
const stores = new Map<ValueSource<unknown>, Store<unknown>>()

function open<T>(source: ValueSource<T>): Store<T> {
    const held = stores.get(source) as Store<T> | undefined
    if (held) return held
    const store: Store<T> = {
        value: undefined,
        failure: undefined,
        started: 0,
        answered: 0,
        isReading: false,
        isDue: false,
        looks: new Set(),
        stop: () => undefined
    }
    stores.set(source, store)
    store.stop = source.watch(() => {
        if (stores.get(source) === store) ask(source, store)
    })
    return store
}

function close<T>(source: ValueSource<T>, store: Store<T>, look: () => void) {
    store.looks.delete(look)
    if (store.looks.size > 0) return
    stores.delete(source)
    store.stop()
}

/**
 * The number of a read that starts no earlier than now. Everything that asks before it starts
 * shares it, which is what a read already running cannot offer: it may predate the write that
 * asked. Started a microtask late, so whatever mounts in one commit shares one read.
 */
function ask<T>(source: ValueSource<T>, store: Store<T>): number {
    if (!store.isDue) {
        store.isDue = true
        if (!store.isReading)
            queueMicrotask(() => {
                if (store.isDue && !store.isReading) startRead(source, store)
            })
    }
    return store.started + 1
}

function startRead<T>(source: ValueSource<T>, store: Store<T>) {
    if (stores.get(source) !== store) return
    store.isDue = false
    store.isReading = true
    store.started += 1
    const ticket = store.started
    const settle = (value: T | undefined, failure: unknown) => {
        if (stores.get(source) !== store) return
        store.isReading = false
        store.answered = ticket
        store.value = value
        store.failure = failure
        for (const look of [...store.looks]) look()
        if (store.isDue) startRead(source, store)
    }
    new Promise<T>(resolve => {
        resolve(source.read())
    }).then(
        value => {
            settle(value, undefined)
        },
        (failure: unknown) => {
            settle(store.value, failure)
        }
    )
}

/**
 * A value as `select` picks it out of `source`, read when this mounts and again whenever the source
 * says it moved. A read that answers with what `isSame` calls the value already shown renders
 * nothing.
 */
export function useStoredValue<T, S>(
    source: ValueSource<T>,
    select: (value: T | undefined) => S,
    isSame: (left: S, right: S) => boolean
): StoredValue<S> {
    const [seen, setSeen] = useState<Seen<S>>(() => ({
        value: select(stores.get(source)?.value as T | undefined),
        failure: undefined,
        isLoading: true
    }))
    // Compared here rather than in an updater: React renders a component to run an updater even
    // when it answers with the state it had.
    const shown = useRef(seen)
    const picking = useRef({select, isSame})
    const ticket = useRef(0)
    const held = useRef<Readonly<{store: Store<T>; look: () => void}>>(undefined)

    useEffect(() => {
        picking.current = {select, isSame}
    })

    useEffect(() => {
        const store = open(source)
        const look = () => {
            const next: Seen<S> = {
                value: picking.current.select(store.value),
                failure: store.failure,
                isLoading: store.answered < ticket.current
            }
            const last = shown.current
            if (
                last.isLoading === next.isLoading
                && last.failure === next.failure
                && picking.current.isSame(last.value, next.value)
            )
                return
            shown.current = next
            setSeen(next)
        }
        store.looks.add(look)
        held.current = {store, look}
        ticket.current = ask(source, store)
        look()
        return () => {
            held.current = undefined
            close(source, store, look)
        }
    }, [source])

    const reload = useCallback(() => {
        if (!held.current) return
        ticket.current = ask(source, held.current.store)
        held.current.look()
    }, [source])

    const changed = useCallback(() => {
        if (held.current) ask(source, held.current.store)
    }, [source])

    return {value: seen.value, failure: seen.failure, isLoading: seen.isLoading, reload, changed}
}

function projectSource<T>(what: ProjectValue, read: () => Promise<T>): ValueSource<T> {
    return {read, watch: changed => watchProjectChange(what, changed)}
}

/** Each value the project's storage announces, and what reads it. */
export const PROJECT_VALUES = {
    memories: projectSource('memories', listProjectMemory),
    sketches: projectSource('sketches', listProjectSketches),
    changes: projectSource('changes', listTaskChanges),
    board: projectSource('board', listCards)
} as const satisfies Readonly<Record<ProjectValue, ValueSource<unknown>>>

type ProjectValueOf<What extends ProjectValue> =
    (typeof PROJECT_VALUES)[What] extends ValueSource<infer T> ? T : never

function whole<T>(value: T): T {
    return value
}

/** The whole of `source`'s value, redrawn whenever a read answers. */
export function useSourceValue<T>(source: ValueSource<T>): StoredValue<T | undefined> {
    return useStoredValue(source, whole, Object.is)
}

/** A value the project's storage holds, kept current with every write to it. */
export function useProjectValue<What extends ProjectValue>(
    what: What
): StoredValue<ProjectValueOf<What> | undefined> {
    return useSourceValue(PROJECT_VALUES[what] as ValueSource<ProjectValueOf<What>>)
}
