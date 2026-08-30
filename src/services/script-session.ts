import {Channel} from '@tauri-apps/api/core'
import {invoke} from './desktop'
import type {
    PlannedScriptFile,
    ScriptDiagnosticsEvent,
    ScriptDocument,
    ScriptError,
    ScriptRequest,
    ScriptResponse,
    ScriptStamp
} from '../models/script'

export function openScriptDocument(path: string): Promise<ScriptDocument> {
    return invoke('open_script_document', {request: {path}})
}

export function updateScriptDocument(path: string, text: string): Promise<ScriptStamp> {
    return invoke('update_script_document', {request: {path, text}})
}

export function saveScriptDocument(
    path: string,
    text: string,
    expectedHash?: string
): Promise<ScriptStamp> {
    return invoke('save_script_document', {request: {path, text, expectedHash}})
}

export function closeScriptDocument(path: string): Promise<void> {
    return invoke('close_script_document', {request: {path}})
}

export function callScriptLanguage(request: ScriptRequest): Promise<ScriptResponse> {
    return invoke('call_script_language', {request})
}

export function formatGdscript(source: string) {
    return invoke('format_gdscript', {request: {source}})
}

export function applyScriptRename(
    files: readonly PlannedScriptFile[]
): Promise<readonly ScriptStamp[]> {
    return invoke('apply_script_rename', {request: {files}})
}

export async function subscribeScriptDiagnostics(
    handler: (event: ScriptDiagnosticsEvent) => void
): Promise<void> {
    const diagnostics = new Channel<ScriptDiagnosticsEvent>()
    diagnostics.onmessage = handler
    await invoke('subscribe_script_diagnostics', {diagnostics})
}

export function unsubscribeScriptDiagnostics(): Promise<void> {
    return invoke('unsubscribe_script_diagnostics')
}

export function toScriptError(error: unknown): ScriptError {
    if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
        const candidate = error as Partial<ScriptError>
        if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
            return {
                code: candidate.code,
                message: candidate.message,
                retryable: candidate.retryable === true,
                details: candidate.details ?? {}
            }
        }
    }
    return {
        code: 'command_failed',
        message: String(error),
        retryable: false,
        details: {}
    }
}
