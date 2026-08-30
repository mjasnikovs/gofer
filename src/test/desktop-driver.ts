import {vi} from 'vitest'
import type {Mock} from 'vitest'

type InvokeFunction = (command: string, arguments_?: unknown) => Promise<unknown>
type IsTauriFunction = () => boolean
type ListenFunction = (
    event: string,
    handler: (event: {payload: never}) => void
) => Promise<() => void>

export type DesktopFake = Readonly<{
    invoke: Mock<InvokeFunction>
    isTauri: Mock<IsTauriFunction>
    listen: Mock<ListenFunction>
}>

export function createDesktopFake(): DesktopFake {
    return {
        invoke: vi.fn<InvokeFunction>(),
        isTauri: vi.fn<IsTauriFunction>(),
        listen: vi.fn<ListenFunction>()
    }
}

export function installDesktopFake(fake: DesktopFake) {
    fake.isTauri.mockReturnValue(true)
    fake.listen.mockResolvedValue(() => undefined)
    window.__GOFER_TEST_DESKTOP__ = fake as unknown as NonNullable<
        typeof window.__GOFER_TEST_DESKTOP__
    >
}

export function removeDesktopFake() {
    delete window.__GOFER_TEST_DESKTOP__
}
