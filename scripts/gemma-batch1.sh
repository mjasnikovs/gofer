#!/usr/bin/env bash
# Four Cerebras Gemma turns, varied, to count the shapes this model tears its tool calls into.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs/oxloop
export GOFER_LIVE_CONNECTION=cerebras
export GOFER_LIVE_MODEL=gemma-4-31b
run() {
  GOFER_LIVE_FIXTURE=fixtures/live-project GOFER_LIVE_KEEP="$PWD/logs/oxloop/$1-worktree" \
    ./scripts/live-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1
}
run g02-coin "Add a collectable coin: create res://scenes/coin.tscn with an Area2D root called Coin holding a Sprite2D and a CollisionShape2D with a circle shape, instance two of them into the main scene at different positions, and print a line when the player enters one. Run the game and prove the print happened." &
run g03-input "Give the player arrow-key movement: add move_left, move_right, move_up and move_down input actions bound to the arrow keys, rewrite the player script to move with them, then run the game, inject a right-arrow press for half a second, and read the player's position back to prove it moved." &
wait
run g04-signal "Add a Timer node to the main scene that fires every second, connect its timeout signal to a method on the main script that counts ticks, and prove by running the game for two seconds that the counter reached two." &
run g05-refactor "Rename the player script's speed export to move_speed everywhere it is used, change its default to 48, and prove by running the game that the player still moves." &
wait
echo "gemma-batch1 done"
