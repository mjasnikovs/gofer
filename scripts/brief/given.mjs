// What the user wrote under the card template's headings, so the plan keeps it rather than
// writing it again. A heading with nothing under it is the template, not a section.
import {sectionLines} from './refuted.mjs'

/** The sections refine writes; when the user filled one, refine is told to carry it through. */
export const REFINE_SECTIONS = ['GOAL', 'CONSTRAINTS', 'KNOWN-UNKNOWNS']

/** The sections only the spec holds; refine drops them, so they reach compose as decisions. */
const SPEC_SECTIONS = ['STEPS', 'VERIFY']

function filled(raw, name) {
    const lines = sectionLines(raw, name)
        .map(line => line.trimEnd())
        .filter(line => line.trim().length > 0)
    return lines.length === 0 ? null : lines.join('\n')
}

export function givenSections(raw) {
    return REFINE_SECTIONS.filter(name => filled(raw, name) !== null)
}

export function givenDecisions(raw) {
    return SPEC_SECTIONS.flatMap(name => {
        const text = filled(raw, name)
        return text === null ? [] : [{question: `${name} the user wrote`, answer: text}]
    })
}
