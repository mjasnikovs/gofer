import type {DesktopCommand, DesktopCommandMap} from '../services/desktop'
import type {DesktopFake} from './desktop-driver'
import type {AiStreamPayload, StoredChat} from '../models/chat'
import type {GodotSessionState} from '../models/godot'
import type {WorkspaceFileChange} from '../models/files'
import type {AgentPrompt, CacheStatus, SettingsResponse} from '../models/settings'

/**
 * One in-memory Gofer backend, behind the seam `desktop-driver` opens.
 *
 * Every test file that mounts a real screen used to write its own: a `mockImplementation` with a
 * switch over command names, deciding for itself what `load_settings` answers and what a saved
 * script comes back as. Six of them, agreeing by coincidence — and each one a place a renamed
 * command could go unnoticed, because the fake that would have caught it was the fake being
 * rewritten.
 *
 * This is that adapter, written once. It holds state rather than canned replies: a scene the editor
 * has open, a script whose hash moves when it is saved, the interface state a write put there. That
 * is what lets a test assert a round-trip instead of a call count. A test that needs a different
 * answer overrides the one command it is about, and gets the rest of a working backend for free.
 */

/** What the fake is holding. Readable for assertions, writable for a test that needs it moved. */
export interface BackendState {
    /** Whether the managed editor session has been started, and what it reports. */
    session: {started: boolean; state: GodotSessionState}
    /** The scene the editor has open. Empty models a session editing none. */
    scene: string
    /** The one script the script commands serve, and the hash a save has to quote. */
    script: {path: string; text: string; hash: string; version: number}
    /** Whether a debugger launch succeeds. */
    canLaunch: boolean
    /** Remembered interface state, as the values behind `read_project_state`. */
    stored: Record<string, unknown>
}

/** Everything the renderer asked the backend to do, in the order it asked. */
export interface BackendLog {
    /** Every Godot command, by name. */
    calls: string[]
    /** Every debug-adapter operation, by name. */
    debugCalls: string[]
    /** Every path handed to `scene.open`. */
    sceneOpens: string[]
    /** Each batch of classes the tree asked the editor to draw. */
    iconRequests: string[][]
    /** Interface state the renderer recorded, newest last. */
    writes: {key: string; value?: unknown}[]
    /** Every chat the renderer asked the backend to store. */
    saved: StoredChat[]
    /** Every script text the renderer saved. */
    savedScripts: string[]
    /** Each rename transaction that reached the backend, as the paths it rewrote. */
    renames: string[][]
}

/** An answer that replaces the fake's own for one command. Throwing rejects the call. */
type Answer<Command extends DesktopCommand> = (
    arguments_: DesktopCommandMap[Command]['arguments']
) => unknown

/**
 * Per-command replacements, typed against the real command map.
 *
 * This is what makes the fake notice a rename: a key that is no longer a command fails typecheck
 * here, in every test that overrides it.
 */
export type BackendAnswers = {[Command in DesktopCommand]?: Answer<Command>}

export type BackendOptions = Readonly<{
    /** The scene the editor already has open. */
    openScene?: string
    /** Whether a debugger launch succeeds. */
    canLaunch?: boolean
    /** How the project was left, as the interface state the renderer reads before it mounts. */
    stored?: Readonly<Record<string, unknown>>
    /** What `load_settings` and `save_settings` answer with. */
    settings?: SettingsResponse
    /** What `read_agent_prompt` answers with. */
    agentPrompt?: AgentPrompt
    /** What `get_rag_cache_status` answers with. */
    cache?: CacheStatus
    /** The chat the project opens with. */
    chat?: StoredChat
    /** The worktree listing, for a suite that needs different files in the explorer. */
    files?: readonly {path: string; bytes: number}[]
    /** The `data:` squares `read_workspace_thumbnail` answers with, by path. */
    thumbnails?: Readonly<Record<string, string>>
    /** The script the script commands serve. */
    script?: Readonly<{path: string; text: string}>
    /** Answers that replace the fake's own, by command name. */
    answers?: BackendAnswers
}>

