# Tauri v2 updater and distribution

## Contents

- Installation and registration
- Artifact and endpoint configuration
- Key handling
- Update responses
- Runtime checks
- Platform distribution

Use the current [official updater guide](https://v2.tauri.app/plugin/updater/) and the installed
configuration schema as authoritative.

## Installation and registration

Follow the updater page's package-manager-specific installation command. The Rust plugin uses:

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

Frontend updater calls require the permissions exposed by the installed plugin. Inspect the
generated schema rather than copying identifiers from an old example. Rust-side plugin use is not
governed by frontend capabilities in the same way.

## Artifact and endpoint configuration

Current Tauri v2 configuration uses `bundle.createUpdaterArtifacts` plus `plugins.updater.pubkey`
and `plugins.updater.endpoints`:

```json
{
    "bundle": {
        "createUpdaterArtifacts": true
    },
    "plugins": {
        "updater": {
            "pubkey": "CONTENT FROM PUBLICKEY.PEM",
            "endpoints": ["https://releases.example.com/{{target}}/{{arch}}/{{current_version}}"]
        }
    }
}
```

- `createUpdaterArtifacts: true` creates Tauri v2 updater artifacts.
- Use `"v1Compatible"` only while migrating users from a Tauri v1 updater format; the official
  documentation says this compatibility value will be removed in v3.
- `pubkey` is the public-key content, not a file path.
- Supported endpoint variables include `{{current_version}}`, `{{target}}`, and `{{arch}}`.
- Production endpoints enforce TLS. Do not enable `dangerousInsecureTransportProtocol` in
  production.
- Tauri proceeds to the next configured endpoint only when the previous response has a non-2xx
  status.

There are no `active` or built-in `dialog` fields in the current updater plugin configuration.
Implement user prompts in application UI and invoke the updater API after explicit product
decisions.

## Key handling

Generate the updater signing key with the command shown by the installed Tauri CLI, currently
documented as:

```bash
tauri signer generate -w ~/.tauri/myapp.key
```

Depending on how the CLI is installed, invoke it through the project's package manager or Cargo.
Confirm with `tauri signer --help` before automation.

- Commit only the public key.
- Store the private key and password in CI secrets.
- Set `TAURI_SIGNING_PRIVATE_KEY` to the private-key path or content during the build.
- Set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when applicable.
- Back up the private key securely. Losing it prevents publishing updates trusted by existing
  installations.
- Never rotate the updater key without a migration plan supported by the installed plugin version.

## Update responses

The updater accepts static or dynamic server responses. Do not hand-author platform keys or artifact
filenames from memory. Generate artifacts first, then match the response to the current official
response schema and actual build output.

Validate at least:

- Version is valid and newer according to the configured comparison behavior.
- Target and architecture match Tauri's current values.
- URL points to the updater artifact, not merely a convenient installer filename.
- Signature is the content of the corresponding `.sig` file.
- Endpoint returns the expected status for “no update.”
- MIME type, redirects, authentication, and CDN caching behave as intended.

## Runtime checks

The Rust API uses `tauri_plugin_updater::UpdaterExt`, calls `.updater()?.check().await?`, and then
downloads/installs the returned update. The frontend API supports `check()` and
`downloadAndInstall()`. Copy the current example from the official page for the language and plugin
version in use.

Do not install automatically without considering:

- Unsaved user work and graceful shutdown.
- Progress, cancellation, and retry UX.
- Release notes and explicit consent requirements.
- Platform restart behavior.
- Rollback and staged rollout strategy.

## Platform distribution

Updater signing does not replace platform code signing or store requirements.

- Follow [macOS code signing](https://v2.tauri.app/distribute/sign/macos/) and notarization
  guidance.
- Follow [Windows code signing](https://v2.tauri.app/distribute/sign/windows/) and installer
  guidance.
- Follow the target distribution guide for Linux package formats and repositories.
- Follow the Apple App Store/Google Play workflows for mobile applications; desktop updater
  assumptions do not automatically apply.

Build output varies by platform and `createUpdaterArtifacts` mode. Validate the actual artifacts in
`target/release/bundle/` rather than relying on a static filename list.

Verified against the official updater guide on 2026-08-01.
