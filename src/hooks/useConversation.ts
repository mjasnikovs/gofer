import {useCallback, useEffect, useRef, useState, useSyncExternalStore} from 'react'
import {schedule} from '../services/clock'
import {sendAiMessage} from '../services/ai-stream'
import {invoke, isTauri} from '../services/desktop'
import {createTurnRunner} from '../services/turn'
import {setTurnRunning} from '../services/turn-activity'
import {commandErrorMessage} from '../utils/command-error'
import type {StoredChat} from '../models/chat'
import {clearLegacyChat, isStoredChat, loadLegacyChat} from '../services/chat-storage'

const SAVE_DEBOUNCE_MS = 150

type ConversationOptions = Readonly<{
    taskId?: string | undefined
    onError: (message: string) => void
    onTasksChanged?: (() => void) | undefined
}>

export function useConversation({taskId, onError, onTasksChanged}: ConversationOptions) {
    const [isChatLoaded, setIsChatLoaded] = useState(() => !isTauri())
    const isMounted = useRef(false)
    const pendingSave = useRef<StoredChat | undefined>(undefined)
    const latestChat = useRef<StoredChat | undefined>(undefined)
    const savedChat = useRef<StoredChat | undefined>(undefined)
    const isSaveRunning = useRef(false)

    const [runner] = useState(() =>
        createTurnRunner({
            send: sendAiMessage,
            cancel: requestId => invoke('cancel_ai_request', {requestId})
        })
    )
    const state = useSyncExternalStore(runner.subscribe, runner.state)

    useEffect(() => {
        isMounted.current = true
        return () => {
            isMounted.current = false
        }
    }, [])

    useEffect(() => {
        setTurnRunning('chat', state.isStreaming)
        return () => {
            setTurnRunning('chat', false)
        }
    }, [state.isStreaming])

    const savePending = useCallback(async () => {
        if (isSaveRunning.current) return
        isSaveRunning.current = true
        try {
            while (pendingSave.current) {
                const chat = pendingSave.current
                pendingSave.current = undefined
                try {
                    await invoke('save_chat', {chat})
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
                const response = await invoke('load_chat', {taskId})
                const stored = isStoredChat(response) ? response : {messages: [], agentMessages: []}
                const legacy = loadLegacyChat()
                const chat =
                    (
                        stored.messages.length === 0
                        && stored.agentMessages.length === 0
                        && (legacy.messages.length > 0 || legacy.agentMessages.length > 0)
                    ) ?
                        await invoke('import_legacy_chat', {chat: legacy})
                    :   stored
                if (isCancelled) return
                runner.open(chat)
                clearLegacyChat()
                setIsChatLoaded(true)
            } catch (error) {
                if (isCancelled) return
                runner.open(loadLegacyChat())
                onError(`Chat history could not be loaded: ${commandErrorMessage(error)}`)
            }
        }
        void load()
        return () => {
            isCancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runner])

    useEffect(() => {
        if (!isChatLoaded || !isTauri()) return
        const snapshot: StoredChat = {
            ...(state.taskId !== undefined && {taskId: state.taskId}),
            messages: state.messages,
            agentMessages: state.agentMessages
        }
        latestChat.current = snapshot
        return schedule(() => {
            pendingSave.current = snapshot
            void savePending()
        }, SAVE_DEBOUNCE_MS)
    }, [isChatLoaded, savePending, state])

    useEffect(
        () => () => {
            const pending = latestChat.current
            if (pending === undefined || pending === savedChat.current) return
            pendingSave.current = pending
            void savePending()
        },
        [savePending]
    )

    return {
        messages: state.messages,
        taskId: state.taskId,
        isStreaming: state.isStreaming,
        turnError: state.error,
        isChatLoaded,
        start: runner.start,
        retry: runner.retry,
        stop: runner.stop
    }
}
