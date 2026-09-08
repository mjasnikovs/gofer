import {useEffect, useState} from 'react'
import {listProjectMemory} from '../services/project-memory'
import type {ProjectMemory} from '../models/memory'

// What one `remember` call left behind, once the memory list has been read.
export type RememberedFact = Readonly<{
    memory: ProjectMemory | undefined
    isLoaded: boolean
}>

let pending: Promise<readonly ProjectMemory[]> | undefined

const listeners = new Set<() => void>()

// One list read serves every card in the conversation. A transcript can hold a dozen of them and
// they all mount at once when it is opened.
function memories(): Promise<readonly ProjectMemory[]> {
    pending ??= listProjectMemory().catch(() => [])
    return pending
}

export function forgetMemoryList() {
    pending = undefined
    for (const listener of listeners) listener()
}

export function useRememberedFact(callId: string | undefined): RememberedFact {
    const [state, setState] = useState<{memory: ProjectMemory | undefined; isLoaded: boolean}>({
        memory: undefined,
        isLoaded: false
    })

    useEffect(() => {
        let current = true
        const read = () => {
            void memories().then(rows => {
                if (!current) return
                setState({
                    memory: rows.find(row => row.provenance['callId'] === callId),
                    isLoaded: true
                })
            })
        }
        read()
        listeners.add(read)
        return () => {
            current = false
            listeners.delete(read)
        }
    }, [callId])

    return {memory: state.memory, isLoaded: state.isLoaded}
}
