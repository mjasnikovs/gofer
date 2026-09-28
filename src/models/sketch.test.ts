import {describe, expect, it} from 'vitest'
import {
    NO_SKETCH_BODIES,
    SKETCH_CANVAS,
    bodyOf,
    sketchDocument,
    sketchMessage,
    withBody
} from './sketch'
import type {ProjectSketch} from './sketch'

const SKETCH: ProjectSketch = {
    id: 'question-1-run',
    taskId: null,
    questionId: 'question-1',
    question: 'Where does the pause menu go?',
    label: 'Centered overlay',
    isApproved: true,
    savedAt: 1_700_000_000_000
}

describe('a sketch', () => {
    it('is served under Gofer’s reset and nothing else', () => {
        const document = sketchDocument('<p>hello</p>')

        expect(document.startsWith('<style>')).toBe(true)
        expect(document.endsWith('<p>hello</p>')).toBe(true)
        expect(document).not.toContain('--color-')
    })

    it('is drawn at one size wherever it is shown', () => {
        expect(SKETCH_CANVAS).toEqual({width: 1280, height: 720})
    })
})

describe('the bodies read for open sketches', () => {
    const FIRST = {shown: '<p>first</p>', source: null}
    const SECOND = {shown: '<p>second</p>', source: null}

    it('holds one body per sketch, so a new revision replaces the old one', () => {
        const revised = {...SKETCH, savedAt: SKETCH.savedAt + 1}
        const bodies = withBody(withBody(NO_SKETCH_BODIES, SKETCH, FIRST), revised, SECOND)

        expect(bodies.size).toBe(1)
        expect(bodyOf(bodies, revised)).toBe(SECOND)
    })

    it('answers nothing for a revision it has not read', () => {
        const bodies = withBody(NO_SKETCH_BODIES, SKETCH, FIRST)

        expect(bodyOf(bodies, SKETCH)).toBe(FIRST)
        expect(bodyOf(bodies, {...SKETCH, savedAt: SKETCH.savedAt + 1})).toBeUndefined()
    })
})

describe('a sketch sent to the chat', () => {
    it('says it is a layout to build, not code to port', () => {
        const message = sketchMessage(SKETCH, '<p>res://ui/panel.png</p>')

        expect(message).toContain('Centered overlay')
        expect(message).toContain('not code to port')
        expect(message).toContain('```html')
        expect(message).toContain('<p>res://ui/panel.png</p>')
    })

    it('opens with a line that names which layout it is', () => {
        const [caption] = sketchMessage(SKETCH, '<p>a</p>').split('\n')

        expect(caption).toContain('Centered overlay')
        expect(caption).not.toContain('<p>')
    })
})
