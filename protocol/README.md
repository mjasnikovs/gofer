# Gofer protocol

One wire contract lives here, shared by Rust, TypeScript, and Godot. The JSON Schemas define
structure; the golden fixtures define observable wire behavior. Readers intentionally allow unknown
fields, so a version may gain optional fields without breaking older readers.

| Version | Status                            | Transport                      | Used by                                |
| ------- | --------------------------------- | ------------------------------ | -------------------------------------- |
| 1       | retired with `send_godot_command` | one request per TCP connection | the packaged WebDriver fixture bridge  |
| 2       | current                           | one persistent TCP session     | the Gofer-managed Godot editor session |

Version 1 was the one-shot bridge the packaged WebDriver journey used before that journey drove a
real editor session. Its schemas, fixtures, and implementations were removed with the bridge; the
row remains so a payload found in an old log can still be identified.

Every receiver validates the protocol version before dispatching anything else. An unsupported
version produces an `unsupported_protocol_version` error whose details list the versions that
endpoint accepts.

## Compatibility matrix

| Gofer release | Accepts | Emits |
| ------------- | ------- | ----- |
| 0.1.x         | 2       | 2     |

Changing a required field, removing a field, changing a field's type or meaning, changing an error
code, or changing event ordering requires a new protocol version and compatibility fixtures.

## Layout

```
schemas/v2   canonical JSON Schemas, one per envelope kind
fixtures/v2  valid/, invalid/, and unsupported/ golden payloads
```

A fixture's file name starts with the kind it exercises (`handshake`, `request`, `response`,
`event`, `error`, or `value`), which is how every implementation picks the validator to run.
Fixtures are consumed by tests only: `src-tauri/src/protocol_v2.rs`, `scripts/protocol.test.mjs`,
`src/services/godot-protocol.test.ts`, and `fixtures/godot-project/tests/protocol_test.gd`. The
Godot test reaches them through `res://../../protocol/fixtures`, which resolves for the in-repo
fixture project and never for the shipped addon.

## Version 2

Version 2 exists because the editor session authenticates, streams events for the lifetime of an
editor, frames many messages over one connection, and carries lifecycle state that the retired
one-shot version 1 had no place for.

### Framing

- UTF-8 newline-delimited JSON: exactly one envelope per line, no trailing content.
- Rust binds a random loopback TCP port and passes the address and a 256-bit session token to the
  editor through its process environment; the addon connects outward and sends the handshake first.
- The addon issues no requests. Gofer sends `request` envelopes; the addon answers with `response`
  or `error` and emits `event` envelopes at any time.
- Requests are correlated by `id`. A `response` or `error` reuses the request's `id`. An unsolicited
  `event` uses the session id.

### Envelopes

Every envelope carries `protocolVersion` (exactly `2`), `kind`, and `id` (1–128 characters).

| Kind        | Direction     | Additional fields                                             |
| ----------- | ------------- | ------------------------------------------------------------- |
| `handshake` | addon → Gofer | `token`, `acceptedVersions`, `client`                         |
| `request`   | Gofer → addon | `command`, `params`, optional `expectedRevision`, `timeoutMs` |
| `response`  | addon → Gofer | `result`, optional `revision`                                 |
| `event`     | addon → Gofer | `sequence`, `event`, `data`                                   |
| `error`     | either        | `error`                                                       |

`token` is 64 lowercase hexadecimal characters. `client` reports `name`, `addonVersion`,
`engineVersion`, an absolute `projectPath`, and `capabilities` drawn from the domain list below. The
protocol checks the shape of `engineVersion`; the session supervisor is what rejects any engine that
is not 4.7.1.

Gofer answers a handshake with a `response` whose `result` carries `sessionId`, `acceptedVersion`,
`heartbeatIntervalMs`, and `limits`. A bad token is answered with an `unauthenticated` error and the
connection is closed.

`command` and `event` names are `domain.operation`, where the domain is one of `session`, `scene`,
`node`, `project`, `editor`, `resource`, `script`, `debug`, `runtime`, `logs`, `files`, or `docs`,
and the operation is lowercase snake case. Cancellation is a normal request: `session.cancel` with
`params.requestId`.

`sequence` starts at 0 and increases by one per session; a gap means events were lost and the
session must be resynchronized.

### Errors

An error carries a stable `code` (lowercase snake case), a human `message`, `retryable`, a
`readiness` of `ready`, `starting`, `importing`, or `unavailable`, and a `details` object. Codes
reserved by the protocol itself:

| Code                           | Retryable | Meaning                                            |
| ------------------------------ | --------- | -------------------------------------------------- |
| `invalid_protocol_payload`     | no        | The envelope does not match this contract          |
| `unsupported_protocol_version` | no        | The endpoint speaks other versions                 |
| `unauthenticated`              | no        | The handshake token did not match                  |
| `payload_too_large`            | no        | The envelope exceeded the applicable size limit    |
| `revision_conflict`            | yes       | `expectedRevision` is stale                        |
| `not_ready`                    | yes       | The session is starting, importing, or unavailable |

