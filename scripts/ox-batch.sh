#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
run() { GOFER_LIVE_FIXTURE=fixtures/live-project ./scripts/ox-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1; }

run t11-platformer "Give the player real platformer movement: gravity, a jump on the Space key, and left/right movement with the arrow keys. Use CharacterBody2D and change the player's node type if you have to. Add a floor so the player lands on something. Run the game and confirm it starts clean." &
run t12-ui "Add a pause menu. Pressing Escape shows a CanvasLayer with a Resume button and a Quit button, and pauses the game. Resume unpauses. Wire both buttons to a script. Run the game and confirm it starts clean." &
wait
run t13-fix "The main script prints a tick. Change it to print only once every five seconds instead, and write a headless check script under a checks folder that proves the interval by counting ticks over eleven seconds." &
run t14-3d "Add a second scene with a 3D cube that rotates, lit by a DirectionalLight3D with a Camera3D pointed at it. Leave the existing 2D main scene alone. Run the new scene and confirm it starts clean." &
wait
echo "batch done"
