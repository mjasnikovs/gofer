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
import type {ProjectSketch, SketchHtml} from '../models/sketch'
import type {BriefRun} from '../models/brief'

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
 *
 * Everything the Ledger owns is held the same way, because canning it brought the hand-rolled
 * switches straight back: a `create_chat_task` that answered with one fixed chat could not be asked
 * whether the project now had two tasks, so eight files went back to writing their own. The tasks,
 * the conversation kept against each one, the memory rows, the sketches and the settings are all
 * here now, and a delete takes the task's unsent message with it the way `Tasks::delete` does.
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
    /** What the startup checks report about the project. */
    health: HealthReport
    /** The project's tasks, newest first, as the sidebar lists them. */
    tasks: TaskSummary[]
    /** One conversation per task, which is what `load_chat` answers about and `save_chat` writes. */
    chats: Map<string, StoredChat>
    /** Every task's stored brief, by task. */
    briefs: Map<string, BriefRun>
    /** The project memory rows, as the panel lists and edits them. */
    memories: ProjectMemory[]
    /** The saved sketches the panel names. */
    sketches: ProjectSketch[]
    /** The markup every sketch is read as. One copy, because a fake needs one. */
    sketchHtml: SketchHtml
    /** The stored settings, which a save replaces and a load answers with. */
    settings: SettingsResponse
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
    /** Every sketch whose markup was fetched, in the order it was asked for. */
    sketchReads: string[]
    /** Every script text the renderer saved. */
    savedScripts: string[]
    /** Each rename transaction that reached the backend, as the paths it rewrote. */
    renames: string[][]
}

/**
 * An answer that replaces the fake's own for one command. Throwing rejects the call.
 *
 * `answer` is what the fake itself would have said, so an override that only changes the timing —
 * holding a switch open to read the window mid-operation — delays it and then delegates, rather
 * than having to reimplement what the command does to the fake's state.
 */
