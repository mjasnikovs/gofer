import {useCallback, useEffect, useRef, useState} from 'react'
import {schedule} from '../services/clock'
import {importLegacyChat, loadChat, saveChat} from '../services/chat-session'
import {isTauri} from '../services/desktop'
import {commandErrorMessage} from '../utils/command-error'
import type {Message, StoredChat} from '../models/chat'
import {
    clearLegacyChat,
    isStoredChat,
    loadLegacyChat,
    nextStoredMessageId
} from '../services/chat-storage'

const SAVE_DEBOUNCE_MS = 150

type ChatPersistenceOptions = Readonly<{
    onError: (message: string) => void
    onTasksChanged?: (() => void) | undefined
}>

/**
 * Loads the durable chat for the active task and writes it back as it changes.
 *
 * Saves are debounced and then serialized through a single in-flight writer: a burst of streaming
 * updates collapses into one pending snapshot, so the backend never sees overlapping writes.
 */
export function useChatPersistence({onError, onTasksChanged}: ChatPersistenceOptions) {
    const [messages, setMessages] = useState<readonly Message[]>([])
    const [agentMessages, setAgentMessages] = useState<readonly unknown[]>([])
    const [taskId, setTaskId] = useState<string>()
    const [isChatLoaded, setIsChatLoaded] = useState(() => !isTauri())
    const nextMessageId = useRef(1)
    const isMounted = useRef(false)
    const pendingSave = useRef<StoredChat | undefined>(undefined)
    const isSaveRunning = useRef(false)

    useEffect(() => {
        isMounted.current = true
        return () => {
            isMounted.current = false
        }
    }, [])

    const savePending = useCallback(async () => {
        if (isSaveRunning.current) return
        isSaveRunning.current = true
        try {
            while (pendingSave.current) {
                const chat = pendingSave.current
                pendingSave.current = undefined
                try {
                    await saveChat(chat)
                    if (isMounted.current) onTasksChanged?.()
                } catch (error) {
                    if (isMounted.current)
                        onError(`Chat history could not be saved: ${commandErrorMessage(error)}`)
                }
            }
        } finally {
            isSaveRunning.current = false
        }
    }, [onError, onTasksChanged])

    useEffect(() => {
        if (!isTauri()) return
        let isCancelled = false
        const load = async () => {
            try {
                const response = await loadChat()
                const stored = isStoredChat(response) ? response : {messages: [], agentMessages: []}
                const legacy = loadLegacyChat()
                const chat =
                    (
                        stored.messages.length === 0
                        && stored.agentMessages.length === 0
                        && (legacy.messages.length > 0 || legacy.agentMessages.length > 0)
                    ) ?
                        await importLegacyChat(legacy)
                    :   stored
                if (isCancelled) return
                setMessages(chat.messages)
                setAgentMessages(chat.agentMessages)
                setTaskId(chat.taskId)
                nextMessageId.current = nextStoredMessageId(chat.messages)
                clearLegacyChat()
            } catch (error) {
                if (isCancelled) return
                const legacy = loadLegacyChat()
                setMessages(legacy.messages)
                setAgentMessages(legacy.agentMessages)
                nextMessageId.current = nextStoredMessageId(legacy.messages)
                onError(`Chat history could not be loaded: ${commandErrorMessage(error)}`)
            } finally {
                if (!isCancelled) setIsChatLoaded(true)
            }
        }
        void load()
        return () => {
            isCancelled = true
        }
        // The initial load runs once; onError is deliberately not a dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (!isChatLoaded || !isTauri()) return
        return schedule(() => {
            pendingSave.current = {
                ...(taskId !== undefined && {taskId}),
                messages,
                agentMessages
            }
            void savePending()
        }, SAVE_DEBOUNCE_MS)
    }, [agentMessages, isChatLoaded, messages, savePending, taskId])

    // Handing out ids through a callback keeps the counter ref inside this hook, so the caller
    // never mutates a ref during render.
    const takeMessageId = useCallback(() => nextMessageId.current++, [])

    return {
        messages,
        setMessages,
        agentMessages,
        setAgentMessages,
        taskId,
        takeMessageId,
        isChatLoaded,
        isMounted
    }
}
