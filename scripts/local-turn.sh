#!/usr/bin/env bash
# One live turn against the local OpenAI-compatible server, on its own display.
# Usage: local-turn.sh <name> <task>
#
# The same harness `ox-turn.sh` drives, pointed at 127.0.0.1 instead of OpenRouter. It exists
# because OpenRouter's free stealth tier is capped per day: a sweep that runs out at request 1000
# has nowhere else to go, and the local model answers the same turn for nothing.
set -euo pipefail
name="$1"; shift
task="$1"
cd "$(dirname "$0")/.."
export GOFER_LIVE_TASK="$task"
export GOFER_LIVE_OUT="$PWD/logs/oxloop/${name}.json"
export GOFER_LIVE_BASE_URL="${GOFER_LIVE_BASE_URL:-http://127.0.0.1:8080/v1}"
export GOFER_LIVE_MODEL="${GOFER_LIVE_MODEL:-local}"
export GOFER_GDFORMAT="${GOFER_GDFORMAT:-$HOME/.local/share/gofer-gdtoolkit/bin/gdformat}"
run=(cargo test --manifest-path src-tauri/Cargo.toml --features godot-acceptance --lib
     -- live_agent_acceptance --test-threads=1 --nocapture)
if [ "${GOFER_GODOT_DISPLAY:-}" = host ]; then
  exec "${run[@]}"
fi
exec xvfb-run -a -s "-screen 0 1920x1080x24" "${run[@]}"
