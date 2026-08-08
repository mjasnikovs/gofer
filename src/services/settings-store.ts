import {invoke} from './desktop'
import type {SettingsRequest} from '../models/settings'

/**
 * The renderer's half of the settings and storage commands.
 *
 * Every one of these is a one-line wrapper, and that is the point: a page that names the backend
 * command itself can only be tested by replacing the whole IPC module, and replacing that module
 * is what stops a test from ever noticing that the command name changed.
 */

export function loadSettings() {
    return invoke('load_settings')
}

export function saveSettings(request: SettingsRequest) {
    return invoke('save_settings', {request})
}

export function testAiConnection(request: SettingsRequest) {
    return invoke('test_ai_connection', {request})
}

export function listAiModels(request: SettingsRequest) {
    return invoke('list_ai_models', {request})
}

export function readCacheStatus() {
    return invoke('get_rag_cache_status')
}

export function initializeRag() {
    return invoke('initialize_rag')
}

export function deleteRagCache() {
    return invoke('delete_rag_cache')
}

export function createProjectBackup() {
    return invoke('create_project_backup')
}

export function runStorageMaintenance() {
    return invoke('run_storage_maintenance')
}
