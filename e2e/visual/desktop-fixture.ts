import type {Page} from '@playwright/test'

export type VisualState =
    'first-run' | 'empty' | 'streaming' | 'settings' | 'error' | 'scripts' | 'inspector'

export type DesktopFixtureOptions = Readonly<{seededMessages?: number}>

export async function installDesktop(
    page: Page,
    state: VisualState,
    options: DesktopFixtureOptions = {}
) {
    await page.addInitScript(
        ({currentState, seededMessages}) => {
            const listeners = new Map<string, Set<(event: unknown) => void>>()
            let nextCallbackId = 1
            window.__TAURI_INTERNALS__ = {
                transformCallback: () => nextCallbackId++,
                unregisterCallback: () => undefined
            }
            const script = 'extends Node\n\n\nfunc _ready() -> void:\n\tprint("ready")\n'
            const FIXTURE_ICONS: Record<string, string> = {
                Node2D: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAgMAAABinRfyAAAADFBMVEUAAABam9Vam9Vam9VG6tLsAAAAA3RSTlMAKLP1Q4hCAAAAKUlEQVQI12NggAPG/f8cGNj//7/AwP3//wMG/v//P+AmwErAisHa4AAAKswhZ5Fmo6UAAAAASUVORK5CYII=',
                CharacterBody2D:
                    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAgMAAABinRfyAAAADFBMVEUAAADVWlrVWlrVWlr8ciXIAAAAA3RSTlMAKLP1Q4hCAAAAKUlEQVQI12NggAPG/f8cGNj//7/AwP3//wMG/v//P+AmwErAisHa4AAAKswhZ5Fmo6UAAAAASUVORK5CYII=',
                Camera2D:
                    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAgMAAABinRfyAAAADFBMVEUAAABa1X5a1X5a1X5tBuVgAAAAA3RSTlMAKLP1Q4hCAAAAKUlEQVQI12NggAPG/f8cGNj//7/AwP3//wMG/v//P+AmwErAisHa4AAAKswhZ5Fmo6UAAAAASUVORK5CYII='
            }
            const settings = {
                version: 2,
                ai: {
                    connectionType: 'local',
                    connections: {
                        local: {
                            name: 'Local AI',
                            baseUrl: 'http://127.0.0.1:8080/v1',
                            api: 'openai-completions',
                            chatTemplateThinking: false,
                            model: {
                                id: 'local-model',
                                name: 'Gofer Local',
                                contextWindow: 120_064,
                                maxTokens: 8_192,
                                reasoning: true,
                                supportsReasoningEffort: true,
                                thinkingLevels: [],
                                input: ['text', 'image'],
                                thinkingLevel: 'medium'
                            }
                        }
                    },
                    maxRetries: 2,
                    timeoutMs: 120_000
                }
            }
            const emit = (event: string, payload: unknown) => {
                for (const handler of listeners.get(event) ?? []) handler({event, payload})
            }
            const sketch = (accent: string, name: string) =>
                `<style>body{margin:0;width:1280px;height:720px;background:#0d1020;`
                + `font-family:monospace;color:#dbe4ff}`
                + `.p{position:absolute;top:180px;left:${name === 'Side Panel' ? '900px' : '440px'};`
                + `width:380px;padding:24px;border:2px solid ${accent};background:#141a35}`
                + `h1{color:${accent};font-size:34px;letter-spacing:6px;margin:0 0 20px}`
                + `b{display:block;padding:12px;margin:8px 0;border:1px solid ${accent}}</style>`
                + `<div class="p"><h1>PAUSED</h1><b>RESUME</b><b>OPTIONS</b><b>QUIT</b></div>`
            window.__GOFER_TEST_ASK__ = (
                sketches: number,
                design?: {revision?: number; delegated?: boolean}
            ) => {
                window.__GOFER_TEST_EMIT_STREAM__?.({
                    type: 'tool-start',
                    id: 'ask-1',
                    name: 'ask_user',
                    target: 'Which pause menu layout do you prefer?',
                    startedAt: 1_800_000_004_000
                })
                emit('ai-question-request', {
                    questionId: 'question-1',
                    question: 'Which pause menu layout do you prefer?',
                    why: 'It decides the scene tree I build.',
                    revision: design?.revision ?? 1,
                    ownerCallId: 'ask-1',
                    isDelegated: design?.delegated ?? false,
                    options:
                        sketches === 0 ? ['Its own scene', 'Inside the HUD'] : ([] as string[]),
                    sketches: [
                        {label: 'Centered Overlay', html: sketch('#4f8cff', 'Centered Overlay')},
                        {label: 'Side Panel', html: sketch('#ff4f7d', 'Side Panel')}
                    ].slice(0, sketches)
                })
            }
            window.__GOFER_TEST_ASK_STEP__ = (step: string) => {
                window.__GOFER_TEST_EMIT_STREAM__?.({
                    type: 'tool-update',
                    id: 'ask-1',
                    output: '',
                    step
                })
            }
            window.__GOFER_TEST_APPROVE__ = () => {
                emit('ai-approval-request', {
                    approvalId: 'approval-1',
                    tool: 'godot_project',
                    calls: [
                        {
                            op: 'set_editor_setting',
                            reason: 'This changes an editor setting for every project on this machine.',
                            params: {setting: 'interface/editor/single_window_mode', value: true}
                        }
                    ]
                })
            }
            window.__GOFER_TEST_DESKTOP__ = {
                isTauri: () => true,
                listen: async (event, handler) => {
                    const handlers = listeners.get(event) ?? new Set()
                    handlers.add(handler)
                    listeners.set(event, handlers)
                    return () => handlers.delete(handler)
                },
                invoke: async (command: string, arguments_: unknown) => {
                    if (command === 'check_workspace_health')
                        return {
                            workspace: '/fixture/workspace',
                            workspaceSource: 'working-directory',
                            checks: [],
                            isReady: true
                        }
                    if (command === 'initialize_rag') {
                        if (currentState === 'first-run') return new Promise(() => undefined)
                        if (currentState === 'error')
                            throw new Error('Fixture model cache is unavailable')
                        return undefined
                    }
                    if (command === 'list_project_tasks') return []
                    if (command === 'pending_project_changes')
                        return [
                            {path: 'scripts/player.gd', isNew: false},
                            {path: 'notes/from-the-user.md', isNew: true}
                        ]
                    if (command === 'list_task_changes')
                        return {
                            files: [
                                {
                                    path: 'scripts/player.gd',
                                    status: 'modified',
                                    fromPath: null,
                                    isBinary: false,
                                    added: 12,
                                    removed: 3,
                                    isConflicted: false
                                },
                                {
                                    path: 'scenes/pause_menu.tscn',
                                    status: 'added',
                                    fromPath: null,
                                    isBinary: false,
                                    added: 41,
                                    removed: 0,
                                    isConflicted: false
                                },
                                {
                                    path: 'assets/tiles.png',
                                    status: 'modified',
                                    fromPath: null,
                                    isBinary: true,
                                    added: 0,
                                    removed: 0,
                                    isConflicted: false
                                }
                            ],
                            dropped: 0,
                            isMerging: false
                        }
                    if (command === 'read_task_change')
                        return {
                            path: 'scripts/player.gd',
                            original: script,
                            modified: script.replace('ready', 'started'),
                            isText: true,
                            isTooLarge: false,
                            isSubmodule: false
                        }
                    if (command === 'list_project_sketches')
                        return [
                            {
                                id: 'question-1-run',
                                taskId: 'task-1',
                                questionId: 'question-1',
                                question: 'Which pause menu layout do you prefer?',
                                label: 'Centered Overlay',
                                isApproved: true,
                                savedAt: 1_700_000_000_000
                            },
                            {
                                id: 'question-2-run',
                                taskId: 'task-1',
                                questionId: 'question-2',
                                question: 'Where does the inventory dock sit?',
                                label: 'Side Panel',
                                isApproved: false,
                                savedAt: 1_600_000_000_000
                            }
                        ]
                    if (command === 'list_skills')
                        return {
                            skills: [
                                {
                                    name: 'tile-levels',
                                    description:
                                        'How to build a 2D level from tiles: make the TileSet first, then set cells on a TileMapLayer.',
                                    path: '/project/.gofer/skills/tile-levels/SKILL.md',
                                    enabled: true,
                                    hidden: false
                                },
                                {
                                    name: 'sound-design',
                                    description:
                                        'Where this project puts its audio buses, and which one a new sound belongs on.',
                                    path: '/project/.gofer/skills/sound-design/SKILL.md',
                                    enabled: false,
                                    hidden: false
                                }
                            ],
                            warnings: [
                                {
                                    code: 'invalid_metadata',
                                    message: 'description is required',
                                    path: '/project/.gofer/skills/half-written/SKILL.md'
                                }
                            ]
                        }
                    if (command === 'read_project_sketch')
                        return {
                            shown: sketch('#4f8cff', 'Centered Overlay'),
                            source: sketch('#4f8cff', 'Centered Overlay')
                        }
                    if (command === 'get_godot_session') return undefined
                    if (command === 'start_godot_session')
                        return {
                            state: 'ready',
                            rpcAddress: '127.0.0.1:7000',
                            lspPort: 6005,
                            dapPort: 6006,
                            godotVersion: '4.7.2.stable',
                            worktree: '/fixture/worktree'
                        }
                    if (command === 'call_godot') {
                        const call = (arguments_ as {request?: {command?: string}} | undefined)
                            ?.request
                        if (call?.command === 'session.get_state')
                            return {
                                id: 'fixture',
                                result: {
                                    state: 'ready',
                                    scene: 'res://main.tscn',
                                    revision: 3,
                                    dirty: false,
                                    canUndo: true,
                                    canRedo: false
                                }
                            }
                        if (call?.command === 'scene.get_tree')
                            return {
                                id: 'fixture',
                                result: {
                                    root: {
                                        name: 'Main',
                                        type: 'Node2D',
                                        path: 'Main',
                                        children: [
                                            {
                                                name: 'Player',
                                                type: 'CharacterBody2D',
                                                path: 'Main/Player',
                                                children: [
                                                    {
                                                        name: 'CollisionShapeForThePlayerBody',
                                                        type: 'CollisionShape2D',
                                                        path: 'Main/Player/CollisionShapeForThePlayerBody',
                                                        children: [
                                                            {
                                                                name: 'DeeplyNestedMarkerNodeName',
                                                                type: 'Marker2D',
                                                                path: 'Main/Player/CollisionShapeForThePlayerBody/DeeplyNestedMarkerNodeName',
                                                                children: []
                                                            }
                                                        ]
                                                    }
                                                ]
                                            },
                                            {
                                                name: 'Camera',
                                                type: 'Camera2D',
                                                path: 'Main/Camera',
                                                children: []
                                            }
                                        ]
                                    }
                                }
                            }
                        if (call?.command === 'editor.get_class_icons') {
                            const classes =
                                (call as {params?: {classes?: string[]}}).params?.classes ?? []
                            const icons: Record<string, string> = {}
                            for (const name of classes) {
                                const icon = FIXTURE_ICONS[name]
                                if (icon) icons[name] = icon
                            }
                            return {id: 'fixture', result: {encoding: 'png-base64', icons}}
                        }
                        if (call?.command === 'node.inspect')
                            return {
                                id: 'fixture',
                                result: {
                                    name: 'Player',
                                    type: 'CharacterBody2D',
                                    path: 'Main/Player',
                                    groups: ['players']
                                }
                            }
                        return {id: 'fixture', result: {}}
                    }
                    if (command === 'read_godot_logs')
                        return {
                            entries: [
                                {
                                    sequence: 1,
                                    source: 'editor',
                                    severity: 'info',
                                    message: 'Godot Engine v4.7.2.stable',
                                    timestamp: 1_800_000_000
                                }
                            ],
                            cursor: 1,
                            dropped: 0
                        }
                    if (command === 'list_workspace_files')
                        return [
                            {path: 'scripts/player.gd', bytes: script.length},
                            {path: 'main.tscn', bytes: 220}
                        ]
                    if (command === 'open_script_document')
                        return {
                            path: 'scripts/player.gd',
                            text: script,
                            hash: 'fixture-hash',
                            bytes: script.length,
                            version: 1
                        }
                    if (command === 'format_gdscript')
                        return {
                            formatted: `${script}\n\nfunc _process(_delta: float) -> void:\n\tpass\n`,
                            changed: true
                        }
                    if (command === 'call_script_language') {
                        const request = (arguments_ as {request?: {op?: string}} | undefined)
                            ?.request
                        if (request?.op === 'prepareRename')
                            return {op: 'prepareRename', placeholder: '_ready'}
                        if (request?.op === 'rename')
                            return {
                                op: 'rename',
                                files: [
                                    {
                                        path: 'scripts/player.gd',
                                        originalText: script,
                                        updatedText: script.replace('_ready', 'on_ready')
                                    }
                                ]
                            }
                        return undefined
                    }
                    if (command === 'query_godot_docs')
                        return {
                            passages: [
                                {
                                    chapter: 'CharacterBody2D',
                                    order: 3,
                                    score: 0.812_345,
                                    text: 'Call move_and_slide() after setting velocity. The body resolves collisions against the tilemap and reports them through get_slide_collision().'
                                },
                                {
                                    chapter: 'Physics introduction',
                                    order: 1,
                                    score: 0.703_915,
                                    text: 'A CharacterBody2D is moved by code rather than by the physics engine, which is what makes it the right body for a player.'
                                }
                            ]
                        }
                    if (command === 'load_chat') {
                        const prose =
                            'The body resolves collisions against the tilemap and reports each one '
                            + 'through `get_slide_collision()`, which is what the follow camera reads '
                            + 'to decide whether it should lag behind the fall.\n\n'
                            + '```gdscript\nfunc _physics_process(delta: float) -> void:\n'
                            + '\tvelocity.y += gravity * delta\n\tmove_and_slide()\n```\n\n'
                            + '- The camera lags on the way down\n'
                            + '- It catches up on the way up\n'
                        const reasoning =
                            'The camera has to read the collision the body reports, not the velocity '
                            + 'it was given, or it lags a frame behind every landing.'
                        const stored = Array.from({length: seededMessages}, (_, index) => {
                            const id = index + 1
                            if (index % 2 === 0) {
                                return {
                                    id,
                                    sender: 'user',
                                    text: `Message ${String(id)}. Make the camera follow the player.`,
                                    timestamp: 1_800_000_000_000,
                                    status: 'complete'
                                }
                            }
                            const tools = [0, 1, 2].map(step => ({
                                id: `call-${String(id)}-${String(step)}`,
                                name: ['read_file', 'bash', 'godot_script'][step],
                                target: [
                                    'res://scripts/player.gd',
                                    'npm test -- --runInBand --reporters=default',
                                    'res://scenes/level_one.tscn'
                                ][step],
                                output: 'Done.\nNo errors reported.',
                                status: 'complete',
                                startedAt: 1_800_000_000_000,
                                endedAt: 1_800_000_001_000,
                                tokens: 420
                            }))
                            return {
                                id,
                                sender: 'assistant',
                                text: `Message ${String(id)}. ${prose}`,
                                thinking: reasoning,
                                tools,
                                parts: [
                                    {kind: 'thinking', text: reasoning},
                                    ...tools.map(tool => ({kind: 'tool', toolId: tool.id})),
                                    {kind: 'text', text: `Message ${String(id)}. ${prose}`}
                                ],
                                timestamp: 1_800_000_000_000,
                                status: 'complete',
                                model: 'local-model',
                                usage: {input: 12_000, output: 900, cacheRead: 4_000, total: 16_900}
                            }
                        })
                        return {messages: stored, agentMessages: []}
                    }
                    // `storedSecrets` is not optional to the reducer: a response without it
                    // throws, and only the CI-rendered visual run opens this page.
                    if (command === 'load_settings')
                        return {settings, storedSecrets: {'ai-default': true}}
                    if (command === 'read_agent_prompt' || command === 'save_agent_prompt')
                        return {
                            prompt: 'You are Gofer, a capable local coding agent. Work autonomously toward the user’s goal.',
                            defaultPrompt:
                                'You are Gofer, a capable local coding agent. Work autonomously toward the user’s goal.'
                        }
                    if (command === 'get_rag_cache_status')
                        return currentState === 'first-run' || currentState === 'error' ?
                                {path: '/fixture/cache', sizeBytes: 0, state: 'not-installed'}
                            :   {path: '/fixture/cache', sizeBytes: 1_024, state: 'installed'}
                    if (command === 'list_ai_models')
                        return [
                            {
                                id: 'local-model',
                                name: 'Gofer Local',
                                contextWindow: 120_064,
                                maxTokens: 8_192,
                                reasoning: true,
                                supportsReasoningEffort: true,
                                thinkingLevels: [],
                                input: ['text', 'image']
                            }
                        ]
                    if (command === 'send_ai_message') {
                        if (
                            !arguments_
                            || typeof arguments_ !== 'object'
                            || !('request' in arguments_)
                        )
                            throw new Error('Missing fixture request')
                        if (!('stream' in arguments_))
                            throw new Error('Missing fixture stream channel')
                        const stream = arguments_.stream as {
                            onmessage: (payload: unknown) => void
                        }
                        const request = arguments_.request
                        if (!request || typeof request !== 'object' || !('requestId' in request))
                            throw new Error('Missing fixture request ID')
                        const requestId = request.requestId
                        if (typeof requestId !== 'number')
                            throw new Error('Invalid fixture request ID')
                        const events = [
                            {
                                type: 'thinking-delta',
                                delta: 'The suite has to pass before the script is worth reading.'
                            },
                            {type: 'text-delta', delta: "I'll run the suite first.\n"},
                            {
                                type: 'tool-start',
                                id: 'tool-1',
                                name: 'bash',
                                target: 'npm test',
                                startedAt: 1_800_000_000_000
                            },
                            {
                                type: 'tool-update',
                                id: 'tool-1',
                                output: 'Running tests…'
                            },
                            {
                                type: 'tool-end',
                                id: 'tool-1',
                                output: 'All tests passed',
                                isError: false,
                                endedAt: 1_800_000_001_000
                            },
                            {
                                type: 'text-delta',
                                delta: '## Suite is green\n\nAll tests passed, so the change is safe.'
                            },
                            {type: 'text-delta', delta: ' Now the player script:\n'},
                            {
                                type: 'tool-start',
                                id: 'tool-2',
                                name: 'godot_script',
                                target: 'ls -la assets/tiles/ assets/mario/ assets/goomba/ assets/sprites/ assets/bg/',
                                startedAt: 1_800_000_001_000
                            },
                            {
                                type: 'tool-end',
                                id: 'tool-2',
                                output: 'extends CharacterBody2D',
                                isError: false,
                                endedAt: 1_800_000_002_000
                            },
                            {
                                type: 'tool-start',
                                id: 'tool-3',
                                name: 'subagent',
                                target: 'Find every scene that instances the player and say which of them sets its collision layer',
                                startedAt: 1_800_000_002_000
                            },
                            {
                                type: 'tool-end',
                                id: 'tool-3',
                                output: 'Only main.tscn sets it, to layer 2.',
                                isError: false,
                                endedAt: 1_800_000_003_000
                            },
                            {
                                type: 'tool-start',
                                id: 'tool-4',
                                name: 'ask_user',
                                target: 'Should I build the proposed grouped-block HUD: one 36px stat bar at top-left and one 64px objective panel at top-right, leaving the squad bench unchanged?',
                                startedAt: 1_800_000_003_000
                            },
                            {
                                type: 'tool-end',
                                id: 'tool-4',
                                output: 'Yes, and keep the bench where it is.',
                                isError: false,
                                endedAt: 1_800_000_004_000
                            },
                            {type: 'text-delta', delta: 'Finished the requested change.'},
                            {
                                type: 'done',
                                text: 'Finished the requested change.',
                                thinking: '',
                                stopReason: 'stop',
                                model: 'local-model',
                                agentMessages: [],
                                usage: {
                                    input: 24,
                                    output: 8,
                                    cacheRead: 0,
                                    cacheWrite: 0,
                                    reasoning: 0,
                                    totalTokens: 32,
                                    cost: {total: 0}
                                }
                            }
                        ]
                        if (window.__GOFER_TEST_HOLD_TURN__ === true) {
                            stream.onmessage({requestId, event: events[0]})
                            window.__GOFER_TEST_EMIT_STREAM__ = (event: unknown) => {
                                stream.onmessage({requestId, event})
                            }
                            return new Promise(() => undefined)
                        }
                        for (const event of events) stream.onmessage({requestId, event})
                    }
                    return undefined
                }
            }
            Date.now = () => 1_800_000_000_000
        },
        {currentState: state, seededMessages: options.seededMessages ?? 0}
    )
}
