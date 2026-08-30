#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
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
  rm -rf "$copy/.godot"
  timeout 180 xvfb-run -a godot --headless --editor --quit-after 3000 --path "$copy" >/dev/null 2>&1
  out="$(timeout 180 xvfb-run -a godot --headless --quit-after 300 --path "$copy" 2>&1)"
  errors="$(printf '%s' "$out" | grep -c '^ERROR:')"
  warnings="$(printf '%s' "$out" | grep -c '^WARNING:')"
  echo "=== $name: $errors errors, $warnings warnings"
  printf '%s' "$out" | grep -E '^(ERROR|WARNING):' | sort | uniq -c | sort -rn | head -6 || true
  noisy=$((noisy + errors + warnings))
done
[ "$noisy" -eq 0 ]
