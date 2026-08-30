#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
run() { GOFER_LIVE_FIXTURE=fixtures/live-project ./scripts/ox-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1; }
run s31-tilemap "Build a small platform level out of a TileMapLayer: make a tileset from a generated texture, paint a floor and two ledges the player can stand on, and give the player gravity and a jump on Space so it can reach them. Run the game and drive the player onto a ledge to prove it works." &
run s32-autoload "Add a Settings autoload holding a volume number, a getter and a setter, and make the main script read it on ready and print it. Then check the scripts for errors and tell me what the language server says about the autoload." &
wait
run s33-iterate "The player already moves. Add a double jump: the player may jump once more while in the air, and the second jump is weaker. Keep the existing movement working. Run the game, drive it, and prove both jumps happen." &
run s34-audio "Add a sound effect that plays when the player collides with the window edge. Generate the audio file yourself, add an AudioStreamPlayer, and wire it up. Run the game and confirm it starts clean and the player reaches the edge." &
wait
echo "batch4 done"
