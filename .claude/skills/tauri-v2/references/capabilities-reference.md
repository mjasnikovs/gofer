# Tauri v2 capabilities and permissions

## Contents

- Security model
- Minimal capability
- Plugin scopes
- Application command restrictions
- Remote API access
- Validation checklist

## Security model

A capability grants Tauri core or plugin permissions to selected windows/webviews and, optionally,
platforms or remote origins. Multiple matching capabilities merge their permissions. Keep each
capability focused so that merging does not accidentally erase a security boundary.

Registered application commands are different: commands registered with `Builder::invoke_handler`
are available to local application windows and webviews by default. A capability does not validate
the implementation of a custom command.

Official sources:

- [Capabilities](https://v2.tauri.app/security/capabilities/)
- [Permissions](https://v2.tauri.app/security/permissions/)
- [Command scopes](https://v2.tauri.app/security/scope/)
- [Using plugin permissions](https://v2.tauri.app/learn/security/using-plugin-permissions/)

## Minimal capability

Use the schema generated for the target platform and grant only what the frontend actually calls:

```json
{
    "$schema": "../gen/schemas/desktop-schema.json",
    "identifier": "main-capability",
    "description": "Permissions required by the main window",
    "windows": ["main"],
    "permissions": ["core:default"]
}
```

Platform names are case-sensitive schema values: `linux`, `macOS`, `windows`, `iOS`, and `android`.
Verify them in the generated schema.

Do not assume `core:default` or a plugin's `default` permission includes a particular operation.
Inspect `src-tauri/gen/schemas/` or the official permission table for the installed version.

## Plugin scopes

Separate the command permission from the resource scope. The exact identifiers and scope shapes are
plugin-defined.

### Filesystem

This verified pattern allows `exists` only in the application's data directory:

```json
{
    "permissions": [
        {
            "identifier": "fs:allow-exists",
            "allow": [{"path": "$APPDATA/*"}]
        }
    ]
}
```

For recursive access, use the documented recursive glob for the installed plugin and add explicit
denies for sensitive descendants. Do not grant `$HOME/**/*` as a shortcut. See the
[filesystem plugin permissions](https://v2.tauri.app/plugin/file-system/#permissions).

### HTTP

`http:default` enables fetch operations but allows no origins until a URL scope is configured:

```json
{
    "permissions": [
        {
            "identifier": "http:default",
            "allow": [{"url": "https://api.example.com"}],
            "deny": [{"url": "https://private.api.example.com"}]
        }
    ]
}
```

Use exact HTTPS origins whenever possible. See the
[HTTP client plugin](https://v2.tauri.app/plugin/http-client/).

### Shell and sidecars

The shell plugin's default permission allows opening `http(s)`, `tel`, and `mailto` targets. Process
execution requires `shell:allow-execute` or `shell:allow-spawn` plus an allow entry.

Never use `args: true` by default. Define the command, fixed arguments, and validators in their
exact order. For example:

```json
{
    "permissions": [
        {
            "identifier": "shell:allow-execute",
            "allow": [
                {
                    "name": "status-tool",
                    "cmd": "status-tool",
                    "args": ["--format", {"validator": "^(json|text)$"}]
                }
            ]
        }
    ]
}
```

Treat validators as a security boundary. Anchor them, reject path separators when paths are not
expected, and do not interpolate untrusted strings through a shell. See the
[shell plugin](https://v2.tauri.app/plugin/shell/) and
[sidecar guide](https://v2.tauri.app/develop/sidecar/).

## Restrict application commands

Use an application manifest when registered custom commands should participate in capability
permissions:

```rust
// src-tauri/build.rs
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["read_document"])),
    )
    .unwrap();
}
```

After declaring application commands in the manifest, define application permissions and include
only those permissions in the appropriate capabilities. Follow the current
[application permission documentation](https://v2.tauri.app/security/permissions/#permissions-for-your-application);
do not invent a namespace or TOML structure.

Whether or not an application manifest is used, validate command inputs in Rust. In particular:

- Resolve user-selected paths to allowed roots and prevent traversal or symlink escape as
  appropriate.
- Allowlist URL schemes and origins.
- Bound collection, string, and binary sizes.
- Authorize object identifiers against the current user/session.
- Avoid returning secrets and sensitive absolute paths.

## Remote API access

Bundled application code can use allowed APIs by default. Remote origins cannot unless a capability
includes `remote.urls`:

```json
{
    "$schema": "../gen/schemas/remote-schema.json",
    "identifier": "remote-content",
    "windows": ["main"],
    "remote": {"urls": ["https://app.example.com"]},
    "permissions": ["example:allow-read"]
}
```

Remote access expands the impact of a compromised server and should receive a separate threat
review. Never copy a local capability wholesale into a remote capability.

## Validation checklist

- Confirm each permission exists in `src-tauri/gen/schemas/` for the installed versions.
- Confirm each capability targets the intended window/webview and platform.
- Confirm capability identifiers are included by `app.security.capabilities` when the project
  explicitly enumerates them.
- Confirm scopes allow only required paths, URLs, commands, and arguments.
- Confirm application commands enforce their own authorization and input validation.
- Confirm remote content receives fewer permissions than bundled content.
- Run the Tauri CLI/build so schema and ACL errors fail validation.

Verified against official Tauri v2 documentation on 2026-08-01.
