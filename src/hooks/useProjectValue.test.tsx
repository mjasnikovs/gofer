import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {act, cleanup, render, renderHook, screen, waitFor} from '@testing-library/react'
import {PROJECT_VALUES, useProjectValue, useStoredValue} from './useProjectValue'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {flush} from '../test/flush'
import {CommandFailure, installBackend} from '../test/backend'
import type {DesktopCommand} from '../services/desktop'
import type {ProjectMemory} from '../models/memory'
import type {ProjectValue} from '../models/project-changes'

const tauri = createDesktopFake()

function memory(id: string, content: string): ProjectMemory {
    return {
        id,
        kind: 'fact',
        state: 'candidate',
        content,
        provenance: {source: 'model'},
        createdAt: 0,
        updatedAt: 0,
        check: 'unanchored',
        anchors: []
    }
}

const ONE = memory('one', 'Signals are connected in code.')
const TWO = memory('two', 'The roster lives in scripts/placement.gd.')

const reads = (command: DesktopCommand) =>
    tauri.invoke.mock.calls.filter(call => call[0] === command).length

/** A memory list that answers with the rows it held when asked, once `release` lets it. */
function heldMemories(rows: readonly ProjectMemory[]) {
    const waiting: (() => void)[] = []
    const server = installBackend(tauri, {
        memories: rows,
        answers: {
            list_project_memory: async (_, answer) => {
                const listed = structuredClone(answer())
                await new Promise<void>(resolve => {
                    waiting.push(resolve)
                })
                return listed
            }
        }
    })
    const release = async () => {
        await waitFor(() => {
            expect(waiting.length).toBeGreaterThan(0)
        })
        await act(async () => {
            waiting.shift()?.()
            await Promise.resolve()
        })
    }
    return {server, release}
}

function Memories({name}: Readonly<{name: string}>) {
    const {value, isLoading} = useProjectValue('memories')
    const shown = isLoading ? 'loading' : (value ?? []).map(row => row.id).join(',')
    return <output aria-label={name}>{shown}</output>
}

beforeEach(() => {
    installDesktopFake(tauri)
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    tauri.invoke.mockReset()
})

