#!/usr/bin/env bash
# The two tasks batch6 never reached: particles and save/load.
set -uo pipefail
cd "$(dirname "$0")/.."
run() { GOFER_LIVE_FIXTURE=fixtures/live-project ./scripts/ox-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1; }
run s35-particles "Add a particle effect that follows the player: a CPUParticles2D emitting small dots. Make it start when the game starts. Run the game and capture a frame showing the particles." &
run s36-save "Add saving: the player's position is written to a file on quit and read back on start, so the game resumes where it left off. Prove it by running the game, moving the player, quitting, and running again." &
wait
echo "batch7 done"
