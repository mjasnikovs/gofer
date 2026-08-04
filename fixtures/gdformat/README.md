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
    gdformat --check ../godot-project/tests/bridge.gd
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

- All three fixtures parse; `probe.gd` in this directory is the formatter's canonical output.
- `gdformat -` output is idempotent for every fixture.
- Invalid syntax exits 1 with a parser diagnostic on stderr and no stdout, so a failed run can never
  reach a buffer.

## Runtime contract

`src-tauri/src/gdformat.rs` enforces the pin on every launch: the sidecar binary resolves from
`GOFER_GDFORMAT` (development/CI) or the bundled resource directory, `gdformat --version` must
report exactly `gdformat 4.5.0`, buffers travel through stdin (`gdformat -`), and formatted output
is captured from stdout. The formatter never writes the source file; applying a result is a
separate, explicit workspace write after the caller reviews the diff. A missing or wrong-version
sidecar reports `formatter_unavailable` — formatting is the one feature allowed to ship disabled.