export type Backend = Readonly<{
    state: BackendState
    log: BackendLog
    /**
     * Moves the editor's lifecycle state and announces it, the way Rust does.
     *
     * Both halves matter. `get_godot_session` answers with this on the reconcile tick, and the
     * global event carries it in between — the window is told, rather than having to notice.
     */
    publishSessionState: (state: GodotSessionState) => void
    /**
     * Tells the workspace the editor is editing another scene, the way the addon does.
     *
     * The edited scene reaches the workspace as a `scene.changed` event and nowhere else — a
     * `scene.open` answering does not move it — so a test about a scene change has to send one.
     */
    publishSceneChanged: (scene: string) => void
    /** Publishes diagnostics through the channel the workspace subscribed with. */
    publishDiagnostics: (path: string, diagnostics: readonly unknown[]) => void
    /** Publishes a settled batch of external file changes through the watch channel. */
    publishFileChanges: (changes: readonly WorkspaceFileChange[]) => void
    /** Publishes one AI stream event on the channel of the turn that is running. */
    publishStream: (payload: AiStreamPayload) => void
}>

/** A structured Godot failure, as Tauri hands the serialized Rust struct to the rejection. */
export class GodotFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retryable: boolean
    ) {
        super(message)
    }
}

/** The structured failure a stale script write is refused with, as Rust reports it. */
export class ScriptConflict extends Error {
    readonly code = 'file_conflict'
    readonly retryable = false
    readonly details = {}

    constructor(path: string) {
        super(`${path} changed on disk`)
    }
}

export const SESSION = {
    sessionId: 'session-1',
    rpcAddress: '127.0.0.1:7000',
    lspPort: 6005,
    dapPort: 6006,
    godotVersion: '4.7.2.stable',
    worktree: '/tmp/task'
}

export const SCRIPT = 'extends Node\n\nfunc _ready():\n\tpass\n'
/** Stands in for the artwork the editor's theme hands back for a class. */
export const ICON_PNG = 'iVBORw0KGgoAAAANSUhEUg=='
export const FRAME = {encoding: 'png-base64', width: 320, height: 180, data: 'iVBORw0KGgo='}
export const MAIN_SCENE = 'res://scenes/main.tscn'

export const FILES = [
    {path: 'scripts/player.gd', bytes: SCRIPT.length},
    {path: 'scripts/player.gd.uid', bytes: 40},
    {path: 'scenes/main.tscn', bytes: 200},
    {path: 'art/tile.png.import', bytes: 120},
    {path: 'addons/gofer/plugin.gd', bytes: 10}
]

export const SCENE_TREE = {
    root: {
        name: 'Main',
        type: 'Node2D',
        path: 'Main',
        children: [
            {
                name: 'Player',
                type: 'CharacterBody2D',
                // The class the editor draws it with: this one is a script class of its own.
                icon: 'PlayerBody',
                path: 'Main/Player',
                children: []
            }
        ]
    }
}

const SETTINGS: SettingsResponse = {settings: {}, hasApiKey: false} as SettingsResponse

const PROMPT: AgentPrompt = {
    prompt: 'You are Gofer, a capable local coding agent.',
    defaultPrompt: 'You are Gofer, a capable local coding agent.'
}

const CACHE: CacheStatus = {
    path: '/tmp/gofer-rag',
    sizeBytes: 1024 ** 3,
    state: 'installed'
}

const EMPTY_CHAT = {taskId: 'task-1', messages: [], agentMessages: []} as unknown as StoredChat

interface Channels {
    session?: {onmessage: (event: unknown) => void} | undefined
    diagnostics?: {onmessage: (event: unknown) => void} | undefined
    changes?: {onmessage: (changes: readonly WorkspaceFileChange[]) => void} | undefined
    stream?: {onmessage: (payload: AiStreamPayload) => void} | undefined
}

/**
 * Puts a working in-memory backend behind the desktop seam and hands back what it is holding.
 *
 * The fake answers `undefined` for a command it does not model, which is what the real backend does
 * for the commands that return nothing. A test that needs more names it in `answers`.
 */