type Answer<Command extends DesktopCommand> = (
    arguments_: DesktopCommandMap[Command]['arguments'],
    answer: () => unknown
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
    /** The chat the project opens with, as the conversation of the task it opens on. */
    chat?: StoredChat
    /** What the startup checks report. Healthy unless a suite is about an unusable project. */
    health?: HealthReport
    /**
     * The tasks the project already has, current one first.
     *
     * A project always has a task, so leaving this out gives one rather than none — a workspace
     * mounts on a task and the chat it reads is that task's. An empty list is a project that has
     * had every task deleted, which is a state a test has to ask for.
     */
    tasks?: readonly TaskSummary[]
    /** A conversation per task, for a suite that switches between them. */
    chats?: Readonly<Record<string, StoredChat>>
    /** A stored brief per task, as `read_task_brief` answers with it. */
    briefs?: Readonly<Record<string, BriefRun>>
    /** The memory rows the project holds. */
    memories?: readonly ProjectMemory[]
    /** The sketches the project holds, and the markup each one reads as. */
    sketches?: readonly ProjectSketch[]
    sketchHtml?: SketchHtml
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

/** A coded rejection, as Tauri hands a serialized `CommandError` to the call that made it. */
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

/** The commit a merged branch is recorded at. One value: the fake merges, it does not do Git. */
const MERGED_COMMIT = 'merged-commit'

/** One key forgotten, the way `DELETE FROM project_state` forgets it: gone, not stored as empty. */
function without(stored: Record<string, unknown>, key: string) {
    return Object.fromEntries(Object.entries(stored).filter(([name]) => name !== key))
}

/** The order `next_task_id` picks a replacement in: the most recently worked-on task. */
function byMostRecentlyWorkedOn(one: TaskSummary, other: TaskSummary) {
    return other.updatedAt - one.updatedAt || other.createdAt - one.createdAt
}

/** What a credential flag becomes: `set` stores one, `clear` removes it, `keep` leaves it alone. */
function keyAfter(update: {action: string} | undefined, had: boolean | undefined) {
    if (update?.action === 'set') return true
    if (update?.action === 'clear') return false
    return had
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

/** A settings file as the backend writes one: every field filled, nothing left to a cast. */
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

/** The settings a project that has never been configured is opened with. */
export const SETTINGS: SettingsResponse = {settings: STORED_SETTINGS, hasApiKey: false}

/** The one task a project has before anybody has made a second. */
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

/** A project with nothing wrong with it, which is what every suite but the gate's own wants. */
export const HEALTHY: HealthReport = {
    workspace: '/home/dev/game',
    workspaceSource: 'configured',
    isReady: true,
    checks: []
}

/** Both copies of a saved sketch: what the user looked at, and what a builder can use. */
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

/** The conversation of a task nobody has said anything in. */
const emptyChat = (taskId: string): StoredChat => ({taskId, messages: [], agentMessages: []})

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
        stored: {...options.stored},
        health: options.health ?? HEALTHY,
        tasks: [...(options.tasks ?? [DEFAULT_TASK])],
        chats: new Map(Object.entries(options.chats ?? {})),
        briefs: new Map(Object.entries(options.briefs ?? {})),
        memories: [...(options.memories ?? [])],
        sketches: [...(options.sketches ?? [])],
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

    /** The task the project is on, which is what every unnamed read is answered about. */
    const currentTask = () => state.tasks.find(task => task.isCurrent)

    /** Stands in for the clock the tasks table stamps its rows with. */
    let stamped = 1_700_000_000_000
    const stamp = () => {
        stamped += 1
        return stamped
    }

    /** Identifiers the fake mints, never one the project is already holding. */
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

    /** Makes a task and opens it, the way `Tasks::create` does: newest first, and current. */
    const createTask = () => {
        const created = newTask(mintTaskId(), true)
        state.tasks = [created, ...state.tasks.map(task => ({...task, isCurrent: false}))]
        state.chats.set(created.id, emptyChat(created.id))
        return created
    }

    /**
     * The task named, adopted when the fake has never heard of it.
     *
     * A suite that mounts a workspace on `task-1` has a project with `task-1` in it, so refusing
     * one would only ever be a fixture missing a line. Adopting never moves the current task: a
     * read about another task is a read, not a switch.
     */
    const taskOf = (taskId: string) => {
        const known = state.tasks.find(one => one.id === taskId)
        if (known) return known
        const adopted = newTask(taskId, state.tasks.length === 0)
        state.tasks = [adopted, ...state.tasks]
        state.chats.set(taskId, emptyChat(taskId))
        return adopted
    }

    const chatOf = (taskId: string) => state.chats.get(taskId) ?? emptyChat(taskId)

    /**
     * The current task's conversation, or an empty one when the project has no task at all.
     *
     * Where `ensure_active_task` would make a task rather than answer that there is nothing to
     * read, this stops: a read that creates a task is a read that changes what the sidebar lists,
     * and no test should have to know that asking for a chat made one.
     */
    const activeChat = (): StoredChat => {
        const current = currentTask()
        return current ? chatOf(current.id) : {messages: [], agentMessages: []}
    }

    // A seeded conversation belongs to a task, so the project holds the task that holds it.
    if (options.chat) {
        const taskId = options.chat.taskId ?? currentTask()?.id ?? 'task-1'
        state.chats.set(taskOf(taskId).id, options.chat)
    }

    /**
     * Deletes a task the way `Tasks::delete` does, and answers with the chat that takes its place.
     *
     * The unsent message goes with it — one `DELETE FROM project_state` beside the row — and the
     * most recently worked-on task left takes over. Where Rust would then mint a replacement for a
     * project it emptied, this stops: a task made by a deletion is not something a screen reads.
     */
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

    /** One memory row as the backend stores it: the three edited fields over everything else. */
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
                return state.settings
            // Stored, then answered with. A save that echoed what the fake was built with made the
            // announce-and-redraw path a no-op, so a screen could redraw from settings nobody wrote.
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
                    )
                }
                return state.settings
            }
            // The real command re-reads the file and replaces only the Godot section, so what comes
            // back is the stored settings carrying what was just sent — not what was already there.
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

            // --- tasks and their conversations -------------------------------------------------
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

            // --- the task's branch -------------------------------------------------------------
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

            // --- what the project remembers ----------------------------------------------------
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
            case 'read_project_sketch':
                log.sketchReads.push(payload['id'] as string)
                return state.sketchHtml
            case 'read_task_brief':
                return state.briefs.get(payload['taskId'] as string) ?? null

            // --- the project on disk -----------------------------------------------------------
            // A fix runs on a filesystem the fake does not have, so it changes nothing on its own:
            // a suite about a project being repaired moves `state.health` and answers with that.
            case 'check_workspace_health':
            case 'apply_health_remedy':
                return state.health
            case 'pending_project_changes':
                return []

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
    }

    // Async, so an override that throws rejects the call rather than the caller: every command a
    // screen makes is awaited, and a synchronous throw here would never reach its `catch`.
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
