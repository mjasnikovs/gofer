#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
run() { GOFER_LIVE_FIXTURE=fixtures/live-project ./scripts/ox-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1; }
run s21-enemy "Add an enemy that patrols left and right above the floor. When the player touches it, print \"hit\" and move the player back to where it started. Use a signal for the touch rather than polling. Run the game and confirm it starts clean." &
run s23-inspect "Centre the existing Label across the top of the window, make its text red, and set its font size to 32. Read each node's current properties before you change them, so you know what you are overwriting. Run the game and confirm it looks right." &
wait
run s22-hud "Add a Score autoload singleton that holds a number and emits a signal when it changes. Add a HUD CanvasLayer with a Label that listens to that signal and shows the score. The player adds one point every second. Run the game and confirm the label counts up." &
run s24-level "Add a second scene, level_2.tscn, with its own coloured background. When the player walks past the right edge of the window, switch to it with change_scene_to_file. Run the game, drive the player right, and confirm the switch happens." &
wait
echo "batch3 done"
