# Gofer Testing Strategy

Gofer will use one versioned cross-language contract, four focused test suites, and a small
full-system suite. Every production bug must become a regression test at the lowest layer capable of
reproducing it.

## Current baseline

As of August 1, 2026, `npm run check` passes with:

- 9 React tests
- 7 Node worker tests
- 16 Rust tests

The current suite does not yet cover a Godot bridge, real Tauri IPC, a packaged desktop application,
accessibility, or visual regressions.

## Cross-language contract

Create a canonical `protocol/` directory containing:

- JSON Schemas for requests, responses, streamed events, and errors
- Valid and invalid golden JSON fixtures
- A protocol version
- Explicit error codes instead of error-message matching
- Compatibility rules: additive fields are allowed; removing or changing a field requires a
  protocol-version change

Rust, JavaScript, and Godot must run the same fixtures. A payload one side emits must be readable by
every intended recipient. No language may maintain an unofficial interpretation of the protocol.

## Rust side

Rust owns filesystem access, credentials, process management, cache management, Tauri commands, and
transport to workers and Godot.

Test it at three levels:

1. Unit tests for validation, serialization, state machines, path safety, cancellation, and error
   mapping.
2. Integration tests using temporary directories, fake credential storage, mock HTTP servers, and
   fake child processes.
3. Tauri mock-runtime tests that invoke actual commands and assert their response and event
   contracts.

Rules:

- OS keyrings, real model downloads, and real AI endpoints never run in normal tests.
- Filesystem code must accept an injected root or dependency.
- Process-spawning code must be testable with a fake process implementation.
- Path validation, deletion, attachment handling, credential updates, and request cancellation
  require complete branch coverage.
- Concurrency tests must use synchronization primitives, not sleeps or timing guesses.

The existing Rust tests already cover settings, cache safety, symlinks, HTTP classifications, and
concurrent RAG initialization. The next gap is actual Tauri command wiring.

Reference: [Tauri testing documentation](https://v2.tauri.app/develop/tests/).

## JavaScript worker side

There are two separate JavaScript concerns:

1. Node workers and agent/provider logic
2. React renderer behavior

The Node worker suite will continue using `node:test`, temporary workspaces, and local fake HTTP/SSE
servers. It must cover:

- Streaming text and reasoning events
- Tool start, update, and end sequences
- Malformed and interrupted streams
- Timeouts, retries, cancellation, and child-process termination
- Image-only and mixed prompts
- Tool failures
- Workspace path confinement
- Agent-history restoration
- Worker stdin/stdout framing
- Every protocol fixture shared with Rust and Godot

No live LLM call belongs in a required gate. Live-provider compatibility may run as a scheduled
diagnostic, but it cannot determine whether `master` is green because it depends on a
nondeterministic external service.

## Godot side

There is no Godot connection in the repository yet, so the current Godot test count is zero.

When the bridge is introduced, add a small checked-in fixture project, such as
`fixtures/godot-project`, using the exact supported Godot version, currently 4.7.

Godot testing has two layers:

1. Headless script tests for bridge/plugin logic, scene inspection, mutation, serialization, and
   error responses.
2. Protocol acceptance tests that start a real Godot process, connect through the real transport,
   send commands, and verify both the response and resulting project files.

Mandatory acceptance scenarios:

- Connect and perform the protocol handshake.
- Open a fixture project.
- Read the scene tree.
- Add a node and set a property.
- Save and reload the scene.
- Run a scene and capture structured output.
- Report a script or parser error.
- Reject an invalid or unsupported command.
- Disconnect, restart Godot, and reconnect.
- Refuse a mismatched protocol version.

Tests inspect scene-tree data, resource files, and structured responses. They do not rely on pixel
screenshots of the Godot editor.

Godot 4.7 must be pinned in CI. The suite must not use whichever `godot` binary happens to be
installed.

Godot supports deterministic CI execution through `--headless`, `--path`, and `--script`. Reference:
[Godot command-line documentation](https://docs.godotengine.org/en/latest/tutorials/editor/command_line_tutorial.html).

## UI side

React Testing Library remains the main UI test tool. Tests operate through accessible roles, labels,
typing, clicking, and visible outcomes.

Component-level tests cover:

- Loading, ready, empty, streaming, cancelled, and failed states
- Settings validation and credential intent
- Attachments
- Tool execution presentation
- Connection and Godot errors
- Keyboard navigation and focus restoration
- Dialog behavior
- Persistence and recovery after reload

Tauri IPC must sit behind one typed frontend adapter. UI tests mock that adapter instead of
scattering mocks for `invoke()` and `listen()` throughout the suite.

Reference: [Tauri API mocking](https://v2.tauri.app/develop/tests/mocking/).

Add automated accessibility checks while retaining role-based behavioral assertions. An automated
accessibility scanner alone is not sufficient.

Visual regression coverage is limited to stable application states:

- First-run preparation
- Empty workspace
- Streaming conversation with tool activity
- Settings dialog
- Error state

Screenshots must be produced in one pinned CI environment with a fixed viewport, fonts, theme,
clock, and disabled animations. Developers must not casually regenerate baselines on different
machines.

Reference: [Playwright visual comparison guidance](https://playwright.dev/docs/test-snapshots).

## Full application tests

Use WebdriverIO's Tauri support for final desktop journeys. It can run against both a browser-only
frontend and the real packaged application.

Reference: [Tauri WebDriver documentation](https://v2.tauri.app/develop/tests/webdriver/).

Keep the full-system suite small:

1. Launch with a fake prepared RAG cache.
2. Configure a fake local AI provider.
3. Send a message and receive streamed output plus a tool event.
4. Attach and send an image.
5. Open the Godot fixture, perform one scene mutation, save it, and verify the result.
6. Cancel an active operation.
7. Restart the application and verify persisted state.

This suite uses:

- A fake deterministic AI server
- Tiny fixture model/cache metadata instead of the 1.68 GiB download
- A real Rust backend
- A real Node worker
- A real pinned Godot process
- The actual built Tauri application

## When tests run

### Every local commit and before every push

Run:

```text
npm run check
```

The command must include:

- Formatting
- ESLint
- TypeScript
- React tests
- Node worker tests
- Rust formatting, Clippy, tests, and compile checking
- Protocol fixture tests
- Godot headless unit tests once the Godot integration exists

### Every push to `master`

CI reruns `npm run check` from a clean checkout. Because this project works directly on `master`,
the local pre-push gate is mandatory.

A second CI job runs the packaged Tauri/Godot journeys on Linux.

### Nightly

Nightly CI runs the packaged journeys on Linux, Windows, and macOS and performs a release build.

## Enforcement rules

- Required test jobs do not retry failures.
- A flaky test is a broken test; fix it or revert the triggering change.
- Snapshot changes require intentional review. Never update them blindly.
- Every fixed production bug includes a regression test.
- Tests may not be ignored without a tracking issue and an expiry date.
- Required tests never access the public internet.
- Rust and Node maintain at least 80% line and 75% branch coverage.
- Critical safety and protocol code maintains 100% branch coverage.
- UI acceptance is determined by behavioral scenarios, accessibility checks, and selected visual
  baselines, not coverage alone.
- Breaking protocol changes require a version bump and migration or compatibility tests.
- `master` is green, or development stops until it is green.

The shared protocol fixture suite is the foundation. Without it, Rust, JavaScript, and Godot can
each pass independently while disagreeing at runtime. With it, most cross-language regressions fail
quickly, while the small packaged-app suite proves that the real pieces still work together.
