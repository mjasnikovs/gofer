# Tauri v2 advanced runtime features

## Contents

- System tray
- Sidecars
- Deep links
- Asset protocol

## System tray

Use `tauri::tray::TrayIconBuilder`; do not use Tauri v1 `SystemTray` examples. Follow the current
[system tray guide](https://v2.tauri.app/learn/system-tray/) and check platform limitations.

Build the tray during setup and retain it when platform/runtime behavior requires ownership. Use
`tauri::Manager` to retrieve a webview window by label. Treat tray menu events as application events
and handle errors instead of unwrapping lifecycle-sensitive operations.

Desktop environment support differs, especially on Linux. Verify packaging dependencies for each
target rather than assuming tray support from a development machine.

## Sidecars

Follow the [external binary guide](https://v2.tauri.app/develop/sidecar/) and
[shell plugin page](https://v2.tauri.app/plugin/shell/).

Declare the base binary path relative to `src-tauri/tauri.conf.json`:

```json
{
    "bundle": {
        "externalBin": ["binaries/my-sidecar"]
    }
}
```

Provide one binary per target using the required `-$TARGET_TRIPLE` suffix. Obtain the exact target
triple from the documented Rust command and CI target; do not infer it from the OS name.

Rust calls `app.shell().sidecar("my-sidecar")` with the filename, not the configured path.
JavaScript `Command.sidecar(...)` uses the string documented for the `externalBin` entry. These
forms differ; follow the official example for the calling language.

Use `shell:allow-execute` for `.execute()` or `shell:allow-spawn` for `.spawn()`. Scope the declared
sidecar and arguments:

```json
{
    "permissions": [
        {
            "identifier": "shell:allow-execute",
            "allow": [
                {
                    "name": "binaries/my-sidecar",
                    "sidecar": true,
                    "args": ["--format", {"validator": "^(json|text)$"}]
                }
            ]
        }
    ]
}
```

Do not use `args: true` unless arbitrary arguments are explicitly required and threat-reviewed.
Sidecars are native executables: verify provenance, pin their build, hash/sign artifacts, avoid
shell interpolation, and validate all frontend-controlled values.

## Deep links

Use the [deep-link plugin guide](https://v2.tauri.app/plugin/deep-linking/). Configuration and
registration differ across desktop and mobile platforms and can change independently of the core
Tauri release.

- Verify the installed plugin's configuration schema before editing `tauri.conf.json`.
- Treat every deep-link URL as untrusted input.
- Allowlist schemes, hosts, routes, and parameter formats.
- Never execute, open a local path, or perform an authenticated state change solely because a deep
  link requested it.
- Protect OAuth-style flows with a state/nonce and validate the callback origin and parameters.
- Test cold-start and already-running behavior on every target platform.

## Asset protocol

Use `convertFileSrc` only with an intentionally configured asset protocol scope. The current
configuration lives under `app.security.assetProtocol`, not the obsolete `assetScope` shorthand:

```json
{
    "app": {
        "security": {
            "assetProtocol": {
                "enable": true,
                "scope": ["$APPDATA/assets/**"]
            }
        }
    }
}
```

Confirm the exact schema and platform CSP requirements in the
[asset protocol scope documentation](https://v2.tauri.app/security/asset-protocol/). Expose only
directories containing intended web-consumable assets; never expose broad home, configuration,
credential, or webview-data directories.

For a truly custom URI scheme, use the current Rust API documentation and perform a separate origin,
CSP, path traversal, and content-type review. Do not copy Tauri v1 `invoke_filter` examples.

Verified against official Tauri v2 documentation on 2026-08-01.
