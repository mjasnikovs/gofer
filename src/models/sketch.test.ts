import {describe, expect, it} from 'vitest'
import {SKETCH_CANVAS, sketchDocument, sketchMessage} from './sketch'
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
    /** The reset goes in front of the agent's markup, not around it. */
    it('is served under Gofer’s reset and nothing else', () => {
        const document = sketchDocument('<p>hello</p>')

        expect(document.startsWith('<style>')).toBe(true)
        expect(document.endsWith('<p>hello</p>')).toBe(true)
        expect(document).not.toContain('--color-')
    })

    /**
     * One canvas for both screens that draw a sketch.
     *
     * The card asks about a composition and the Sketches tab shows that composition again. Two
     * canvases would mean the layout somebody re-checks is not the layout they agreed.
     */
    it('is drawn at one size wherever it is shown', () => {
        expect(SKETCH_CANVAS).toEqual({width: 1280, height: 720})
    })
})

describe('a sketch sent to the chat', () => {
    /**
     * A picture of the result, said out loud.
     *
     * Without the sentence, the markup reads as code to port, and the first thing built off one was
     * an HTML layout translated node for node instead of a Godot scene laid out the same way.
     */
    it('says it is a layout to build, not code to port', () => {
        const message = sketchMessage(SKETCH, '<p>res://ui/panel.png</p>')

        expect(message).toContain('Centered overlay')
        expect(message).toContain('not code to port')
        expect(message).toContain('```html')
        expect(message).toContain('<p>res://ui/panel.png</p>')
    })

    /** The first line identifies the block, which is what a repeated paste is recognised by. */
    it('opens with a line that names which layout it is', () => {
        const [caption] = sketchMessage(SKETCH, '<p>a</p>').split('\n')

        expect(caption).toContain('Centered overlay')
        expect(caption).not.toContain('<p>')
    })
})
