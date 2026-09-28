import {vi} from 'vitest'
import type {Mock} from 'vitest'

type InvokeFunction = (command: string, arguments_?: unknown) => Promise<unknown>
type IsTauriFunction = () => boolean
type EventHandler = (event: {payload: never}) => void
type ListenFunction = (event: string, handler: EventHandler) => Promise<() => void>

export type DesktopFake = Readonly<{
    invoke: Mock<InvokeFunction>
    isTauri: Mock<IsTauriFunction>
    listen: Mock<ListenFunction>
    /** Calls every handler still listening for `event`, as the real bus would. */
    emit: (event: string, payload: unknown) => void
}>

const listening = new WeakMap<DesktopFake, Map<string, Set<EventHandler>>>()

export function createDesktopFake(): DesktopFake {
    const fake: DesktopFake = {
        invoke: vi.fn<InvokeFunction>(),
        isTauri: vi.fn<IsTauriFunction>(),
        listen: vi.fn<ListenFunction>(),
        emit: (event, payload) => {
            for (const handler of [...(listening.get(fake)?.get(event) ?? [])])
                handler({payload: payload as never})
        }
    }
    return fake
}

export function installDesktopFake(fake: DesktopFake) {
    const handlers = new Map<string, Set<EventHandler>>()
    listening.set(fake, handlers)
    fake.isTauri.mockReturnValue(true)
    fake.listen.mockImplementation((event, handler) => {
        const heard = handlers.get(event) ?? new Set()
        handlers.set(event, heard)
        heard.add(handler)
        return Promise.resolve(() => {
            heard.delete(handler)
        })
    })
    window.__GOFER_TEST_DESKTOP__ = fake as unknown as NonNullable<
        typeof window.__GOFER_TEST_DESKTOP__
    >
}

export function removeDesktopFake() {
    delete window.__GOFER_TEST_DESKTOP__
}
