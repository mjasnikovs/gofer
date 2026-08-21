import {invoke} from './desktop'
import {toCommandError} from '../utils/command-error'
import type {CommandError} from '../models/errors'
import type {ProjectSketch, SketchHtml} from '../models/sketch'

/**
 * The layouts this project has agreed, as the window reads them back.
 *
 * Two calls rather than one, and the split is the point. A sketch drawn with the project's own
 * artwork inlined runs to tens of kilobytes of base64; a list of forty would carry all of it across
 * the seam so that one could be drawn. So the list names them and the read fetches the one opened.
 */
export function listProjectSketches(): Promise<readonly ProjectSketch[]> {
    return invoke('list_project_sketches')
}

/** Both copies of one sketch: the one to draw, and the one to hand to whoever builds it. */
export function readProjectSketch(id: string): Promise<SketchHtml> {
    return invoke('read_project_sketch', {id})
}

/** The shared converter, under the name this panel reads it by. */
export const toSketchError: (error: unknown) => CommandError = toCommandError
