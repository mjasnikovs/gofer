# gdformat pin proof

gdtoolkit is pinned at **4.5.0** — the newest release (2025-10-09) — and its changelog stops at
4.5-era grammar. Before Gofer adopted it, the pin was proven against the Godot 4.7 fixture scripts
and `probe.gd`, which exercises 4.7-era syntax: typed dictionaries (`Dictionary[String, int]`),
typed arrays, lambdas, typed loop variables, `match`, `await`, ternary expressions, and `super()`
calls.

## Proof procedure

With any gdformat 4.5.0 executable (a local `pip install gdtoolkit==4.5.0` works for the proof; the
shipped sidecar is a frozen per-platform executable built in CI):

1. Parse coverage — every fixture must be accepted (exit code 0 or 1; anything else, or a traceback,
   means the grammar drifted and formatting ships disabled):

    ```
    gdformat --check probe.gd
    gdformat --check ../godot-project/tests/protocol_test.gd
    ```

2. Idempotency — formatting the formatter's own output must be a fixed point:

    ```
    gdformat - < probe.gd > once.gd
    gdformat - < once.gd | diff once.gd -
    ```

3. No mutation on invalid syntax — a broken buffer exits non-zero and writes nothing:

    ```
    printf 'func broken(:\n\tpass\n' | gdformat -
    ```

## Results (2026-08, gdtoolkit 4.5.0, CPython 3.14)

- Both fixtures parse; `probe.gd` in this directory is the formatter's canonical output. (The proof
  originally covered a third script, the protocol v1 bridge fixture, which retired with the one-shot
  bridge.)
- `gdformat -` output is idempotent for every fixture.
- Invalid syntax exits 1 with a parser diagnostic on stderr and no stdout, so a failed run can never
  reach a buffer.

## The frozen sidecar runs the same proof

`scripts/build-gdformat.mjs` freezes the pins in `protocol/gdformat-sidecar.json` into a single-file
executable and then runs every step above **against that executable**, not against the virtual
environment that produced it. That distinction is the whole point: a frozen binary that lost a
package data file — lark's grammars are the obvious candidate — packs cleanly and fails at import
time, so a build that never runs its own artifact proves nothing. A build whose executable reports
the wrong version, cannot parse a fixture, is not idempotent, or writes output for invalid syntax
fails rather than shipping.

Verified on 2026-08 (Linux x86_64, CPython 3.14.6, PyInstaller 6.21.0): the frozen `gdformat`
reports `gdformat 4.5.0`, parses both fixtures, is a fixed point on `probe.gd`, and exits 1 with no
stdout for `func broken(:`. Roughly 450 ms per invocation, which is the single-file extraction cost
and is well inside the runtime's 30 s deadline for an explicit format action.

## Runtime contract

`src-tauri/src/gdformat.rs` enforces the pin on every launch: the sidecar binary resolves from
`GOFER_GDFORMAT` (development/CI) or `sidecar/` inside the resource directory, `gdformat --version`
must report exactly `gdformat 4.5.0`, buffers travel through stdin (`gdformat -`), and formatted
output is captured from stdout. The formatter never writes the source file; applying a result is a
separate, explicit workspace write after the caller reviews the diff. A missing or wrong-version
sidecar reports `formatter_unavailable` — formatting is the one feature allowed to ship disabled.
