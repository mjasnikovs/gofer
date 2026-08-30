#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
queue="$1"
while IFS=$'\t' read -r -u 3 name fixture extra task || [ -n "${name:-}" ]; do
  [ -z "${name:-}" ] && continue
  case "$name" in \#*) continue ;; esac
  if [ -f "logs/oxloop/${name}.json" ]; then
    echo "== skip ${name} (already run)"
    continue
  fi
  echo "== ${name} ${extra} $(date -Is)"
  if [ "$fixture" = "-" ]; then unset GOFER_LIVE_FIXTURE; else export GOFER_LIVE_FIXTURE="$fixture"; fi
  unset GOFER_LIVE_APPROVE GOFER_LIVE_IMAGES GOFER_LIVE_THINKING GOFER_LIVE_CONNECTION GOFER_LIVE_MODEL
  if [ "$extra" != "-" ]; then
    IFS=',' read -ra pairs <<< "$extra"
    for pair in "${pairs[@]}"; do export "${pair?}"; done
  fi
  export GOFER_LIVE_CONNECTION="${GOFER_LIVE_CONNECTION:-openai-codex}"
  if [ "$GOFER_LIVE_CONNECTION" = openai-codex ]; then
    export GOFER_LIVE_MODEL="${GOFER_LIVE_MODEL:-gpt-5.6-sol}"
  fi
  for attempt in 1 2; do
    GOFER_LIVE_THINKING="${GOFER_LIVE_THINKING:-medium}" \
    GOFER_LIVE_KEEP="$PWD/logs/oxloop/${name}-worktree" \
      ./scripts/live-turn.sh "$name" "$task" > "logs/oxloop/${name}.log" 2>&1 < /dev/null
    status=$?
    echo "== ${name} attempt=${attempt} exit=${status} $(date -Is)"
    [ -f "logs/oxloop/${name}.json" ] && break
    [ "$attempt" = 2 ] && echo "== ${name} left no report twice; giving up"
  done
done 3< "$queue"
