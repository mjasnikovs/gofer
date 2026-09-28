export type Sketch = Readonly<{
    label: string
    html: string
}>

export const SKETCH_CANVAS = {width: 1280, height: 720}

export type ProjectSketch = Readonly<{
    id: string
    taskId: string | null
    questionId: string
    question: string
    label: string
    isApproved: boolean
    savedAt: number
}>

export type SketchHtml = Readonly<{
    shown: string
    source: string | null
}>

type SketchRevision = Pick<ProjectSketch, 'id' | 'savedAt'>

export type SketchBodies = ReadonlyMap<string, Readonly<{savedAt: number; body: SketchHtml}>>

export const NO_SKETCH_BODIES: SketchBodies = new Map()

// A new revision is saved under the same id, so what was read for the last one is only good for it.
export function bodyOf(bodies: SketchBodies, sketch: SketchRevision): SketchHtml | undefined {
    const read = bodies.get(sketch.id)
    return read?.savedAt === sketch.savedAt ? read.body : undefined
}

export function withBody(
    bodies: SketchBodies,
    sketch: SketchRevision,
    body: SketchHtml
): SketchBodies {
    return new Map(bodies).set(sketch.id, {savedAt: sketch.savedAt, body})
}

export function sketchMessage(sketch: ProjectSketch, source: string): string {
    return (
        `This is the layout I agreed earlier ("${sketch.label}"). It is a picture of the result, `
        + "not code to port: build it with the project's own nodes, and read it for what sits "
        + 'where, how big each region is and what the spacing is.\n\n'
        + `\`\`\`html\n${source}\n\`\`\``
    )
}

export const SKETCH_RESET =
    '*,*::before,*::after{box-sizing:border-box}'
    + 'html,body{margin:0;padding:0;height:100%}'
    + 'img,svg{max-width:100%;display:block}'
    + 'html,body{overflow:hidden}'

export function sketchDocument(html: string): string {
    return `<style>${SKETCH_RESET}</style>${html}`
}

export const AGREED_SKETCH_MARK = 'This is the layout they agreed'

export function holdsAgreedSketch(output: string | undefined): boolean {
    return output?.includes(AGREED_SKETCH_MARK) === true
}
