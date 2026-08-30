import {describe, expect, it} from 'vitest'
import {fileExtension, fileKind, hasThumbnail, isGeneratedSidecar} from './file-kinds'

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

    it('reads no extension out of a leading dot', () => {
        expect(fileExtension('.gitignore')).toBe('')
        expect(fileExtension('src/.env')).toBe('')
        expect(fileExtension('a.b/c')).toBe('')
    })

    it('ignores the case the extension was typed in', () => {
        expect(fileKind('sprites/Player.PNG', false)).toBe('image')
    })
})

describe('what Godot wrote for itself', () => {
    it('names the sidecars nobody mentions on purpose', () => {
        expect(isGeneratedSidecar('assets/Effects/hit-sparks.png.import')).toBe(true)
        expect(isGeneratedSidecar('scripts/player.gd.uid')).toBe(true)
    })

    it('leaves the file the sidecar belongs to alone', () => {
        expect(isGeneratedSidecar('assets/Effects/hit-sparks.png')).toBe(false)
        expect(isGeneratedSidecar('scripts/player.gd')).toBe(false)
        expect(isGeneratedSidecar('project.godot')).toBe(false)
    })
})

describe('which files are worth asking the backend about', () => {
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