export function installBackend(fake: DesktopFake, options: BackendOptions = {}): Backend {
    const state: BackendState = {
        session: {started: false, state: 'ready'},
        scene: options.openScene ?? 'res://main.tscn',
        script: {
            path: options.script?.path ?? 'scripts/player.gd',
            text: options.script?.text ?? SCRIPT,
            hash: 'hash-1',
            version: 1
        },
        canLaunch: options.canLaunch ?? true,
        stored: {...options.stored}
    }
    const log: BackendLog = {
        calls: [],
        debugCalls: [],
        sceneOpens: [],
        iconRequests: [],
        writes: [],
        saved: [],
        savedScripts: [],
        renames: []
    }
    const channels: Channels = {}
    const settings = options.settings ?? SETTINGS
    const files = options.files ?? FILES

    const publishSessionState = (next: GodotSessionState) => {
        state.session.state = next
        const announce = fake.listen.mock.calls.find(call => call[0] === 'godot-session-event')?.[1]
        announce?.({payload: {type: 'stateChanged', state: next} as never})
    }

    fake.invoke.mockImplementation(async (command, arguments_) => {
        const override = options.answers?.[command as DesktopCommand]
        if (override) return override(arguments_ as never)

        const payload = (arguments_ ?? {}) as Record<string, unknown>
        const request = (payload['request'] ?? {}) as Record<string, unknown>

        switch (command) {
            // --- interface state -------------------------------------------------------------
            case 'read_project_state': {
                const value = state.stored[payload['key'] as string]
                return value === undefined ? null : JSON.stringify(value)
            }
            case 'write_project_state': {
                const key = payload['key'] as string
                const raw = payload['value']
                // Nothing stored is how a key is forgotten, so an absent value writes `undefined`
                // rather than removing the key — a read answers `null` either way.
                const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : undefined
                log.writes.push({key, ...(raw !== undefined && {value})})
                state.stored[key] = value
                return undefined
            }

            // --- settings --------------------------------------------------------------------
            case 'load_settings':
            case 'save_settings':
                return settings
            // The real command re-reads the file and replaces only the Godot section, so what comes
            // back is the stored settings carrying what was just sent — not what was already there.
            case 'save_godot_settings':
                return {...settings, settings: {...settings.settings, godot: payload['godot']}}
            case 'read_agent_prompt':
            case 'save_agent_prompt':
                return options.agentPrompt ?? PROMPT
            case 'get_rag_cache_status':
            case 'delete_rag_cache':
                return options.cache ?? CACHE
            case 'list_ai_models':
                return []
            case 'test_ai_connection':
                return {status: 'connected', message: 'Connected.'}

            // --- chat ------------------------------------------------------------------------
            case 'load_chat':
            case 'create_chat_task':
            case 'activate_chat_task':
            case 'delete_chat_task':
            case 'import_legacy_chat':
                return options.chat ?? EMPTY_CHAT
            case 'save_chat':
                log.saved.push(payload['chat'] as StoredChat)
                return undefined
            case 'list_project_tasks':
                return []
            case 'send_ai_message':
                channels.stream = payload['stream'] as Channels['stream']
                return undefined

            // --- workspace files -------------------------------------------------------------
            case 'list_workspace_files':
                return files
            case 'read_workspace_thumbnail':
                return options.thumbnails?.[payload['path'] as string] ?? null
            case 'watch_workspace_files':
                channels.changes = payload['changes'] as Channels['changes']
                return undefined

            // --- scripts ---------------------------------------------------------------------
            case 'open_script_document':
                return {
                    path: (request['path'] as string | undefined) ?? state.script.path,
                    text: state.script.text,
                    hash: state.script.hash,
                    bytes: state.script.text.length,
                    version: state.script.version
                }
            case 'update_script_document':
                state.script.version += 1
                return {path: state.script.path, version: state.script.version}
            case 'save_script_document': {
                if (request['expectedHash'] !== state.script.hash)
                    throw new ScriptConflict(state.script.path)
                state.script.text = (request['text'] as string | undefined) ?? ''
                state.script.hash = 'hash-2'
                state.script.version += 1
                log.savedScripts.push(state.script.text)
                return {
                    path: state.script.path,
                    hash: state.script.hash,
                    bytes: state.script.text.length,
                    version: state.script.version
                }
            }
            case 'subscribe_script_diagnostics':
                channels.diagnostics = payload['diagnostics'] as Channels['diagnostics']
                return undefined
            case 'apply_script_rename': {
                const renamed = (request['files'] ?? []) as {path: string; updatedText: string}[]
                log.renames.push(renamed.map(entry => entry.path))
                // The transaction rewrote the open script too, so the fake holds what it wrote:
                // a reopen after a rename must not hand back the text from before it.
                const open = renamed.find(entry => entry.path === state.script.path)
                if (open) state.script.text = open.updatedText
                state.script.hash = 'hash-renamed'
                state.script.version += 1
                return renamed.map(entry => ({
                    path: entry.path,
                    hash: 'hash-renamed',
                    bytes: entry.updatedText.length,
                    version: state.script.version
                }))
            }

            // --- the editor session ----------------------------------------------------------
            case 'get_godot_session':
                return state.session.started ? {...SESSION, state: state.session.state} : undefined
            case 'start_godot_session':
                state.session.started = true
                state.session.state = 'ready'
                return {...SESSION, state: state.session.state}
            case 'stop_godot_session':
                state.session.started = false
                state.session.state = 'offline'
                return undefined
            case 'subscribe_godot_events':
                channels.session = payload['events'] as Channels['session']
                return undefined

            // --- the debug adapter -----------------------------------------------------------
            case 'call_godot_debug': {
                const op = (request['op'] as string | undefined) ?? ''
                log.debugCalls.push(op)
                return debugAnswer(op, state, publishSessionState)
            }

            // --- logs and documentation ------------------------------------------------------
            case 'search_godot_log_history':
                return ((request['query'] as string | undefined) ?? '').includes('Invalid') ?
                        [
                            {
                                runId: 'run-1',
                                sessionId: 'session-0',
                                timestamp: 1_800_000_000_000,
                                level: 'error',
                                source: 'editorError',
                                message: 'ERROR: Invalid call in a session that already stopped'
                            }
                        ]
                    :   []
            case 'read_godot_logs':
                return {
                    entries: [
                        {
                            sequence: 1,
                            source: 'editor',
                            severity: 'info',
                            message: 'Godot Engine v4.7.2.stable',
                            timestamp: 1_800_000_000
                        },
                        {
                            sequence: 2,
                            source: 'editorError',
                            severity: 'error',
                            message: 'SCRIPT ERROR: Parse error',
                            timestamp: 1_800_000_001
                        }
                    ],
                    cursor: 2,
                    dropped: 0
                }
            case 'query_godot_docs':
                return {
                    passages: [
                        {
                            text: 'CharacterBody2D moves with move_and_slide().',
                            chapter: 'Physics introduction',
                            order: 3,
                            score: 0.82
                        }
                    ]
                }

            // --- the addon -------------------------------------------------------------------
            case 'call_godot': {
                const name = (request['command'] as string | undefined) ?? ''
                log.calls.push(name)
                if (!state.session.started)
                    throw new GodotFailure('session_not_active', 'No Godot session is active', true)
                const params = (request['params'] ?? {}) as Record<string, unknown>
                return {id: 'x', result: godotAnswer(name, params, state, log, publishSessionState)}
            }

            default:
                return undefined
        }
    })

    return {
        state,
        log,
        publishSessionState,
        publishSceneChanged(scene) {
            state.scene = scene
            channels.session?.onmessage({
                type: 'rpcEvent',
                event: 'scene.changed',
                data: {scene, revision: 0, dirty: false}
            })
        },
        publishDiagnostics(path, diagnostics) {
            channels.diagnostics?.onmessage({path, version: state.script.version, diagnostics})
        },
        publishFileChanges(changes) {
            channels.changes?.onmessage(changes)
        },
        publishStream(payload) {
            channels.stream?.onmessage(payload)
        }
    }
}

