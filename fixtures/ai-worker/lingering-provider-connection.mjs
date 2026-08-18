/**
 * Stands in for what the remote provider leaves behind when a turn ends: a connection the answer
 * is already finished with, cached for the next ask, holding the process open until something
 * releases it.
 *
 * The ChatGPT path caches its Codex WebSocket per session for five minutes after the answer, and
 * an open socket keeps Node alive. The backend reads the worker's stdout until it closes, so a
 * worker that will not exit is a turn that never ends: the answer is on screen, nothing is
 * running, and the composer still says Gofer is working.
 *
 * This registers with pi-ai's own session-resource registry — the same one that cache registers
 * with — so a worker that releases session resources releases this too, and one that does not is
 * held open exactly as the real turn is. Preloaded with `--import`, because the point is to hold
 * the worker open from outside it.
 */
import {registerSessionResourceCleanup} from '@earendil-works/pi-ai/compat'

const held = setInterval(() => undefined, 60_000)

registerSessionResourceCleanup(() => clearInterval(held))
