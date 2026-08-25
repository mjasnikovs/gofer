#!/usr/bin/env bash
# One live turn against the OpenRouter model configured in the user's settings.
# Usage: ox-turn.sh <name> <task>
#
# On its own display, for the reason `scripts/virtual-display.mjs` gives: a turn starts a real
# Godot editor and runs a real windowed game, and every one of those windows otherwise lands on the
# desktop of whoever is running this and takes focus off what they were doing.
# GOFER_GODOT_DISPLAY=host opts out, for watching what the editor is actually doing.
set -euo pipefail
name="$1"; shift
task="$1"
cd "$(dirname "$0")/.."
out="$PWD/logs/oxloop/${name}.json"
export GOFER_LIVE_TASK="$task"
export GOFER_LIVE_OUT="$out"
export GOFER_LIVE_BASE_URL="${GOFER_LIVE_BASE_URL:-https://openrouter.ai/api/v1}"
export GOFER_LIVE_MODEL="${GOFER_LIVE_MODEL:-stealth/ox-alpha}"
export GOFER_LIVE_API_KEY="$(secret-tool lookup service com.gofer.desktop username ai-openrouter)"
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
# 640x480 is this machine's xvfb-run default, and the fixture game is 640x360 — a game window
# larger than the screen is one the compositor may clip, so the screen is stated rather than
# inherited.
exec xvfb-run -a -s "-screen 0 1920x1080x24" "${run[@]}"
