#!/usr/bin/env bash
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
unset WAYLAND_DISPLAY XDG_SESSION_TYPE
exec xvfb-run -a -s "-screen 0 1920x1080x24" "${run[@]}"
