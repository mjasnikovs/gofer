import {useEffect, useState, useSyncExternalStore} from 'react'
import {createRememberedLayout} from '../services/remembered-layout'
import type {LayoutStore} from '../services/remembered-layout'
import {readProjectState, writeProjectState} from '../services/ui-state'

/** The project's own database, which is where a layout belongs. */
const PROJECT_STATE: LayoutStore = {read: readProjectState, write: writeProjectState}

/**
 * How this project's workspace was left, read once and kept up to date.
 *
 * The round trip belongs to `services/remembered-layout.ts`, which knows nothing about React and
 * is tested against a store held in a Map. What is left here is the subscription and the one read
 * that has to be tied to a mount.
 */
export function useRememberedLayout(store: LayoutStore = PROJECT_STATE) {
    const [remembered] = useState(() => createRememberedLayout(store))
    const state = useSyncExternalStore(remembered.subscribe, remembered.state)

    useEffect(() => {
        void remembered.open()
    }, [remembered])

    return {state, dispatch: remembered.dispatch, recordView: remembered.recordView}
}
