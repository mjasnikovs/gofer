#!/usr/bin/env bash
# Two tasks aimed at the surface no recorded run has ever touched.
#
# 43 of the catalogue's 109 operations have never been answered in any live turn, and eleven of
# those are `godot_script`'s language-server intelligence — `references`, `rename`, `apply_rename`,
# `declaration`. The rename path is covered by `godot_lsp_acceptance` against a real editor, so
# what these ask is not whether it works but whether a model ever reaches for it.
set -uo pipefail
cd "$(dirname "$0")/.."
run() { GOFER_LIVE_FIXTURE=fixtures/live-project ./scripts/local-turn.sh "$1" "$2" > "logs/oxloop/$1.log" 2>&1; }
run q44-rename "Rename the player's `speed` variable to `move_speed` everywhere it is used, in every script and in the scene if it is exported there. Prove nothing still refers to the old name, then run the game and confirm it still works." &
run q45-cleanup "Tidy the project: move every script into a scripts/gameplay folder, fix whatever refers to them, and delete anything left that nothing uses. Run the game afterwards and confirm it still starts." &
wait
echo "batch11 done"