describe('a project value', () => {
    it('is read once for everything that mounts beside it', async () => {
        installBackend(tauri, {memories: [ONE]})

        render(
            <>
                <Memories name='panel' />
                <Memories name='card' />
            </>
        )

        expect(await screen.findByText('one', {selector: '[aria-label=card]'})).toBeVisible()
        expect(screen.getByLabelText('panel')).toHaveTextContent('one')
        expect(reads('list_project_memory')).toBe(1)
    })

    it('is read once more after a read that changes landed on, however many landed', async () => {
        const {server, release} = heldMemories([ONE])
        render(<Memories name='panel' />)
        await waitFor(() => {
            expect(reads('list_project_memory')).toBe(1)
        })

        server.state.memories.push(TWO)
        for (let change = 0; change < 3; change += 1) server.publishProjectChange('memories')
        await release()

        await waitFor(() => {
            expect(reads('list_project_memory')).toBe(2)
        })
        expect(screen.getByLabelText('panel')).toHaveTextContent('one')
        await release()
        expect(await screen.findByText('one,two')).toBeVisible()
        expect(reads('list_project_memory')).toBe(2)
    })

    it('makes what mounts during a read wait for one that starts after it', async () => {
        const {server, release} = heldMemories([ONE])
        render(<Memories name='panel' />)
        await waitFor(() => {
            expect(reads('list_project_memory')).toBe(1)
        })

        server.state.memories.push(TWO)
        render(<Memories name='card' />)
        await release()

        expect(screen.getByLabelText('panel')).toHaveTextContent('one')
        expect(screen.getByLabelText('card')).toHaveTextContent('loading')
        await release()
        expect(await screen.findByText('one,two', {selector: '[aria-label=card]'})).toBeVisible()
    })

    it.each<[ProjectValue, DesktopCommand, ProjectValue]>([
        ['memories', 'list_project_memory', 'sketches'],
        ['sketches', 'list_project_sketches', 'changes'],
        ['changes', 'list_task_changes', 'board'],
        ['board', 'board_list', 'memories']
    ])(
        'reads %s with %s when the project says it changed, and not when %s did',
        async (what, command, other) => {
            const server = installBackend(tauri)
            const {result} = renderHook(() => useProjectValue(what))
            await waitFor(() => {
                expect(result.current.isLoading).toBe(false)
            })
            const before = reads(command)

            await act(async () => {
                server.publishProjectChange(other)
                await Promise.resolve()
            })
            expect(reads(command)).toBe(before)
            server.publishProjectChange(what)

            await waitFor(() => {
                expect(reads(command)).toBe(before + 1)
            })
        }
    )

    it('stops listening when the last thing showing it goes, and drops a read still on its way', async () => {
        const {server, release} = heldMemories([ONE])
        const {unmount} = render(<Memories name='panel' />)
        await waitFor(() => {
            expect(reads('list_project_memory')).toBe(1)
        })

        unmount()
        await release()
        server.publishProjectChange('memories')
        await flush()

        expect(reads('list_project_memory')).toBe(1)
    })

    it('is loading after a reload until it answers, but never for a change read quietly', async () => {
        const {server, release} = heldMemories([ONE])
        const {result} = renderHook(() => useProjectValue('memories'))
        await release()
        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        server.publishProjectChange('memories')
        await waitFor(() => {
            expect(reads('list_project_memory')).toBe(2)
        })
        expect(result.current.isLoading).toBe(false)
        await release()

        act(() => {
            result.current.reload()
        })
        expect(result.current.isLoading).toBe(true)
        await release()
        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })
    })

    it('says why a read failed, until one answers', async () => {
        let isBroken = true
        const server = installBackend(tauri, {
            memories: [ONE],
            answers: {
                list_project_memory: (_, answer) => {
                    if (isBroken) throw new CommandFailure('memory_unavailable', 'Not open')
                    return answer()
                }
            }
        })
        const {result} = renderHook(() => useProjectValue('memories'))
        await waitFor(() => {
            expect(result.current.failure).toBeInstanceOf(CommandFailure)
        })
        expect(result.current.value).toBeUndefined()

        isBroken = false
        server.publishProjectChange('memories')

        await waitFor(() => {
            expect(result.current.value).toEqual([ONE])
        })
        expect(result.current.failure).toBeUndefined()
    })

    it('keeps the last value it read when a later read fails, and says why', async () => {
        let isBroken = false
        const server = installBackend(tauri, {
            memories: [ONE],
            answers: {
                list_project_memory: (_, answer) => {
                    if (isBroken) throw new CommandFailure('memory_unavailable', 'Not open')
                    return answer()
                }
            }
        })
        const {result} = renderHook(() => useProjectValue('memories'))
        await waitFor(() => {
            expect(result.current.value).toEqual([ONE])
        })

        isBroken = true
        server.publishProjectChange('memories')

        await waitFor(() => {
            expect(result.current.failure).toBeInstanceOf(CommandFailure)
        })
        expect(result.current.value).toEqual([ONE])
    })

    it('renders nothing for a read that picks out what is already shown', async () => {
        const server = installBackend(tauri, {memories: [ONE]})
        let renders = 0
        const pick = (rows: readonly ProjectMemory[] | undefined) => rows?.[0]?.content
        const {result} = renderHook(() => {
            renders += 1
            return useStoredValue(PROJECT_VALUES.memories, pick, Object.is)
        })
        await waitFor(() => {
            expect(result.current.value).toBe(ONE.content)
        })
        const settled = renders

        server.state.memories.push(TWO)
        server.publishProjectChange('memories')
        await waitFor(() => {
            expect(reads('list_project_memory')).toBe(2)
        })
        await flush()

        expect(renders).toBe(settled)
    })
})
