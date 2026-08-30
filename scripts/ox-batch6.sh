#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
run() { GOFER_LIVE_FIXTURE=fixtures/live-project ./scripts/ox-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1; }
run w22-hud "Add a Score autoload singleton that holds a number and emits a signal when it changes. Add a HUD CanvasLayer with a Label that listens to that signal and shows the score. The player adds one point every second. Run the game and confirm the label counts up." &
run w24-level "Add a second scene, level_2.tscn, with its own coloured background and a label naming it. Run that scene on its own first to check it, then make the player switch to it when it walks past the right edge of the window." &
wait
run s35-particles "Add a particle effect that follows the player: a CPUParticles2D emitting small dots. Make it start when the game starts. Run the game and capture a frame showing the particles." &
run s36-save "Add saving: the player's position is written to a file on quit and read back on start, so the game resumes where it left off. Prove it by running the game, moving the player, quitting, and running again." &
wait
echo "batch6 done"
