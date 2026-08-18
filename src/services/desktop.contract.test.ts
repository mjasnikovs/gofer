/// <reference types="node" />
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

/*
 * The renderer↔backend wire, checked.
 *
 * `src/services/desktop.ts` declares what the renderer may call and `tauri::generate_handler!`
 * declares what exists to be called. They are two hand-maintained lists in two languages, and
 * nothing in either build reconciles them: a command renamed on one side and not the other
 * compiles, typechecks, lints, and then fails at runtime as "command not found" — which is what a
 * setting that will not store looks like from the outside.
 *
 * Rust already checks `generate_handler!` against the permission grant, in
 * `the_window_is_granted_exactly_the_commands_it_registers`. This is the third side of the same
 * triangle, and the only one a frontend change can break on its own.
 *
 * Files rather than imports: the point is to read what is actually written down.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

function between(source: string, opening: string, closing: string, what: string) {
    const after = source.split(opening)[1]
    expect(after, `${what}: opening not found`).toBeDefined()
    const block = after?.split(closing)[0]
    expect(block, `${what}: not closed`).toBeDefined()
    return block ?? ''
}

/** Command names the renderer declares, in the order they are written. */
function declaredCommands() {
    const block = between(
        read('./desktop.ts'),
        'type DesktopCommandMap = Readonly<{',
        '\n}>',
        'DesktopCommandMap'
    )
    return [...block.matchAll(/^ {4}('[^']+'|[A-Za-z_0-9]+): CommandSpec/gm)].map(match =>
        (match[1] ?? '').replaceAll("'", '')
    )
}

/** Command names the application registers with Tauri, in the order they are written. */
function registeredCommands() {
    const block = between(
        read('../../src-tauri/src/lib.rs'),
        'builder.invoke_handler(tauri::generate_handler![',
        ']);',
        'generate_handler!'
    )
    return block
        .split(',')
        .map(name => name.trim())
        .filter(name => name !== '')
}

/** Commands a Tauri plugin registers for itself. They are never in this application's handler. */
const isPluginCommand = (name: string) => name.startsWith('plugin:')

describe('the renderer and the backend agree on the command surface', () => {
    it('finds both lists, so a silent zero cannot pass this file', () => {
        expect(declaredCommands().length).toBeGreaterThan(40)
        expect(registeredCommands().length).toBeGreaterThan(40)
    })

    it('declares every command the backend registers', () => {
        const declared = new Set(declaredCommands())
        expect(registeredCommands().filter(name => !declared.has(name))).toEqual([])
    })

    it('registers every command the renderer declares', () => {
        const registered = new Set(registeredCommands())
        expect(
            declaredCommands().filter(name => !isPluginCommand(name) && !registered.has(name))
        ).toEqual([])
    })

    it('reaches a plugin only through a namespaced name', () => {
        const registered = new Set(registeredCommands())
        for (const name of declaredCommands().filter(isPluginCommand)) {
            expect(name, 'a plugin command is never in this application handler').toMatch(
                /^plugin:[a-z-]+\|[a-z_]+$/
            )
            expect(registered.has(name)).toBe(false)
        }
    })

    it('keeps both lists sorted, so a new command lands where it can be seen', () => {
        const declared = declaredCommands()
        expect(declared).toEqual([...declared].sort((a, b) => a.localeCompare(b)))
    })

    it('names each command once on each side', () => {
        const declared = declaredCommands()
        const registered = registeredCommands()
        expect(new Set(declared).size).toBe(declared.length)
        expect(new Set(registered).size).toBe(registered.length)
    })
})
