#!/usr/bin/env bash
# One live turn against OpenRouter. `scripts/live-turn.sh` with the connection already chosen,
# kept because the recorded batches name it and their runs have to stay re-runnable unchanged.
#
# The default was `stealth/ox-alpha` until it was revealed, on 2026-08-26, as ZAI's GLM-5.3 Flash.
# The stealth id now answers 404 with that sentence and nothing else. Same weights, real name, so
# the id moves and the script keeps its name: every batch in `logs/oxloop` names this file, and
# their numbers are only comparable to new ones if the model behind it is the same one.
#
# It is not free any more. The stealth tier was, and every measurement in `logs/oxloop/LOG.md`
# taken before the reveal cost nothing; a run of this size is now a billed one.
set -euo pipefail
export GOFER_LIVE_CONNECTION=openrouter
export GOFER_LIVE_MODEL="${GOFER_LIVE_MODEL:-z-ai/glm-5.3-flash}"
exec "$(dirname "$0")/live-turn.sh" "$@"
