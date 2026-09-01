import {
    DEFAULT_GODOT_SETTINGS,
    DEFAULT_SUBAGENT_SETTINGS,
    DEFAULT_WEB_SETTINGS
} from '../models/settings'
import {draftKey} from '../services/ui-state'
import type {DesktopCommand, DesktopCommandMap} from '../services/desktop'
import type {DesktopFake} from './desktop-driver'
import type {AiStreamPayload, StoredChat} from '../models/chat'
import type {GodotSessionState} from '../models/godot'
import type {WorkspaceFileChange} from '../models/files'
import type {
    AgentPrompt,
    CacheStatus,
    GoferSettings,
    SettingsRequest,
    SettingsResponse
} from '../models/settings'
import type {TaskSummary} from '../models/app'
import type {HealthReport} from '../models/health'
import type {MemoryEdit, MemoryState, ProjectMemory} from '../models/memory'
import type {FileDiff, TaskChanges} from '../models/changes'
import {NO_CHANGES} from '../models/changes'
import type {ProjectSketch, SketchHtml} from '../models/sketch'
import type {Skill, SkillsResponse} from '../models/skills'
import type {BriefRun} from '../models/brief'

export interface BackendState {
    session: {started: boolean; state: GodotSessionState}
    scene: string
    script: {path: string; text: string; hash: string; version: number}
    canLaunch: boolean
    stored: Record<string, unknown>
    health: HealthReport
    tasks: TaskSummary[]
    chats: Map<string, StoredChat>
    briefs: Map<string, BriefRun>
    memories: ProjectMemory[]
    sketches: ProjectSketch[]
    changes: TaskChanges
    diffs: Map<string, FileDiff>
    skills: Map<string, {skill: Skill; text: string}>
    sketchHtml: SketchHtml
    settings: SettingsResponse
}

export interface BackendLog {
    calls: string[]
    debugCalls: string[]
    sceneOpens: string[]
    iconRequests: string[][]
    writes: {key: string; value?: unknown}[]
    saved: StoredChat[]
    sketchReads: string[]
    savedScripts: string[]
    renames: string[][]
}

type Answer<Command extends DesktopCommand> = (
    arguments_: DesktopCommandMap[Command]['arguments'],
    answer: () => unknown
) => unknown

export type BackendAnswers = {[Command in DesktopCommand]?: Answer<Command>}

export type BackendOptions = Readonly<{
    openScene?: string
    canLaunch?: boolean
    stored?: Readonly<Record<string, unknown>>
    settings?: SettingsResponse
    agentPrompt?: AgentPrompt
    cache?: CacheStatus
    chat?: StoredChat
    health?: HealthReport
    tasks?: readonly TaskSummary[]
    chats?: Readonly<Record<string, StoredChat>>
    briefs?: Readonly<Record<string, BriefRun>>
    memories?: readonly ProjectMemory[]
    sketches?: readonly ProjectSketch[]
    changes?: TaskChanges
    diffs?: Readonly<Record<string, FileDiff>>
    sketchHtml?: SketchHtml
    skills?: readonly {skill: Skill; text: string}[]
    files?: readonly {path: string; bytes: number}[]
    thumbnails?: Readonly<Record<string, string>>
    script?: Readonly<{path: string; text: string}>
    answers?: BackendAnswers
}>

export type Backend = Readonly<{
    state: BackendState
    log: BackendLog
    publishSessionState: (state: GodotSessionState) => void
    publishSceneChanged: (scene: string) => void
    publishDiagnostics: (path: string, diagnostics: readonly unknown[]) => void
    publishFileChanges: (changes: readonly WorkspaceFileChange[]) => void
    publishStream: (payload: AiStreamPayload) => void
}>

export class GodotFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retryable: boolean
    ) {
        super(message)
    }
}

export class CommandFailure extends Error {
    readonly retryable = false
    readonly details = {}

    constructor(
        readonly code: string,
        message: string
    ) {
        super(message)
    }
}

const MERGED_COMMIT = 'merged-commit'

function without(stored: Record<string, unknown>, key: string) {
    return Object.fromEntries(Object.entries(stored).filter(([name]) => name !== key))
}

function byMostRecentlyWorkedOn(one: TaskSummary, other: TaskSummary) {
    return other.updatedAt - one.updatedAt || other.createdAt - one.createdAt
}

function keyAfter(update: {action: string} | undefined, had: boolean | undefined) {
    if (update?.action === 'set') return true
    if (update?.action === 'clear') return false
    return had
}

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
                icon: 'PlayerBody',
                path: 'Main/Player',
                children: []
            }
        ]
    }
}

