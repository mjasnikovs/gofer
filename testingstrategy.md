# Gofer Testing Strategy

This document separates the verified current state from mandatory target requirements. A requirement
is not considered enforced until it is part of `npm run check` or a named CI job.

Gofer will use one versioned cross-language contract, four focused test suites (Rust, Node worker,
Godot, and React), and a small full-system suite. Every production bug must receive a regression
test at the lowest layer capable of reproducing it. A bug involving a language or process boundary
must also receive a shared-contract or integration test that exercises that boundary.

## Current baseline

Verified on August 1, 2026, the enforced suites contain:

- 17 frontend tests: 15 React component/accessibility tests and 2 router tests
- 20 Node tests covering the AI worker/provider, protocol, RAG progress, and workspace confinement
- 63 Rust tests, including shared-protocol, injected-process, and actual Tauri mock-runtime IPC
  tests
- 1 Godot shared-fixture suite and 1 real-process acceptance test covering every mandatory bridge
  scenario
- 5 Playwright visual/accessibility states and 1 WebdriverIO browser-mode desktop journey

The Rust suite measures 83.84% line coverage and 77.42% branch coverage. Critical attachment, cache,
cancellation, credential, path, and protocol regions each measure 100% branch coverage. The
repository includes the versioned shared protocol, a loopback-only Rust transport, a real Godot
scene-control bridge, a checked-in Godot fixture, and real-process acceptance coverage. It also has
a typed renderer adapter, Tauri mock-runtime IPC coverage, selected visual regressions, automated
accessibility scans, enforced Node coverage, and browser-mode WebdriverIO coverage.

The repository has a clean-checkout Linux check workflow and active checked-in commit/push hooks. A
second Linux job builds and launches a release-mode application through WebdriverIO's embedded
driver using isolated application data and a test-feature-only prepared RAG cache. The packaged
journey covers deterministic AI streaming and tool events, an image attachment, real Godot project
mutation and saving, cancellation, and chat/settings restoration in a second application process. A
nightly matrix repeats the packaged journey and real Godot acceptance suites on Linux, Windows, and
macOS. These new workflows have not yet run on GitHub-hosted runners because they are not on
`origin/master`; platform verification remains pending their first push and nightly dispatch.

## Cross-language contract

Create a canonical `protocol/` directory containing:

- JSON Schemas for requests, responses, streamed events, and errors
- Valid and invalid golden JSON fixtures
- A positive integer `protocolVersion` in every top-level request, response, streamed event, and
  error
- Explicit error codes instead of error-message matching
- A compatibility matrix listing every protocol version accepted and emitted by each application
  release

Rust, JavaScript, and Godot must run the same fixtures. A payload one side emits must be readable by
every intended recipient. No language may maintain an unofficial interpretation of the protocol.

Compatibility rules are exact:

- Adding an optional field is backward compatible only when all readers ignore unknown fields.
- Adding a required field, removing a field, changing a field's type or meaning, changing an error
  code, or changing event ordering is breaking and requires a new `protocolVersion`.
- A receiver must reject an unsupported version before performing the requested operation and return
  the `unsupported_protocol_version` error code with its supported versions.
- Golden fixtures define wire behavior. Language-native types do not override the fixtures.

## Rust side

Rust owns filesystem access, credentials, process management, cache management, Tauri commands, and
transport to workers and Godot.

The target Rust suite has three levels:

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
- Path validation, deletion, attachment handling, credential updates, request cancellation, protocol
  parsing, and protocol-version rejection require 100% branch coverage.
- Concurrency tests must use synchronization primitives, not sleeps or timing guesses.

The Rust tests cover settings, injected credential mutation, cache safety, symlinks, HTTP
classifications, concurrent RAG initialization, Godot scene-path validation, Godot log
classification, protocol fixtures, loopback transport, and actual Tauri command wiring through the
mock runtime. Node, RAG-memory, and Godot process spawning use an injected process abstraction with
fake-child lifecycle tests. A named Linux CI job enforces at least 80% line and 75% branch coverage,
plus 100% branch coverage for the marked critical regions.

