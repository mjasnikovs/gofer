import {afterEach, beforeEach, expect, it} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {RememberBlock} from './RememberBlock'
import {forgetMemoryList} from '../../hooks/useRememberedFact'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush} from '../../test/flush'
import {installBackend} from '../../test/backend'
import type {ProjectMemory} from '../../models/memory'
import type {ToolActivity} from '../../models/chat'

const tauri = createDesktopFake()

const CALL: ToolActivity = {
    id: 'call-7',
    name: 'remember',
    target: 'The user never wants a match statement.',
    status: 'complete',
    startedAt: 0
}

const WAITING: ProjectMemory = {
    id: 'memory-1',
    kind: 'preference',
    state: 'candidate',
    content: 'The user never wants a match statement.',
    provenance: {source: 'model', callId: 'call-7'},
    createdAt: 0,
    updatedAt: 0,
    check: 'unanchored',
    anchors: []
}

beforeEach(() => {
    installDesktopFake(tauri)
    forgetMemoryList()
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    forgetMemoryList()
})

async function open(rows: readonly ProjectMemory[] = [WAITING]) {
    const server = installBackend(tauri, {memories: rows})
    render(<RememberBlock tool={CALL} />)
    await flush()
    return {stored: () => server.state.memories}
}

it('asks whether the fact the model wrote is worth keeping', async () => {
    await open()

    expect(screen.getByText('Worth remembering?')).toBeVisible()
    expect(screen.getByText('The user never wants a match statement.')).toBeVisible()
    expect(screen.getByText('preference')).toBeVisible()
})

it('keeping it is what lets a later turn read it', async () => {
    const stored = (await open()).stored
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', {name: 'Keep'}))
    await flush()

    expect(stored().find(row => row.id === 'memory-1')).toMatchObject({state: 'confirmed'})
    expect(screen.getByText('Kept. Later turns can be given it.')).toBeVisible()
})

it('dropping it takes the memory away rather than holding it back', async () => {
    const stored = (await open()).stored
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', {name: 'Drop'}))
    await flush()

    expect(stored()).toEqual([])
    expect(screen.getByText('Not kept. No later turn will be given it.')).toBeVisible()
})

it('a memory that is already gone reads as one that was never kept', async () => {
    await open([])

    expect(screen.queryByRole('button', {name: 'Keep'})).toBeNull()
    expect(screen.getByText('Not kept. No later turn will be given it.')).toBeVisible()
})
