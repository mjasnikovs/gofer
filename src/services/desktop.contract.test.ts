/// <reference types="node" />
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

function between(source: string, opening: string, closing: string, what: string) {
    const after = source.split(opening)[1]
    expect(after, `${what}: opening not found`).toBeDefined()
    const block = after?.split(closing)[0]
    expect(block, `${what}: not closed`).toBeDefined()
    return block ?? ''
}

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
