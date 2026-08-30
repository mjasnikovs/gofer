import {createContext, use} from 'react'

export type OpenTask = (taskId: string) => void

export const OpenTaskContext = createContext<OpenTask | undefined>(undefined)

export function useOpenTask(): OpenTask | undefined {
    return use(OpenTaskContext)
}
