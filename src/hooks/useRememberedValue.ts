import {useEffect, useState, useSyncExternalStore} from 'react'
import {rememberValue} from '../services/interface-state'
import type {InterfaceStateStore, Remembered} from '../services/interface-state'
import {readProjectState, writeProjectState} from './../services/ui-state'

/** The project's own database, which is where interface state belongs. */
const PROJECT_STATE: InterfaceStateStore = {read: readProjectState, write: writeProjectState}

type RememberedValueOptions<Value> = Readonly<{
    /**
     * Which key to remember this under, or nothing while there is nothing to remember it for — a
     * composer with no task yet, for instance. A key that changes reopens on the new one.
     */
    key: string | undefined
    restore: (stored: unknown) => Value
    isEmpty?: (value: Value) => boolean
    store?: InterfaceStateStore
}>

export type RememberedValue<Value> = Readonly<{
    /** The remembered value, or nothing while its key has not answered yet. */
    value: Value | undefined
    change: (next: Value | ((current: Value) => Value)) => void
}>

/**
 * One piece of this project's interface state, read once per key and kept up to date.
 *
 * The round trip belongs to `services/interface-state.ts`, which knows nothing about React and is
 * tested against a store held in a Map. What is left here is the subscription and the read that has
 * to follow the key.
 */
export function useRememberedValue<Value>({
    key,
    restore,
    isEmpty,
    store = PROJECT_STATE
}: RememberedValueOptions<Value>): RememberedValue<Value> {
    const [remembered] = useState<Remembered<Value>>(() =>
        rememberValue(store, {restore, ...(isEmpty && {isEmpty})})
    )
    const state = useSyncExternalStore(remembered.subscribe, remembered.state)

    useEffect(() => {
        void remembered.open(key)
    }, [key, remembered])

    return {value: state.isOpen ? state.value : undefined, change: remembered.change}
}
