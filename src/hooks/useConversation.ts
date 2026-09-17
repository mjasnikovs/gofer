import {useCallback, useEffect, useRef, useState, useSyncExternalStore} from 'react'
import {schedule} from '../services/clock'
import {compactAiContext, sendAiMessage} from '../services/ai-stream'
import {invoke, isTauri, listen} from '../services/desktop'
import {createTurnRunner} from '../services/turn'
import {setTurnRunning} from '../services/turn-activity'
import {commandErrorMessage} from '../utils/command-error'
import type {StoredChat} from '../models/chat'
import {clearLegacyChat, isStoredChat, loadLegacyChat} from '../services/chat-storage'

const SAVE_DEBOUNCE_MS = 150

type ChatLike = Readonly<{
    taskId?: string | undefined
    messages: StoredChat['messages']
    agentMessages: StoredChat['agentMessages']
}>

/** The chat as it is stored. A queued message is not a fact about the conversation until the
 * model has taken it; stored, it would be replayed into context as though it had been asked. */
function snapshotOf(chat: ChatLike): StoredChat {
    return {
        ...(chat.taskId !== undefined && {taskId: chat.taskId}),
        messages: chat.messages.filter(message => message.status !== 'queued'),
        agentMessages: chat.agentMessages
    }
}

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
    // What the last load answered, serialized: a chat read back from storage is already saved,
    // and saving it again over a door that has written since would be refused for losing rows.
    const loadedChat = useRef<string | undefined>(undefined)

    const [runner] = useState(() =>
        createTurnRunner({
            send: sendAiMessage,
            cancel: requestId => invoke('cancel_ai_request', {requestId}),
            steer: request => invoke('steer_ai_request', {request}),
            compact: compactAiContext
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
                pendingSave.current = undefined
                // As storage sent it, before the runner settles it: a message left streaming is
                // opened as aborted, and that is a change storage has to be told about.
                loadedChat.current = JSON.stringify(snapshotOf(chat))
                // The unmount flush reads this; the chat it held is gone with the load.
                latestChat.current = snapshotOf(chat)
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
        // The door writes an outside agent's calls into this chat; between turns the window
        // reads them back, so the user watches the work where they watch the model's.
        let unlisten: (() => void) | undefined
        void listen('chat-changed', event => {
            if (event.payload.taskId !== taskId || runner.state().isStreaming) return
            void load()
        }).then(stop => {
            if (isCancelled) stop()
            else unlisten = stop
        })
        return () => {
            isCancelled = true
            unlisten?.()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runner])

    useEffect(() => {
        if (!isChatLoaded || !isTauri()) return
        const snapshot = snapshotOf(state)
        latestChat.current = snapshot
        if (JSON.stringify(snapshot) === loadedChat.current) return undefined
        return schedule(() => {
            pendingSave.current = snapshot
            void savePending()
        }, SAVE_DEBOUNCE_MS)
    }, [isChatLoaded, savePending, state])

    useEffect(
        () => () => {
            const pending = latestChat.current
            if (pending === undefined || pending === savedChat.current) return
            if (JSON.stringify(pending) === loadedChat.current) return
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
        handBack: state.handBack,
        takeHandBack: runner.takeHandBack,
        clearTurnError: runner.clearError,
        start: runner.start,
        queue: runner.queue,
        retry: runner.retry,
        compact: runner.compact,
        stop: runner.stop
    }
}
