import {invoke} from './desktop'
import {toCommandError} from '../utils/command-error'
import type {CommandError} from '../models/errors'
import type {FileDiff, TaskChanges} from '../models/changes'

export function listTaskChanges(): Promise<TaskChanges> {
    return invoke('list_task_changes')
}

export function readTaskChange(path: string): Promise<FileDiff> {
    return invoke('read_task_change', {path})
}

export const toChangesError: (error: unknown) => CommandError = toCommandError
