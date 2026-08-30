import {useEffect, useState, useSyncExternalStore} from 'react'
import {rememberValue} from '../services/interface-state'
import type {InterfaceStateStore, Remembered} from '../services/interface-state'
import {readProjectState, writeProjectState} from './../services/ui-state'

const PROJECT_STATE: InterfaceStateStore = {read: readProjectState, write: writeProjectState}

type RememberedValueOptions<Value> = Readonly<{
    key: string | undefined
    restore: (stored: unknown) => Value
    isEmpty?: (value: Value) => boolean
    store?: InterfaceStateStore
}>

export type RememberedValue<Value> = Readonly<{
    value: Value | undefined
    change: (next: Value | ((current: Value) => Value)) => void
}>

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
