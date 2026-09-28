import {watchEvent} from './desktop'
import type {ProjectValue} from '../models/project-changes'

/** Fires when the project's storage wrote `what`; answers the stop. */
export function watchProjectChange(what: ProjectValue, handler: () => void): () => void {
    return watchEvent('project-changed', event => {
        if (event.payload.what === what) handler()
    })
}
