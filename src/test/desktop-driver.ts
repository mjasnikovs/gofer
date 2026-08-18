import {vi} from 'vitest'
import type {Mock} from 'vitest'

type InvokeFunction = (command: string, arguments_?: unknown) => Promise<unknown>
type IsTauriFunction = () => boolean
/** The handler's payload is whatever the event carries; each test names the shape it emits. */
type ListenFunction = (
    event: string,
    handler: (event: {payload: never}) => void
) => Promise<() => void>

export type DesktopFake = Readonly<{
    invoke: Mock<InvokeFunction>
    isTauri: Mock<IsTauriFunction>
    listen: Mock<ListenFunction>
}>

/**
 * A fake backend that answers through the real `services/desktop`.
 *
 * Deliberately not `vi.mock` of that module. Mocking it replaces the one file that knows every
 * command's name and payload shape, which meant the tests that mounted the most of the application
 * were also the ones that could not notice a command being renamed. The module exposes a driver
 * hook for exactly this, and the live desktop sweep drives the built application through the same
 * one — so a fake here is wired the way the real thing is.
 */
export function createDesktopFake(): DesktopFake {
    return {
        invoke: vi.fn<InvokeFunction>(),
        isTauri: vi.fn<IsTauriFunction>(),
        listen: vi.fn<ListenFunction>()
    }
}

/** Puts the fake behind the bridge, answering as a desktop build with nothing listening yet. */
export function installDesktopFake(fake: DesktopFake) {
    fake.isTauri.mockReturnValue(true)
    fake.listen.mockResolvedValue(() => undefined)
    window.__GOFER_TEST_DESKTOP__ = fake as unknown as NonNullable<
        typeof window.__GOFER_TEST_DESKTOP__
    >
}

/** Takes it away again, so one file's fake cannot answer another file's calls. */
export function removeDesktopFake() {
    delete window.__GOFER_TEST_DESKTOP__
}
