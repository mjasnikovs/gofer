#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
broken() { GOFER_LIVE_FIXTURE=/tmp/claude-1000/-home-edgars-hub-gofer/a29d6062-0e19-4794-a41f-a3c268f5354b/scratchpad/live-broken ./scripts/local-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1; }
run() { GOFER_LIVE_FIXTURE=fixtures/live-project ./scripts/local-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1; }
broken q41-recover "This project will not run. Find out what is wrong, fix it, then run the game and show me it starting cleanly." &
run q42-shooter "Turn this into a small shooter. The player moves left and right with the arrow keys and fires a bullet upward on Space. Enemies spawn at the top every two seconds and fall; a bullet hitting one removes both and adds a point. Show the score on screen. Run the game and prove a hit registers." &
wait
echo "batch9 done"
