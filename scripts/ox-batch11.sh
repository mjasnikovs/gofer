#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
run() { GOFER_LIVE_FIXTURE=fixtures/live-project ./scripts/local-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1; }
run q44-rename "Rename the player's speed variable to move_speed everywhere it is used, in every script and in the scene if it is exported there. Prove nothing still refers to the old name, then run the game and confirm it still works." &
run q45-cleanup "Tidy the project: move every script into a scripts/gameplay folder, fix whatever refers to them, and delete anything left that nothing uses. Run the game afterwards and confirm it still starts." &
wait
echo "batch11 done"
