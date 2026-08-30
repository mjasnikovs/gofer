#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
run() { GOFER_LIVE_FIXTURE=fixtures/live-project ./scripts/ox-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1; }
run x08-coin "Add a collectible coin to this game. Create a coin scene with an Area2D that detects the player, give it a script, place one instance in the main scene, and make the player script count how many coins have been collected. Then run the game and confirm it starts without errors." &
run x12-ui "Add a pause menu. Pressing Escape shows a CanvasLayer with a Resume button and a Quit button, and pauses the game. Resume unpauses. Wire both buttons to a script. Run the game and confirm it starts clean." &
wait
run x23-inspect "Centre the existing Label across the top of the window, make its text red, and set its font size to 32. Read each node's current properties before you change them, so you know what you are overwriting. Run the game and confirm it looks right." &
run x11-platformer "Give the player real platformer movement: gravity, a jump on the Space key, and left/right movement with the arrow keys. Use CharacterBody2D and change the player's node type if you have to. Add a floor so the player lands on something. Run the game and confirm it starts clean." &
wait
echo "batch10 done"
