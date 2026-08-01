# Gofer protocol

`protocolVersion` 1 is the canonical wire contract shared by Rust, JavaScript, and Godot. The JSON
Schemas define structure; the golden fixtures define observable wire behavior. Readers intentionally
allow unknown fields so version 1 may gain optional fields without breaking older readers.

Every receiver validates the protocol version before dispatching a command. Unsupported versions
produce an `unsupported_protocol_version` error with `supportedVersions` in its details.

## Compatibility matrix

| Gofer release | Accepts | Emits |
| ------------- | ------- | ----- |
| 0.1.x         | 1       | 1     |

Changing a required field, removing a field, changing a field's type or meaning, changing an error
code, or changing event ordering requires a new protocol version and compatibility fixtures.
