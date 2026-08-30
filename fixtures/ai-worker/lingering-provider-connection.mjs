import {registerSessionResourceCleanup} from '@earendil-works/pi-ai/compat'

const held = setInterval(() => undefined, 60_000)

registerSessionResourceCleanup(() => clearInterval(held))
