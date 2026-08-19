import {describe, expect, it} from 'vitest'
import {fileExtension, fileKind, hasThumbnail} from './file-kinds'

describe('what a worktree file is', () => {
    it('names the kinds a Godot project is made of', () => {
        expect(fileKind('scripts/player.gd', false)).toBe('script')
        expect(fileKind('scenes/main.tscn', false)).toBe('scene')
        expect(fileKind('ui/theme.tres', false)).toBe('resource')
        expect(fileKind('audio/jump.wav', false)).toBe('audio')
        expect(fileKind('fonts/pixel.ttf', false)).toBe('font')
        expect(fileKind('README.md', false)).toBe('text')
        expect(fileKind('project.godot', false)).toBe('config')
        expect(fileKind('sprites/player.png', false)).toBe('image')
    })

    it('calls a folder a folder whatever its name looks like', () => {
        expect(fileKind('addons/gut.gd', true)).toBe('folder')
    })

    it('has nothing to say about an extension it does not know', () => {
        expect(fileKind('models/level.blend', false)).toBe('file')
        expect(fileKind('LICENSE', false)).toBe('file')
    })

    /* A dotfile is named by its dot, not extended by it. */
    it('reads no extension out of a leading dot', () => {
        expect(fileExtension('.gitignore')).toBe('')
        expect(fileExtension('src/.env')).toBe('')
        expect(fileExtension('a.b/c')).toBe('')
    })

    it('ignores the case the extension was typed in', () => {
        expect(fileKind('sprites/Player.PNG', false)).toBe('image')
    })
})

describe('which files are worth asking the backend about', () => {
    /*
     * The list holds formats no browser can open. They reach the webview because Rust decodes and
     * re-encodes them as PNG, which is the whole reason a `.tga` can have a preview at all.
     */
    it('includes the textures a browser cannot open on its own', () => {
        for (const path of ['a.tga', 'a.exr', 'a.hdr', 'a.dds']) {
            expect(hasThumbnail(path, false)).toBe(true)
        }
    })

    it('includes svg, which needs no decoder', () => {
        expect(hasThumbnail('branding/logo.svg', false)).toBe(true)
    })

    it('asks for nothing that is not a picture', () => {
        expect(hasThumbnail('scripts/player.gd', false)).toBe(false)
        expect(hasThumbnail('audio/jump.wav', false)).toBe(false)
        expect(hasThumbnail('sprites', true)).toBe(false)
    })
})
