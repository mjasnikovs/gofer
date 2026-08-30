#!/usr/bin/env bash
set -euo pipefail
name="$1"; shift
task="$1"
cd "$(dirname "$0")/.."
mkdir -p logs/oxloop
out="$PWD/logs/oxloop/${name}.json"
export GOFER_LIVE_TASK="$task"
export GOFER_LIVE_OUT="$out"
export GOFER_LIVE_CONNECTION="${GOFER_LIVE_CONNECTION:-openai-compatible}"
case "$GOFER_LIVE_CONNECTION" in
  openai-codex)
    export GOFER_LIVE_MODEL="${GOFER_LIVE_MODEL:-gpt-5.6-luna}"
    export GOFER_LIVE_OAUTH="$(secret-tool lookup service com.gofer.desktop username ai-openai-codex)"
    ;;
  openrouter)
    export GOFER_LIVE_MODEL="${GOFER_LIVE_MODEL:-z-ai/glm-5.3-flash}"
    export GOFER_LIVE_API_KEY="$(secret-tool lookup service com.gofer.desktop username ai-openrouter)"
    ;;
  cerebras)
    export GOFER_LIVE_MODEL="${GOFER_LIVE_MODEL:-gpt-oss-120b}"
    export GOFER_LIVE_API_KEY="$(secret-tool lookup service com.gofer.desktop username ai-cerebras)"
    ;;
  openai-compatible) : ;;
  *) echo "GOFER_LIVE_CONNECTION=$GOFER_LIVE_CONNECTION is not a driver this build knows" >&2; exit 2 ;;
esac
if [ -n "${GOFER_APP_DATA_DIR:-}" ]; then export GOFER_APP_DATA_DIR; fi
export GOFER_GDFORMAT="${GOFER_GDFORMAT:-$HOME/.local/share/gofer-gdtoolkit/bin/gdformat}"
run=(cargo test --manifest-path src-tauri/Cargo.toml --features godot-acceptance --lib
     -- live_agent_acceptance --test-threads=1 --nocapture)
if [ "${GOFER_GODOT_DISPLAY:-}" = host ]; then
  exec "${run[@]}"
fi
unset WAYLAND_DISPLAY XDG_SESSION_TYPE
exec xvfb-run -a -s "-screen 0 1920x1080x24" "${run[@]}"
