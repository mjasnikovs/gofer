#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs/oxloop
run() {
  GOFER_LIVE_FIXTURE=fixtures/live-project GOFER_LIVE_KEEP="$PWD/logs/oxloop/$1-worktree" \
    ./scripts/ox-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1
}

run y01-scene "Build a pause menu as its own scene file: create res://scenes/pause_menu.tscn with a CanvasLayer root called PauseMenu, put a Panel, a Label saying Paused and two Buttons (Resume, Quit) inside it, then instance that scene into the main scene. Wire Resume to unpause and Quit to quit. Run the game and confirm it starts clean." &
run y02-anim "Give the player a squash-and-stretch animation: add an AnimationPlayer with an animation library, an animation that scales the player down and back over half a second, and play it when the game starts. Run the game and confirm the animation actually plays." &
wait

run y03-camera "Add a Camera2D that follows the player smoothly and is limited so it never shows past the edges of the level. Prove it works by moving the player to each edge with injected input and reading the camera's position." &
wait
echo "batch13 done"