Domain handlers add their own codes; they never redefine these.

### Revisions

The edited scene carries a revision that increases on every accepted mutation. A mutating request
must carry `expectedRevision`, and a mutating response carries the resulting `revision`. When the
expected revision is stale the addon answers `revision_conflict` and changes nothing. The mutating
commands are `session.undo`, `session.redo`, `scene.create`, `scene.save`, `scene.save_as`,
`scene.reload`, `node.create`, `node.duplicate`, `node.rename`, `node.reparent`, `node.delete`,
`node.set_property`, `node.add_to_group`, `node.remove_from_group`, `node.connect_signal`, and
`node.disconnect_signal`.

### Limits

| Limit                   | Value             |
| ----------------------- | ----------------- |
| `maxEnvelopeBytes`      | 1048576 (1 MiB)   |
| `maxImageEnvelopeBytes` | 16777216 (16 MiB) |
| `maxImageEdgePixels`    | 1920              |
| `id` length             | 128 characters    |
| `timeoutMs`             | 1–600000          |

The 1 MiB cap applies to every envelope except a `response` or `event` that carries an image frame —
an object at `result.frame` or `data.frame` whose `encoding` is `png-base64` — which may reach 16
MiB. Screenshots are PNG and at most 1920 pixels on the longest edge. A receiver answers
`payload_too_large` and closes the connection, because a truncated line desynchronizes the framing.

### Tagged values

Godot values cross the wire as `{"type": …, "value": …}` so that a `Vector2` never arrives as an
anonymous pair of numbers.

| Type                                                                     | `value`                                      |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| `null`                                                                   | absent or `null`                             |
| `bool`, `int`, `float`, `string`                                         | the JSON primitive                           |
| `array`                                                                  | an array of tagged values                    |
| `dictionary`                                                             | an array of `{"key": value, "value": value}` |
| `vector2`, `vector3`, `vector4`, `quaternion`, `color`, `plane`, `rect2` | 2, 3, or 4 numbers                           |
| `vector2i`, `vector3i`, `vector4i`, `rect2i`                             | 2, 3, or 4 integers                          |
| `transform2d`, `basis`, `transform3d`                                    | 6, 9, or 12 numbers                          |
| `resource`                                                               | `{path, resourceType, uid?}`                 |
| `node`                                                                   | `{path, nodeType, instanceId?}`              |
| `object`                                                                 | `{className, instanceId}`                    |
| `opaque`                                                                 | `{typeName, text}`                           |

Dictionaries are entry arrays because Godot dictionaries accept non-string keys. `opaque` carries
values that cannot round-trip, so the agent sees what a value is without pretending it can be
edited. Tagged values are validated where a command contract places them; the envelope validators do
not walk `params`, `result`, or `data`.

### Runtime feedback

The `runtime` domain is the one domain whose requests the addon does not answer from the editor
process. `runtime.get_tree`, `runtime.inspect_node`, `runtime.input`, `runtime.capture`, and
`runtime.get_monitors` are forwarded over Godot's remote-debugger channel to the GoferRuntime
autoload inside the running game, which answers on a `gofer` message capture; `runtime.run`,
`runtime.stop`, `runtime.restart`, and `runtime.get_state` drive the editor's play controls. The RPC
contract does not change: deferred requests are correlated by `id` and answered whenever the game
replies, a stopped or never-started game answers `runtime_not_running` (retryable), and a game that
never replies answers `runtime_timeout` (retryable). `runtime.ready` and `runtime.stopped` events
track the helper's lifecycle.

Every `runtime.input` event accepts an optional integer `device`, which lands on the built event
unchanged instead of the device the engine would have assigned. It exists so a game can tell
injected input apart from input the desktop delivered to its window at the same moment: the game
window is a real, focusable window, and without a marked device an assertion about injected input is
really an assertion about nobody touching the keyboard. Omitting it keeps the previous behaviour, so
the field is additive and needs no new `protocolVersion`.

A successful `runtime.run` or `runtime.restart` response carries the game's first rendered frame,
and a successful `runtime.input` response carries a frame captured after the events were dispatched
and rendered — capture is manual (`runtime.capture`) and automatic after successful run/input
actions, never continuous video. Frames use the `frame` shape from
`response-runtime-screenshot.json`: PNG, base64, at most 1920 px on the longest edge. The game
helper is inert when the debugger is not attached, so a game launched outside the editor answers
`runtime_not_running` like a stopped one.

### Compatibility rules

- Receivers ignore unknown fields at every level, so optional fields may be added within version 2.
- A handshake declares `acceptedVersions`; Gofer selects the highest version both sides accept and
  reports it as `acceptedVersion`. With no overlap it answers `unsupported_protocol_version` with
  `details.supportedVersions`.
- Anything else in the "changing" list above requires version 3 plus fixtures under `v3/`.
