#!/usr/bin/env bash
# The two tasks batch 4 never got to, then the two that reproduced iterations 15 and 16 — run
# again, same prompt, so the before is on record and the after is measurable.
set -uo pipefail
cd "$(dirname "$0")/.."
run() { GOFER_LIVE_FIXTURE=fixtures/live-project ./scripts/ox-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1; }
run s33-iterate "The player already moves. Add a double jump: the player may jump once more while in the air, and the second jump is weaker. Keep the existing movement working. Run the game, drive it, and prove both jumps happen." &
run s34-audio "Add a sound effect that plays when the player collides with the window edge. Generate the audio file yourself, add an AudioStreamPlayer, and wire it up. Run the game and confirm it starts clean and the player reaches the edge." &
wait
run v22-hud "Add a Score autoload singleton that holds a number and emits a signal when it changes. Add a HUD CanvasLayer with a Label that listens to that signal and shows the score. The player adds one point every second. Run the game and confirm the label counts up." &
run v32-autoload "Add a Settings autoload holding a volume number, a getter and a setter, and make the main script read it on ready and print it. Then check the scripts for errors and tell me what the language server says about the autoload." &
wait
echo "batch5 done"