Reference: [Tauri testing documentation](https://v2.tauri.app/develop/tests/).

## JavaScript worker side

There are two separate JavaScript concerns:

1. Node workers and agent/provider logic
2. React renderer behavior

The Node suite uses `node:test` and local fake HTTP/SSE servers. All tests that can read or write a
workspace must be changed to use a fresh temporary workspace rather than the repository working
directory. The suite must cover:

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

The standalone Godot protocol suite runs the shared fixtures through a real headless binary. Rust
unit tests cover Godot log classification, scene-path validation, and injected process lifecycle.
The real-process acceptance suite starts the fixture bridge and exercises every mandatory scenario
below.

The checked-in fixture project is at `fixtures/godot-project`. CI uses Godot 4.7.1-stable, the
current supported patch on August 1, 2026. Pin the complete version, download URL, and SHA-256
digest independently for Linux, Windows, and macOS. A version update is an intentional repository
change that updates those pins and reruns the full Godot acceptance suite.

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

Godot 4.7.1-stable must be pinned in CI. The suite must pass its absolute binary path through
`GOFER_GODOT_BINARY`; it must not discover or use an arbitrary `godot4` or `godot` from `PATH`.

Godot supports deterministic CI execution through `--headless`, `--path`, and `--script`. Reference:
[Godot 4.7 command-line documentation](https://docs.godotengine.org/en/4.7/tutorials/editor/command_line_tutorial.html).

## UI side

React Testing Library remains the main UI test tool. Tests operate through accessible roles, labels,
typing, clicking, and visible outcomes.

Component-level tests must cover:

- Loading, ready, empty, streaming, cancelled, and failed states
- Settings validation and credential intent
- Attachments
- Tool execution presentation
- Connection and Godot errors
- Keyboard navigation and focus restoration
- Dialog behavior
- Persistence and recovery after reload

Tauri IPC must sit behind one typed frontend adapter. UI tests must mock that adapter instead of
scattering mocks for `invoke()` and `listen()` throughout the suite. The current adapter defines all
renderer command arguments, responses, and event payloads, and UI tests mock it directly.

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

Use WebdriverIO's Tauri support for final desktop journeys. Renderer-only journeys use its browser
mode. Packaged journeys use the real application binary with `@wdio/tauri-service` and the embedded
driver provider. The embedded provider and its required Tauri plugins are mandatory so the same
suite runs on Linux, Windows, and macOS without a paid external driver.

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

The deterministic AI endpoint and model catalog are hosted locally by the journey runner. The
packaged renderer sends requests through the real Rust command layer and a fake Node worker that
emits deterministic stream and tool events. A real pinned Godot bridge mutates a copied fixture. Two
independent WebdriverIO invocations share one isolated application-data root, proving restart
persistence without reusing the first application process.

## When tests run

### Current local gate

Run:

```text
npm run check
```

The command currently includes:

- Formatting
- ESLint
- TypeScript
- React tests
- Node worker tests
- Rust formatting, Clippy, tests, and compile checking
- Shared protocol fixtures in Node, Rust, and Godot
- A React automated-accessibility assertion
- Ignored-test metadata and expiry enforcement

It additionally includes enforced Node coverage, five Playwright visual/accessibility states, and a
WebdriverIO browser-mode journey. The packaged application is intentionally built and exercised in
its separate CI job because it is a release build, not part of the fast local gate. Rust coverage is
enforced in the named `rust-coverage` CI job with `npm run test:coverage:rust`; a summary-only local
report remains available through `npm run test:coverage:rust:report`.

### Local enforcement

Before every commit and push, active checked-in hooks run `npm run check`. The npm `prepare` script
installs the repository hook path and verifies it. `GOFER_GODOT_BINARY` must point to the absolute
pinned Godot 4.7.1-stable binary for the gate to run.

### Target: every push to `master`

CI must rerun `npm run check` from a clean checkout. Because this project works directly on
`master`, the local pre-push gate is mandatory.

A second CI job builds the release-mode Tauri application and launches it through the embedded
WebDriver on Linux. It tests the built application binary, not a Vite development server or an
installer package, and runs every full-system scenario above. A third Linux job enforces Rust line,
branch, and critical-region coverage.

### Target: nightly

Nightly CI builds the release-mode application and runs the packaged journey plus real Godot
acceptance suite on Linux, Windows, and macOS. Each matrix entry uses WebdriverIO's embedded driver
provider and the pinned platform-specific Godot 4.7.1-stable artifact. The matrix is configured but
still requires evidence from its first real GitHub-hosted run.

## Enforcement rules

- Required test jobs and test runners must configure zero automatic retries.
- A flaky test is a broken test; fix it or revert the triggering change.
- Snapshot changes require intentional review. Never update them blindly.
- Every fixed production bug includes a regression test.
- An ignored test must include a tracking-issue URL and an ISO `YYYY-MM-DD` expiry date in the
  ignore reason. CI must fail when either value is absent or the date has expired.
- Required tests never access the public internet.
- After coverage tooling is added, Rust and Node must maintain at least 80% line and 75% branch
  coverage across checked-in production source files. Generated files, fixtures, tests, and build
  output are excluded.
- Critical code means protocol parsing/version rejection, cache-path validation and deletion,
  attachment path validation and storage, credential mutation, Godot scene-path validation, worker
  workspace confinement, and cancellation. Every checked-in source file implementing those behaviors
  must maintain 100% branch coverage.
- UI acceptance is determined by behavioral scenarios, accessibility checks, and selected visual
  baselines, not coverage alone.
- Breaking protocol changes require a version bump and migration or compatibility tests.
- `master` is green, or no new change may be pushed except a change whose purpose is to restore the
  required jobs.

The shared protocol fixture suite is the foundation. Without it, Rust, JavaScript, and Godot can
each pass independently while disagreeing at runtime. With it, most cross-language regressions fail
quickly, while the small packaged-app suite proves that the real pieces still work together.
