import {afterEach, describe, expect, it, vi} from 'vitest'
import {cleanup, renderHook} from '@testing-library/react'
import {useConversation} from './useConversation'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {flushUntil} from '../test/flush'
import {installBackend} from '../test/backend'
import type {StoredChat} from '../models/chat'

const tauri = createDesktopFake()

const EMPTY: StoredChat = {taskId: 't1', messages: [], agentMessages: []}
const WITH_A_DOOR_CALL: StoredChat = {
    taskId: 't1',
    messages: [
        {
            id: 1,
            sender: 'assistant',
            text: '',
            timestamp: 1,
            tools: [
                {
                    id: 'door-1-0',
                    name: 'godot_scene',
                    target: 'list',
                    output: '{"scenes":[]}',
                    status: 'complete',
                    startedAt: 1,
                    endedAt: 2
                }
            ],
            parts: [{kind: 'tool', toolId: 'door-1-0'}],
            status: 'complete'
        }
    ],
    agentMessages: []
}

let chatChanged: ((payload: {taskId: string}) => void) | undefined

afterEach(() => {
    cleanup()
    removeDesktopFake()
    vi.clearAllMocks()
})

describe('the chat and the door', () => {
    it('reloads the chat when the door wrote into this task, and ignores another task', async () => {
        installDesktopFake(tauri)
        const chats = [EMPTY, WITH_A_DOOR_CALL, EMPTY]
        installBackend(tauri, {answers: {load_chat: () => chats.shift()}})
        tauri.listen.mockImplementation((name, handler) => {
            if (name === 'chat-changed')
                chatChanged = payload => {
                    handler({payload: payload as never})
                }
            return Promise.resolve(() => undefined)
        })
        const {result} = renderHook(() => useConversation({taskId: 't1', onError: () => undefined}))
        await flushUntil(() => chatChanged !== undefined)
        await flushUntil(() => tauri.invoke.mock.calls.some(call => call[0] === 'load_chat'))
        expect(result.current.messages).toHaveLength(0)

        chatChanged?.({taskId: 'other'})
        await flushUntil(
            () => tauri.invoke.mock.calls.filter(call => call[0] === 'load_chat').length === 1
        )
        expect(result.current.messages).toHaveLength(0)

        chatChanged?.({taskId: 't1'})
        await flushUntil(() => result.current.messages.length === 1)
        const [message] = result.current.messages
        // The user's screenshot: the window saved its stale copy over what the door had written,
        // and storage refused it for losing rows. A chat read back is never saved back.
        await flushUntil(
            () => tauri.invoke.mock.calls.filter(call => call[0] === 'load_chat').length === 2
        )
        expect(tauri.invoke.mock.calls.some(call => call[0] === 'save_chat')).toBe(false)
        expect(message?.tools?.[0]?.name).toBe('godot_scene')
    })
})
