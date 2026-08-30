#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
run() { GOFER_LIVE_FIXTURE=fixtures/live-project ./scripts/ox-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1; }
run r11-platformer "Give the player real platformer movement: gravity, a jump on the Space key, and left/right movement with the arrow keys. Use CharacterBody2D and change the player's node type if you have to. Add a floor so the player lands on something. Run the game and confirm it starts clean." &
run r12-ui "Add a pause menu. Pressing Escape shows a CanvasLayer with a Resume button and a Quit button, and pauses the game. Resume unpauses. Wire both buttons to a script. Run the game and confirm it starts clean." &
wait
run r08-coin "Add a collectible coin to this game. Create a coin scene with an Area2D that detects the player, give it a script, place one instance in the main scene, and make the player script count how many coins have been collected. Then run the game and confirm it starts without errors." &
run r14-3d "Add a second scene with a 3D cube that rotates, lit by a DirectionalLight3D with a Camera3D pointed at it. Leave the existing 2D main scene alone. Run the new scene and confirm it starts clean." &
wait
echo "batch2 done"
