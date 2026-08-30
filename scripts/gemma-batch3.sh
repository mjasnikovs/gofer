#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs/oxloop
export GOFER_LIVE_CONNECTION=cerebras
export GOFER_LIVE_MODEL=gemma-4-31b
run() {
  GOFER_LIVE_FIXTURE=fixtures/live-project GOFER_LIVE_KEEP="$PWD/logs/oxloop/$1-worktree" \
    ./scripts/live-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1
}
run g31-hud "Add a HUD: create a CanvasLayer with a Label that shows the score, add an autoload script that holds the score and emits a signal when it changes, and make the label update from that signal. Run the game, change the score once, and prove the label text changed." &
run g32-coin "Add a collectable coin: create res://scenes/coin.tscn with an Area2D root called Coin holding a Sprite2D and a CollisionShape2D with a circle shape, instance two of them into the main scene at different positions, and print a line when the player enters one. Run the game and prove the print happened." &
wait
run g33-input "Give the player arrow-key movement: add move_left, move_right, move_up and move_down input actions bound to the arrow keys, rewrite the player script to move with them, then run the game, inject a right-arrow press for half a second, and read the player's position back to prove it moved." &
wait
echo "gemma-batch3 done"
