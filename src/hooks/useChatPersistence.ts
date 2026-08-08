import {useCallback, useEffect, useRef, useState} from 'react'
import {schedule} from '../services/clock'
import {importLegacyChat, loadChat, saveChat} from '../services/chat-session'
import {isTauri} from '../services/desktop'
import {commandErrorMessage} from '../utils/command-error'
import type {Message, StoredChat} from '../models/chat'
import {settleStoredChat} from '../models/chat-timeline'
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
    /** The newest snapshot, saved or not. What the unmount flush has to fall back on. */
    const latestChat = useRef<StoredChat | undefined>(undefined)
    /** The newest snapshot the backend has taken, by identity. */
    const savedChat = useRef<StoredChat | undefined>(undefined)
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
                    savedChat.current = chat
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
                setMessages(settleStoredChat(chat.messages))
                setAgentMessages(chat.agentMessages)
                setTaskId(chat.taskId)
                nextMessageId.current = nextStoredMessageId(chat.messages)
                clearLegacyChat()
                setIsChatLoaded(true)
            } catch (error) {
                if (isCancelled) return
                /*
                 * Saving stays off after a failed read, and that is the point.
                 *
                 * A save is the whole conversation, so enabling it here armed the debounced write
                 * to put whatever this failure left on screen — usually nothing — over a chat that
                 * is still on disk and still fine. The backend now refuses a write that would
                 * shorten a chat, but a refusal the user sees as an error is a worse answer than
                 * never making the write: the conversation is not lost, it just was not read, and
                 * the next start reads it again.
                 */
                const legacy = loadLegacyChat()
                setMessages(settleStoredChat(legacy.messages))
                setAgentMessages(legacy.agentMessages)
                nextMessageId.current = nextStoredMessageId(legacy.messages)
                onError(`Chat history could not be loaded: ${commandErrorMessage(error)}`)
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
        const snapshot: StoredChat = {
            ...(taskId !== undefined && {taskId}),
            messages,
            agentMessages
        }
        latestChat.current = snapshot
        return schedule(() => {
            pendingSave.current = snapshot
            void savePending()
        }, SAVE_DEBOUNCE_MS)
    }, [agentMessages, isChatLoaded, messages, savePending, taskId])

    /*
     * The debounce is given its last chance on the way out.
     *
     * The workspace is keyed on the task, so switching tasks unmounts it — and everything the
     * debounce was still holding went with it. A message sent and then followed by an immediate
     * switch is exactly that window, and it is the message the user is most sure they sent. The
     * write names its own task, so it lands on the task being left rather than the one being
     * opened.
     */
    useEffect(
        () => () => {
            const pending = latestChat.current
            if (pending === undefined || pending === savedChat.current) return
            pendingSave.current = pending
            void savePending()
        },
        [savePending]
    )

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
