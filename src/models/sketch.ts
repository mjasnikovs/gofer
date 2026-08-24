/**
 * What a sketch is: a page the agent wrote for somebody to look at.
 *
 * A question carries these when it is about a layout. They are here rather than beside the question
 * because the frame that draws one is its own thing — what a sketch is and what a question is are
 * two facts, and only one of them changes if the dialog is rebuilt.
 */

/** One thing to look at. `label` names what makes it different, not which one it is. */
export type Sketch = Readonly<{
    label: string
    html: string
}>

/**
 * The size a sketch is drawn at before it is shrunk to fit wherever it is being shown.
 *
 * A game's layout is a fixed number of pixels — 1280x720, not "whatever the column gives it".
 * Reflowed into the width it happens to have, it is a different design from the one that was judged.
 *
 * Here rather than beside either screen that draws one, because both must use it. The card asks
 * about a composition and the Sketches tab shows that composition again; two canvases would mean
 * the layout somebody re-checks is not the layout they agreed.
 */
export const SKETCH_CANVAS = {width: 1280, height: 720}

/** One saved layout, as the list names it. The markup is fetched separately. */
export type ProjectSketch = Readonly<{
    id: string
    taskId: string | null
    questionId: string
    question: string
    label: string
    isApproved: boolean
    /** Milliseconds since the epoch, as the backend stamped it. */
    savedAt: number
}>

/**
 * Both copies of one saved sketch.
 *
 * `shown` is what the user actually looked at, with the project's own fonts and sprites in it, so it
 * is the only copy worth drawing again. `source` is the model's own markup before any of that was
 * inlined, which is the copy worth handing to whoever builds it.
 *
 * `source` is absent for a sketch kept before the second copy existed. That is an age, not a fault,
 * and the screen says so rather than pasting the inlined one in its place.
 */
export type SketchHtml = Readonly<{
    shown: string
    source: string | null
}>

/**
 * A saved layout, worded for a chat message.
 *
 * The model's own markup, not the copy the window inlined the project's artwork into: that one is
 * eighty kilobytes of base64 saying nothing a builder can act on. The same rule the design tool
 * follows when it hands an agreed layout to the agent that will build it.
 *
 * Here rather than in the screen that sends it, so what a sketch says is one fact in one place.
 */
export function sketchMessage(sketch: ProjectSketch, source: string): string {
    return (
        `This is the layout I agreed earlier ("${sketch.label}"). It is a picture of the result, `
        + "not code to port: build it with the project's own nodes, and read it for what sits "
        + 'where, how big each region is and what the spacing is.\n\n'
        + `\`\`\`html\n${source}\n\`\`\``
    )
}

/**
 * The one stylesheet Gofer puts in front of the agent's own, and the frame it is served in.
 *
 * A reset and nothing else, deliberately. A pause menu for a game has to be free to look like a
 * game; injecting this application's palette would mean judging every sketch on how well it
 * imitates a developer tool. The same string is `SKETCH_RESET` in `scripts/ai-ask.mjs`, where the
 * agent is told what it may rely on.
 */
export const SKETCH_RESET =
    '*,*::before,*::after{box-sizing:border-box}'
    + 'html,body{margin:0;padding:0;height:100%}'
    + 'img,svg{max-width:100%;display:block}'
    // No scrollbars. The frame is grown to whatever the sketch laid out, so a bar along the bottom
    // is chrome over a layout somebody is being asked to judge — and it is this window's chrome, not
    // the game's.
    + 'html,body{overflow:hidden}'

/** The markup as the frame receives it: our reset, then whatever the agent wrote. */
export function sketchDocument(html: string): string {
    return `<style>${SKETCH_RESET}</style>${html}`
}

/**
 * The sentence a delegated `ask_user` puts in front of the layout the user agreed.
 *
 * Written down twice on purpose, the way `SKETCH_RESET` is: the other copy is `agreedSketch` in
 * `scripts/ai-ask-loop.mjs`, and Node cannot import this file. It is the only thing left in a stored
 * tool result that says a design was agreed here — `details` do not survive a reload — so it is what
 * an answered block reads to decide whether to point at the Design tab.
 */
export const AGREED_SKETCH_MARK = 'This is the layout they agreed'

/** Whether a finished `ask_user` call ended on a layout the user signed off. */
export function holdsAgreedSketch(output: string | undefined): boolean {
    return output?.includes(AGREED_SKETCH_MARK) === true
}
