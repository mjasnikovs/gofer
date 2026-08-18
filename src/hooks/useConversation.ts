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
    /**
     * The task whose conversation this is, as the route names it.
     *
     * Sent with the read. Without it the backend answers about whichever task it has active, and
     * the two disagree for as long as a switch is running — which is exactly when this hook mounts,
     * because the workspace is keyed on the task and a revisited route resolves from the router's
     * cache before the switch it asked for has landed.
     */
    taskId?: string | undefined
    /** Told when the chat could not be read or written. A turn's own failure is in `turnError`. */
    onError: (message: string) => void
    onTasksChanged?: (() => void) | undefined
}>

/**
 * The conversation on screen: one turn runner, read from disk on mount and written back as it
 * changes.
 *
 * The hook is deliberately thin. What a turn does lives in `services/turn.ts`, which knows nothing
 * about React and is tested without it; what is left here is the two things only a component can
 * do — subscribe to the runner, and tie the save to the mount.
 */
export function useConversation({taskId, onError, onTasksChanged}: ConversationOptions) {
    const [isChatLoaded, setIsChatLoaded] = useState(() => !isTauri())
    const isMounted = useRef(false)
    const pendingSave = useRef<StoredChat | undefined>(undefined)
    /** The newest snapshot, saved or not. What the unmount flush has to fall back on. */
    const latestChat = useRef<StoredChat | undefined>(undefined)
    /** The newest snapshot the backend has taken, by identity. */
    const savedChat = useRef<StoredChat | undefined>(undefined)
    const isSaveRunning = useRef(false)

    // Built once and kept: rebuilding the runner would throw the conversation away. It takes
    // nothing that changes between renders, which is what makes that safe.
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

    /*
     * Said out loud, because the sidebar cannot see it.
     *
     * Opening or creating a task moves the checkout the running turn is reading, so the controls
     * that would do it are not offered while this is true. Cleared on the way out as well: a
     * workspace that goes leaves nothing running behind it.
     */
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
                runner.open(loadLegacyChat())
                onError(`Chat history could not be loaded: ${commandErrorMessage(error)}`)
            }
        }
        void load()
        return () => {
            isCancelled = true
        }
        // The initial load runs once; the task is the mount's own and onError is deliberately not
        // a dependency.
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
