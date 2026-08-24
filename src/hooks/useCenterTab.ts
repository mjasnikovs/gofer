import {createContext, use} from 'react'
import type {CenterTab} from '../models/ui-state'

/**
 * Opening one of the workspace's centre views from inside the conversation.
 *
 * The frame owns which tab is showing, and the conversation is drawn inside the frame — so this is
 * published downwards rather than lifted upwards. One caller today: an answered design block, which
 * points at the Design tab where the layout it agreed is kept.
 *
 * Optional on purpose. A conversation rendered outside the frame, which is what a test renders, has
 * no tabs to open and draws the line without the button rather than failing.
 */
export const OpenCenterTabContext = createContext<((tab: CenterTab) => void) | undefined>(undefined)

export function useOpenCenterTab() {
    return use(OpenCenterTabContext)
}