const STORED_SETTINGS: GoferSettings = {
    version: 1,
    ai: {
        connectionType: 'openai-compatible',
        connections: {
            'openai-compatible': {
                name: 'Local AI',
                baseUrl: 'http://127.0.0.1:8080/v1',
                api: 'openai-completions',
                chatTemplateThinking: false,
                model: {
                    id: 'local-model',
                    name: 'local-model',
                    contextWindow: 120_064,
                    maxTokens: 120_064,
                    reasoning: false,
                    supportsReasoningEffort: false,
                    reasoningMandatory: false,
                    thinkingLevels: [],
                    input: ['text'],
                    thinkingLevel: 'off'
                }
            }
        },
        maxRetries: 2,
        timeoutMs: 120_000,
        compactionPercent: 86,
        subagent: DEFAULT_SUBAGENT_SETTINGS,
        web: DEFAULT_WEB_SETTINGS
    },
    godot: DEFAULT_GODOT_SETTINGS
}

export const SETTINGS: SettingsResponse = {settings: STORED_SETTINGS, hasApiKey: false}

export const DEFAULT_TASK: TaskSummary = {
    id: 'task-1',
    title: 'New task',
    status: 'active',
    isCurrent: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    worktree: {
        branchName: 'gofer/task-1',
        worktreePath: '/tmp/task-1',
        baseCommit: 'base'
    }
}

export const HEALTHY: HealthReport = {
    workspace: '/home/dev/game',
    workspaceSource: 'configured',
    isReady: true,
    checks: []
}

export const SKETCH_HTML: SketchHtml = {
    shown: '<p>data:image/png;base64,AAAA</p>',
    source: '<p>res://ui/panel.png</p>'
}

const PROMPT: AgentPrompt = {
    prompt: 'You are Gofer, a capable local coding agent.',
    defaultPrompt: 'You are Gofer, a capable local coding agent.'
}

const CACHE: CacheStatus = {
    path: '/tmp/gofer-rag',
    sizeBytes: 1024 ** 3,
    state: 'installed'
}

const emptyChat = (taskId: string): StoredChat => ({taskId, messages: [], agentMessages: []})

interface Channels {
    session?: {onmessage: (event: unknown) => void} | undefined
    diagnostics?: {onmessage: (event: unknown) => void} | undefined
    changes?: {onmessage: (changes: readonly WorkspaceFileChange[]) => void} | undefined
    stream?: {onmessage: (payload: AiStreamPayload) => void} | undefined
}

