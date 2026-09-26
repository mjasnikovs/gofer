import assert from 'node:assert/strict'
import test from 'node:test'
import {givenDecisions, givenSections} from './given.mjs'

const TEMPLATE = 'Add a pause menu\n\nGOAL\n\nCONSTRAINTS\n\nKNOWN-UNKNOWNS\n\nSTEPS\n\nVERIFY\n'

test('an untouched template gives nothing', () => {
    assert.deepEqual(givenSections(TEMPLATE), [])
    assert.deepEqual(givenDecisions(TEMPLATE), [])
    assert.deepEqual(givenSections('pause menu pls'), [])
})

test('a filled section is given by name, and steps and verify become decisions', () => {
    const raw =
        'ADD A PAUSE MENU\n\nGOAL\nThe game pauses on ESC.\n\nCONSTRAINTS\n- keep the input map\n'
        + '- no new autoload\n\nKNOWN-UNKNOWNS\n\nSTEPS\n1. add scenes/pause.tscn\n\nVERIFY\n```sh\n# it pauses\n'
        + 'godot_runtime {"ops": []}\n```\n'
    assert.deepEqual(givenSections(raw), ['GOAL', 'CONSTRAINTS'])
    assert.deepEqual(givenDecisions(raw), [
        {question: 'STEPS the user wrote', answer: '1. add scenes/pause.tscn'},
        {
            question: 'VERIFY the user wrote',
            answer: '```sh\n# it pauses\ngodot_runtime {"ops": []}\n```'
        }
    ])
})
