#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs/oxloop
run() {
  GOFER_LIVE_FIXTURE="$3" GOFER_LIVE_KEEP="$PWD/logs/oxloop/$1-worktree" \
    ./scripts/ox-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1
}

run x12-ui "Add a pause menu. Pressing Escape shows a CanvasLayer with a Resume button and a Quit button, and pauses the game. Resume unpauses. Wire both buttons to a script. Run the game and confirm it starts clean." fixtures/live-project &
run x23-inspect "Centre the existing Label across the top of the window, make its text red, and set its font size to 32. Read each node's current properties before you change them, so you know what you are overwriting. Run the game and confirm it looks right." fixtures/live-project &
wait

run x11-platformer "Give the player real platformer movement: gravity, a jump on the Space key, and left/right movement with the arrow keys. Use CharacterBody2D and change the player's node type if you have to. Add a floor so the player lands on something. Run the game and confirm it starts clean." fixtures/live-project &
run x50-dialog "Run this game. It does not start. Work out why, fix it, and run it again so it actually starts. Report what was wrong." fixtures/live-nomain &
wait

run x51-backwards "The player walks the wrong way: pressing the right arrow moves it left. Do not guess from reading the code. Set a breakpoint, run the game, press the right arrow, and read the actual value the movement helper returns before you change anything. Then fix it and prove the fix by running the game again." fixtures/live-backwards &
wait
echo "batch12 done"
