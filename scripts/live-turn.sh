#!/usr/bin/env bash
# One live turn against whichever connection `GOFER_LIVE_CONNECTION` names.
# Usage: live-turn.sh <name> <task>
#
#   GOFER_LIVE_CONNECTION=openai-codex   GOFER_LIVE_MODEL=gpt-5.6-luna   ./scripts/live-turn.sh …
#   GOFER_LIVE_CONNECTION=openrouter     GOFER_LIVE_MODEL=z-ai/glm-5.3-flash
#   GOFER_LIVE_CONNECTION=cerebras       GOFER_LIVE_MODEL=gpt-oss-120b
#   GOFER_LIVE_CONNECTION=openai-compatible (the default: the local server)
#
# The credential is looked up here, per connection, and named on the command line — the suite never
# reads the keyring itself. ChatGPT's is an OAuth blob rather than a key, so it travels in its own
# variable and fills its own slot.
#
# On its own display, for the reason `scripts/virtual-display.mjs` gives: a turn starts a real
# Godot editor and runs a real windowed game, and every one of those windows otherwise lands on the
# desktop of whoever is running this and takes focus off what they were doing.
# GOFER_GODOT_DISPLAY=host opts out, for watching what the editor is actually doing.
#
# The Wayland session goes with the desktop it belongs to, for the reason that file gives at
# length: `xvfb-run` sets DISPLAY and nothing else, Gofer reads WAYLAND_DISPLAY to decide the
# editor's display driver, and a turn under this wrapper was opening its editor on the developer's
# own compositor regardless.
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
# Left alone unless the caller named one. The docs and sub-agent connections are read from the
# settings file, so this is how a run is pointed at a copy instead of the user's own.
if [ -n "${GOFER_APP_DATA_DIR:-}" ]; then export GOFER_APP_DATA_DIR; fi
# The local gdtoolkit venv, or whatever the caller already named. Without either,
# every formatting step no-ops. See `npm run build:gdformat` for the other way.
export GOFER_GDFORMAT="${GOFER_GDFORMAT:-$HOME/.local/share/gofer-gdtoolkit/bin/gdformat}"
run=(cargo test --manifest-path src-tauri/Cargo.toml --features godot-acceptance --lib
     -- live_agent_acceptance --test-threads=1 --nocapture)
if [ "${GOFER_GODOT_DISPLAY:-}" = host ]; then
  exec "${run[@]}"
fi
unset WAYLAND_DISPLAY XDG_SESSION_TYPE
# 640x480 is this machine's xvfb-run default, and the fixture game is 640x360 — a game window
# larger than the screen is one the compositor may clip, so the screen is stated rather than
# inherited.
exec xvfb-run -a -s "-screen 0 1920x1080x24" "${run[@]}"
