#!/usr/bin/env bash
# A queue of live turns, one after another, each under the connection and conditions its line names.
#
# `live-turn.sh` drives one turn. This drives a list of them, which is what a measurement needs:
# a reproducible workload is several turns of the same task, or the same task under one changed
# variable, and neither is something to type by hand at two in the morning.
#
# Sequential on purpose. Every turn starts a real Godot editor and a real windowed game on its own
# xvfb display, and three of those at once is the environment failure `logs/autonomous-iteration-log.md`
# records at iteration 46 — one game could not open a display, and the turn that lost it read as an
# agent failure rather than as a machine that had run out of screens.
#
# One line of the queue file is one turn, tab separated:
#
#   <name>  <fixture-or-->  <KEY=VALUE,KEY=VALUE-or-->  <task>
#
# The third column is where a run says what it is about. `GOFER_LIVE_THINKING=low` is a level sweep,
# `GOFER_LIVE_IMAGES=off` is a run about whether the frames earn their tokens, `GOFER_LIVE_APPROVE=refuse`
# is a run about what the agent does when it is told no, and `GOFER_LIVE_CONNECTION` with
# `GOFER_LIVE_MODEL` is another model entirely. Every one of them is cleared between lines, so a
# condition one line sets cannot leak into the line after it.
#
# A run whose report already exists is skipped, so a queue can be restarted after an interruption —
# or after a turn was killed — without paying for what it already has.
#
# The finished worktree of every turn is kept beside its report. That is what
# `scripts/game-boot-sweep.sh` reads, and it is also what the *next* queue can name as a fixture:
# a turn against `logs/oxloop/<name>-worktree` is a turn modifying a game an earlier turn built,
# which is the only way to measure iterative work.
#
#   ./scripts/live-queue.sh logs/oxloop/my-queue.tsv
set -uo pipefail
cd "$(dirname "$0")/.."
queue="$1"
# Read on fd 3, not on stdin. `live-turn.sh` below runs a whole `cargo test` — anything under it
# that reads stdin would otherwise eat the rest of this file, and those queue lines would simply
# never run, with nothing said about them. The `|| [ -n "${name:-}" ]` is the other half: a queue
# file whose last line has no newline makes `read` return non-zero after setting the fields, and
# without it that line is dropped.
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
  # `live-turn.sh` picks a model per connection; this only fills in the one this repository's
  # measurements are taken on, and only when the line has not named a connection of its own.
  export GOFER_LIVE_CONNECTION="${GOFER_LIVE_CONNECTION:-openai-codex}"
  if [ "$GOFER_LIVE_CONNECTION" = openai-codex ]; then
    export GOFER_LIVE_MODEL="${GOFER_LIVE_MODEL:-gpt-5.6-sol}"
  fi
  # Twice, if the first attempt leaves no report. A turn writes its `.json` at the end, so a
  # missing one means the run never got as far as the agent: `cargo test` refusing to compile is
  # the one that actually happened, three times in one night, when the working tree was edited in
  # the seconds a queue line was starting. That is not a measurement, it is a lost line, and the
  # cheapest honest answer is to run it again. A run that reached the agent and failed there keeps
  # its report and is not retried, because that failure is the data.
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