/** What the debug adapter answers, per operation. */
function debugAnswer(
    op: string,
    state: BackendState,
    publishSessionState: (state: GodotSessionState) => void
) {
    switch (op) {
        case 'launch':
            if (!state.canLaunch)
                throw new GodotFailure(
                    'no_scene_to_run',
                    'No scene is open and the project names no main scene',
                    false
                )
            // Launching plays the project, which is a fact about the editor rather than about the
            // adapter — so it is reported the way the editor reports it, and everything that reads
            // "is a game running" reads this.
            publishSessionState('playing')
            return {op: 'launched', breakpoints: []}
        case 'terminate':
            publishSessionState('ready')
            return {op: 'acknowledged'}
        case 'awaitStop':
            return {
                op: 'stopped',
                stopped: {reason: 'breakpoint', threadId: 1, allThreadsStopped: true}
            }
        case 'stackTrace':
            return {
                op: 'stackTrace',
                frames: [{id: 1, name: '_ready', line: 3, column: 1, path: 'scripts/player.gd'}]
            }
        case 'scopes':
            return {
                op: 'scopes',
                scopes: [{name: 'Locals', variablesReference: 10, expensive: false}]
            }
        case 'variables':
            return {
                op: 'variables',
                variables: [{name: 'amount', value: '3', variablesReference: 0}]
            }
        default:
            return {op: 'acknowledged'}
    }
}

