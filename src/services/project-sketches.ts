import {invoke} from './desktop'
import {toCommandError} from '../utils/command-error'
import type {CommandError} from '../models/errors'
import type {ProjectSketch, SketchHtml} from '../models/sketch'

export function listProjectSketches(): Promise<readonly ProjectSketch[]> {
    return invoke('list_project_sketches')
}

export function readProjectSketch(id: string): Promise<SketchHtml> {
    return invoke('read_project_sketch', {id})
}

export const toSketchError: (error: unknown) => CommandError = toCommandError
