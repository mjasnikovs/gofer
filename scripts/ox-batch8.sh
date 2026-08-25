#!/usr/bin/env bash
# On the local model, while OpenRouter's free stealth tier is spent for the day.
# q23 verifies iteration 25 on the task that produced the corpus's largest inspect answer.
# q36 is one of the two surfaces batch6 never reached.
set -uo pipefail
cd "$(dirname "$0")/.."
run() { GOFER_LIVE_FIXTURE=fixtures/live-project ./scripts/local-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1; }
run q23-inspect "Centre the existing Label across the top of the window, make its text red, and set its font size to 32. Read each node's current properties before you change them, so you know what you are overwriting. Run the game and confirm it looks right." &
run q36-save "Add saving: the player's position is written to a file on quit and read back on start, so the game resumes where it left off. Prove it by running the game, moving the player, quitting, and running again." &
wait
echo "batch8 done"