/** What the addon answers, per command. */
function godotAnswer(
    name: string,
    params: Record<string, unknown>,
    state: BackendState,
    log: BackendLog,
    publishSessionState: (state: GodotSessionState) => void
) {
    switch (name) {
        case 'session.get_state':
            return {
                state: 'ready',
                scene: state.scene,
                revision: 2,
                dirty: false,
                canUndo: false,
                canRedo: false
            }
        case 'scene.get_tree':
            return state.scene ? SCENE_TREE : {root: null}
        case 'scene.open': {
            const requested = params['path']
            const path = typeof requested === 'string' ? requested : ''
            log.sceneOpens.push(path)
            state.scene = path
            return {scene: path, revision: 3}
        }
        case 'project.get_settings':
            return {
                projectName: 'Fixture',
                mainScene: MAIN_SCENE,
                renderingMethod: 'gl_compatibility'
            }
        case 'runtime.get_tree':
            throw new GodotFailure(
                'runtime_not_running',
                'No game with the Gofer runtime helper is running',
                true
            )
        case 'node.inspect':
            return {
                name: 'Player',
                type: 'CharacterBody2D',
                path: 'Main/Player',
                groups: ['players'],
                signals: ['body_entered', 'ready'],
                connections: [
                    {
                        signal: 'body_entered',
                        target: '/Main',
                        method: '_on_player_body_entered',
                        binds: [],
                        deferred: false,
                        oneShot: false,
                        persistent: true
                    }
                ]
            }
        case 'project.search_settings':
            return {
                settings: [
                    {
                        name: 'application/config/name',
                        value: {type: 'string', value: 'Fixture'},
                        restartRequired: true
                    }
                ],
                totalMatches: 1,
                truncated: false
            }
        case 'editor.search_settings':
            return {
                settings: [
                    {
                        name: 'interface/editor/single_window_mode',
                        value: {type: 'bool', value: false}
                    }
                ],
                totalMatches: 1,
                truncated: false
            }
        case 'runtime.run':
            // Running the project plays it, which is a fact about the editor: a fake that answers
            // with a frame of a game it never started is a backend the application is right to
            // disbelieve.
            publishSessionState('playing')
            return {running: true, frame: FRAME}
        case 'runtime.capture':
            // A capture of the game is forwarded to the helper inside the game process, so a
            // stopped game answers with the refusal rather than with an old picture.
            if (params['source'] !== 'editor' && state.session.state !== 'playing')
                throw new GodotFailure(
                    'runtime_not_running',
                    'No game with the Gofer runtime helper is running',
                    true
                )
            return {frame: FRAME}
        case 'editor.get_class_icons': {
            const classes = (params['classes'] ?? []) as string[]
            log.iconRequests.push(classes)
            const icons: Record<string, string> = {}
            for (const className of classes) icons[className] = ICON_PNG
            return {encoding: 'png-base64', icons}
        }
        default:
            return {}
    }
}
