import {useEffect, useState, useSyncExternalStore} from 'react'
import {createRememberedLayout} from '../services/remembered-layout'
import type {LayoutStore} from '../services/remembered-layout'
import {readProjectState, writeProjectState} from '../services/ui-state'

const PROJECT_STATE: LayoutStore = {read: readProjectState, write: writeProjectState}

export function useRememberedLayout(store: LayoutStore = PROJECT_STATE) {
    const [remembered] = useState(() => createRememberedLayout(store))
    const state = useSyncExternalStore(remembered.subscribe, remembered.state)

    useEffect(() => {
        void remembered.open()
    }, [remembered])

    return {state, dispatch: remembered.dispatch, recordView: remembered.recordView}
}
