#!/usr/bin/env bash
# Boots each finished worktree's own main scene and counts what the engine complains about.
#
# A turn verifies what it was asked to verify and stops. This asks the other question: with nobody
# driving it, does the finished game print anything? The check that invented this found a run whose
# twelve coins each logged `<Tween>: started with no Tweeners.` on every frame — a real defect in
# generated code that the turn's own verification could not have seen, because the turn was asked
# about the coins being instances and they were.
#
# The editor scan is not optional, and leaving it out is how this script reported four warnings
# that did not exist. `GOFER_LIVE_KEEP` copies `.godot` out with everything else, and that cache
# was written before the turn created its resources — so a cold boot resolves none of their UIDs
# and warns once per reference:
#
#   WARNING: res://scenes/main.tscn:5 - ext_resource, invalid UID: uid://bo5ptrfcyg45g
#            - using text path instead: res://assets/shapes/wall_vertical.tres
#
# The UIDs were right; the cache was stale. One scan first and the same game is silent. A sweep
# that skips it invents a warning for every resource a turn created, which is exactly the kind of
# game this exists to look at.
#
# Usage: game-boot-sweep.sh [directory ...]   (default: logs/oxloop/*-worktree)
set -uo pipefail
cd "$(dirname "$0")/.."
# Copies rather than the originals: the scan writes into `.godot`, and a kept worktree is evidence
# that should read the same the next time somebody looks at it.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

noisy=0
targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  targets=(logs/oxloop/*-worktree)
fi

for worktree in "${targets[@]}"; do
  [ -d "$worktree" ] || continue
  name="$(basename "$worktree")"
  copy="$scratch/$name"
  cp -r "$worktree" "$copy"
  # Rebuilt from nothing, so a cache the turn left behind cannot answer for the files beside it.
  rm -rf "$copy/.godot"
  # `--quit-after` counts main-loop iterations, not seconds, and a headless editor's loop is
  # uncapped, so this number is not a duration — it is "long enough that the scan has finished".
  # The scan is threaded and reimports across many frames, and an editor that leaves mid-scan
  # writes a half-built `.godot`; the boot below then reports exactly the stale-UID warnings this
  # step exists to prevent.
  #
  # Waiting for `[ DONE ] first_scan_filesystem` instead was tried and is wrong: that marker is
  # followed by `update_scripts_classes` and `reimport`, and killing on it left the arena game
  # reporting 8 errors and 11 warnings where a full scan reports none. The engine has no "now I am
  # idle" line to wait on, so a generous count it is, with `timeout` as the real ceiling.
  timeout 180 xvfb-run -a godot --headless --editor --quit-after 3000 --path "$copy" >/dev/null 2>&1
  out="$(timeout 180 xvfb-run -a godot --headless --quit-after 300 --path "$copy" 2>&1)"
  errors="$(printf '%s' "$out" | grep -c '^ERROR:')"
  warnings="$(printf '%s' "$out" | grep -c '^WARNING:')"
  echo "=== $name: $errors errors, $warnings warnings"
  # `|| true`: a silent game is the good answer, and grep saying so with 1 must not be the
  # script's exit code. The count above is the result; this is the detail under it.
  printf '%s' "$out" | grep -E '^(ERROR|WARNING):' | sort | uniq -c | sort -rn | head -6 || true
  noisy=$((noisy + errors + warnings))
done
# Non-zero when any game printed something, so this can gate a batch rather than only inform one.
[ "$noisy" -eq 0 ]
