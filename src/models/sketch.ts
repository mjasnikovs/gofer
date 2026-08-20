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
 * The one stylesheet Gofer puts in front of the agent's own, and the frame it is served in.
 *
 * A reset and nothing else, deliberately. A pause menu for a game has to be free to look like a
 * game; injecting this application's palette would mean judging every sketch on how well it
 * imitates a developer tool. The same string is `SKETCH_RESET` in `scripts/ai-show.mjs`, where the
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