function skillsResponse(state: BackendState): SkillsResponse {
    return {skills: [...state.skills.values()].map(one => one.skill), warnings: []}
}

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
        stored: {...options.stored},
        health: options.health ?? HEALTHY,
        tasks: [...(options.tasks ?? [DEFAULT_TASK])],
        chats: new Map(Object.entries(options.chats ?? {})),
        briefs: new Map(Object.entries(options.briefs ?? {})),
        memories: [...(options.memories ?? [])],
        sketches: [...(options.sketches ?? [])],
        changes: options.changes ?? NO_CHANGES,
        diffs: new Map(Object.entries(options.diffs ?? {})),
        skills: new Map((options.skills ?? []).map(one => [one.skill.name, one])),
        sketchHtml: options.sketchHtml ?? SKETCH_HTML,
        settings: options.settings ?? SETTINGS
    }
    const log: BackendLog = {
        calls: [],
        debugCalls: [],
        sceneOpens: [],
        iconRequests: [],
        writes: [],
        saved: [],
        sketchReads: [],
        savedScripts: [],
        renames: []
    }
    const channels: Channels = {}
    const files = options.files ?? FILES

    const publishSessionState = (next: GodotSessionState) => {
        state.session.state = next
        const announce = fake.listen.mock.calls.find(call => call[0] === 'godot-session-event')?.[1]
        announce?.({payload: {type: 'stateChanged', state: next} as never})
    }

    const currentTask = () => state.tasks.find(task => task.isCurrent)

    let stamped = 1_700_000_000_000
    const stamp = () => {
        stamped += 1
        return stamped
    }

    let minted = 0
    const mintTaskId = () => {
        minted += 1
        while (state.tasks.some(task => task.id === `task-${String(minted)}`)) minted += 1
        return `task-${String(minted)}`
    }

    const newTask = (id: string, isCurrent: boolean): TaskSummary => ({
        id,
        title: 'New task',
        status: 'active',
        isCurrent,
        createdAt: stamp(),
        updatedAt: stamped,
        worktree: {branchName: `gofer/${id}`, worktreePath: `/tmp/${id}`, baseCommit: 'base'}
    })

    const createTask = () => {
        const created = newTask(mintTaskId(), true)
        state.tasks = [created, ...state.tasks.map(task => ({...task, isCurrent: false}))]
        state.chats.set(created.id, emptyChat(created.id))
        return created
    }

    const taskOf = (taskId: string) => {
        const known = state.tasks.find(one => one.id === taskId)
        if (known) return known
        const adopted = newTask(taskId, state.tasks.length === 0)
        state.tasks = [adopted, ...state.tasks]
        state.chats.set(taskId, emptyChat(taskId))
        return adopted
    }

    const chatOf = (taskId: string) => state.chats.get(taskId) ?? emptyChat(taskId)

    const activeChat = (): StoredChat => {
        const current = currentTask()
        return current ? chatOf(current.id) : {messages: [], agentMessages: []}
    }

    if (options.chat) {
        const taskId = options.chat.taskId ?? currentTask()?.id ?? 'task-1'
        state.chats.set(taskOf(taskId).id, options.chat)
    }

    const deleteTask = (taskId: string): StoredChat => {
        const doomed = taskOf(taskId)
        state.tasks = state.tasks.filter(task => task.id !== taskId)
        state.chats.delete(taskId)
        state.briefs.delete(taskId)
        state.stored = without(state.stored, draftKey(taskId))
        if (!doomed.isCurrent) return chatOf(currentTask()?.id ?? taskId)
        const next = [...state.tasks].sort(byMostRecentlyWorkedOn)[0]
        if (!next) return {messages: [], agentMessages: []}
        state.tasks = state.tasks.map(task => ({...task, isCurrent: task.id === next.id}))
        return chatOf(next.id)
    }

    const storeMemory = (edit: MemoryEdit) => {
        const before = state.memories.find(row => row.id === edit.id)
        const stored: ProjectMemory = {
            provenance: {source: 'completed-ai-turn'},
            createdAt: stamped,
            check: 'unchecked',
            anchors: [],
            ...before,
            id: edit.id ?? `memory-${String(state.memories.length + 1)}`,
            kind: edit.kind,
            state: edit.state,
            content: edit.content,
            updatedAt: stamp()
        }
        state.memories =
            before ?
                state.memories.map(row => (row.id === stored.id ? stored : row))
            :   [...state.memories, stored]
        return stored
    }

    const respond = (command: string, arguments_?: unknown) => {
        const payload = (arguments_ ?? {}) as Record<string, unknown>
        const request = (payload['request'] ?? {}) as Record<string, unknown>

        switch (command) {
            case 'read_project_state': {
                const value = state.stored[payload['key'] as string]
                return value === undefined ? null : JSON.stringify(value)
            }
            case 'write_project_state': {
                const key = payload['key'] as string
                const raw = payload['value']
                const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : undefined
                log.writes.push({key, ...(raw !== undefined && {value})})
                state.stored[key] = value
                return undefined
            }

            case 'load_settings':
                return state.settings
            case 'save_settings': {
                const sent = payload['request'] as SettingsRequest
                state.settings = {
                    ...state.settings,
                    settings: sent.settings,
                    hasApiKey: keyAfter(sent.apiKey, state.settings.hasApiKey) ?? false,
                    hasBraveApiKey: keyAfter(sent.braveApiKey, state.settings.hasBraveApiKey),
                    hasOpenrouterApiKey: keyAfter(
                        sent.openrouterApiKey,
                        state.settings.hasOpenrouterApiKey
                    ),
                    hasCerebrasApiKey: keyAfter(
                        sent.cerebrasApiKey,
                        state.settings.hasCerebrasApiKey
                    )
                }
                return state.settings
            }
            case 'save_godot_settings': {
                const godot = payload['godot'] as GoferSettings['godot']
                state.settings = {
                    ...state.settings,
                    settings: {...state.settings.settings, godot}
                }
                return state.settings
            }
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

            case 'list_project_tasks':
                return [...state.tasks]
            case 'load_chat': {
                const asked = payload['taskId'] as string | undefined
                if (asked === undefined) return activeChat()
                return chatOf(taskOf(asked).id)
            }
            case 'save_chat': {
                const chat = payload['chat'] as StoredChat
                log.saved.push(chat)
                const taskId = chat.taskId ?? currentTask()?.id
                if (taskId !== undefined) state.chats.set(taskId, {...chat, taskId})
                return undefined
            }
            case 'create_chat_task':
                return chatOf(createTask().id)
            case 'activate_chat_task': {
                const taskId = taskOf(payload['taskId'] as string).id
                state.tasks = state.tasks.map(task =>
                    task.id === taskId ?
                        {...task, isCurrent: true, updatedAt: stamp()}
                    :   {...task, isCurrent: false}
                )
                return chatOf(taskId)
            }
            case 'delete_chat_task':
                return deleteTask(payload['taskId'] as string)
            case 'import_legacy_chat': {
                const taskId = (currentTask() ?? createTask()).id
                const imported = {...(payload['chat'] as StoredChat), taskId}
                state.chats.set(taskId, imported)
                return imported
            }
            case 'send_ai_message':
                channels.stream = payload['stream'] as Channels['stream']
                return undefined

            case 'merge_task_branch': {
                const task = taskOf(payload['taskId'] as string)
                const {worktree} = task
                if (!worktree)
                    throw new CommandFailure('task_not_merged', 'This task has no branch to merge')
                const merged = {...task, worktree: {...worktree, mergedCommit: MERGED_COMMIT}}
                state.tasks = state.tasks.map(one => (one.id === task.id ? merged : one))
                return {taskId: task.id, mergedCommit: MERGED_COMMIT}
            }
            case 'resolve_task_merge':
                return {taskId: payload['taskId'] as string, conflicts: []}

            case 'list_project_memory':
                return [...state.memories]
            case 'save_project_memory':
                return storeMemory(payload['edit'] as MemoryEdit)
            case 'delete_project_memory': {
                const id = payload['id'] as string
                state.memories = state.memories.filter(row => row.id !== id)
                return undefined
            }
            case 'set_memory_states': {
                const ids = payload['ids'] as readonly string[]
                const moved = state.memories
                    .filter(row => ids.includes(row.id))
                    .map(row => ({...row, state: payload['state'] as MemoryState}))
                state.memories = state.memories.map(
                    row => moved.find(one => one.id === row.id) ?? row
                )
                return moved
            }
            case 'list_project_sketches':
                return [...state.sketches]

            case 'list_task_changes':
                return state.changes

            case 'read_task_change': {
                const path = payload['path'] as string
                const diff = state.diffs.get(path)
                if (!diff)
                    throw new GodotFailure(
                        'task_change_not_listed',
                        `${path} is not a changed file`,
                        false
                    )
                return diff
            }

            case 'list_skills':
                return skillsResponse(state)
            case 'set_skill_enabled': {
                const name = payload['name'] as string
                const held = state.skills.get(name)
                if (held) {
                    state.skills.set(name, {
                        ...held,
                        skill: {...held.skill, enabled: payload['enabled'] as boolean}
                    })
                }
                return skillsResponse(state)
            }
            case 'read_skill':
                return state.skills.get(payload['name'] as string)?.text ?? ''
            case 'write_skill': {
                const name = payload['name'] as string
                const held = state.skills.get(name)
                if (held) state.skills.set(name, {...held, text: payload['text'] as string})
                return skillsResponse(state)
            }
            case 'delete_skill':
                state.skills.delete(payload['name'] as string)
                return skillsResponse(state)
            case 'read_project_sketch':
                log.sketchReads.push(payload['id'] as string)
                return state.sketchHtml
            case 'read_task_brief':
                return state.briefs.get(payload['taskId'] as string) ?? null

            case 'check_workspace_health':
            case 'apply_health_remedy':
                return state.health
            case 'pending_project_changes':
                return []

            case 'list_workspace_files':
                return files
            case 'read_workspace_thumbnail':
                return options.thumbnails?.[payload['path'] as string] ?? null
            case 'watch_workspace_files':
                channels.changes = payload['changes'] as Channels['changes']
                return undefined

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

            case 'call_godot_debug': {
                const op = (request['op'] as string | undefined) ?? ''
                log.debugCalls.push(op)
                return debugAnswer(op, state, publishSessionState)
            }

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
    }

    fake.invoke.mockImplementation(async (command, arguments_) => {
        const override = options.answers?.[command as DesktopCommand]
        if (override) return await override(arguments_ as never, () => respond(command, arguments_))
        return respond(command, arguments_)
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
            publishSessionState('playing')
            return {running: true, frame: FRAME}
        case 'runtime.capture':
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
