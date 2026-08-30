import {createContext, use} from 'react'
import type {CenterTab} from '../models/ui-state'

export const OpenCenterTabContext = createContext<((tab: CenterTab) => void) | undefined>(undefined)

export function useOpenCenterTab() {
    return use(OpenCenterTabContext)
}
