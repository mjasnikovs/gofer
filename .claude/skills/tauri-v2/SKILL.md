---
name: tauri-v2
description: Tauri v2 desktop and mobile development with a Rust backend. Use when configuring
    tauri.conf.json, implementing or securing #[tauri::command] IPC, events and channels, state, capabilities and plugin permissions, sidecars, updater artifacts, signing, deployment, or troubleshooting src-tauri projects. Verify version-sensitive details against the installed schemas and current official Tauri v2 documentation.
---

# Tauri v2 development

Treat generated schemas and current official documentation as authoritative. Tauri and its plugins
evolve independently; do not infer a permission identifier, configuration key, platform capability,
or package API from memory.

## Required workflow

1. Inspect the project before proposing changes:
    - Run the project's package-manager equivalent of `tauri info`.
    - Read `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`,
      `src-tauri/build.rs`, and relevant capability files.
    - Inspect `src-tauri/gen/schemas/` for configuration and permission identifiers generated for
      the installed versions.
2. Use the package manager already used by the project. Do not silently mix npm, pnpm, yarn, Bun, or
   Deno.
3. Verify version-sensitive guidance against the specific official page linked in the references.
   Prefer the installed schema when it differs from generic documentation.
4. Grant the minimum permission and scope required. Do not add a broad default permission set merely
   to make an error disappear.
5. Validate after changes:
    - Run the frontend typecheck/tests and Rust formatting/checks used by the project.
    - Run the project's Tauri build or the narrowest platform build that exercises the change.
    - Validate capability and configuration files through the generated schemas or the Tauri CLI.

## Project frame

Keep the desktop entry point thin and place the shared builder in `lib.rs`, which supports mobile
entry points:

```rust
// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_lib::run();
}
```

```rust
// src-tauri/src/lib.rs
#[tauri::command]
fn greet(name: String) -> String {
    format!("Hello, {name}!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Commands defined directly in `lib.rs` must not be `pub`. Commands in a separate module must be `pub`
and registered with their module path. Command names must be unique.

Call commands from the frontend with camel-case argument keys by default:

```ts
import {invoke} from '@tauri-apps/api/core'

const greeting = await invoke<string>('greet', {name: 'World'})
```

Use `#[tauri::command(rename_all = "snake_case")]` only when the frontend intentionally sends
snake-case argument keys.

## Security boundaries

- Capabilities control exposure of Tauri core commands and plugin commands to selected windows,
  webviews, platforms, and optional remote origins.
- Registered application commands are available to local application windows and webviews by
  default. Restrict them explicitly with `tauri_build::AppManifest` when needed.
- Capabilities do not make custom Rust command bodies safe. Validate all paths, URLs, identifiers,
  and payload sizes inside privileged commands.
- Remote URL capability access is opt-in and expands the trust boundary. Avoid it unless required.
- Scope filesystem operations to the narrowest base directory and path glob.
- Scope HTTP access to required HTTPS origins and add explicit denies where useful.
- Never use `args: true` for shell commands or sidecars unless arbitrary arguments are an
  intentional, reviewed requirement. Prefer static arguments and anchored validators.
- Keep updater private keys out of the repository. Put signing secrets in the CI secret store.

Read [capabilities-reference.md](references/capabilities-reference.md) before changing permissions
or exposing remote content.

## IPC selection

- Use commands for request-response work.
- Use events for fire-and-forget notifications and broadcasts. Events are not designed for
  high-throughput streaming.
- Use channels for ordered, high-throughput Rust-to-frontend streaming tied to a command invocation.
- Use owned parameters in async commands unless following an official documented workaround.
- Return serializable errors. Use structured error codes for UI decisions; do not expose secrets or
  internal paths in error strings.
- Do not hold `std::sync::Mutex` guards across `.await`. Prefer a suitable async mutex for state
  that must remain locked across asynchronous work.

Read [ipc-patterns.md](references/ipc-patterns.md) for verified patterns.

## Plugins and advanced features

Install plugins with the project package manager and the Tauri CLI flow documented for that plugin.
`cargo tauri add <plugin>` may add its default permission automatically, but always inspect the
resulting diff and generated permission schema.

- Plugin selection, official pages, and permission workflow:
  [plugin-reference.md](references/plugin-reference.md)
- Updater artifacts, keys, endpoints, and distribution:
  [updater-distribution-reference.md](references/updater-distribution-reference.md)
- Tray, sidecars, deep links, and asset protocol:
  [advanced-runtime-reference.md](references/advanced-runtime-reference.md)

## Troubleshooting order

1. Run the project's Tauri info command and record exact core, CLI, API, and plugin versions.
2. Read the first Rust, frontend, or schema error rather than treating later cascading errors as
   root causes.
3. For `command not found`, confirm the command name, module visibility, and `generate_handler!`
   registration.
4. For permission failures, inspect the targeted window/webview, generated permission identifiers,
   scopes, and capability inclusion.
5. For a blank window, confirm `devUrl`, `frontendDist`, build commands, CSP, and frontend console
   errors.
6. For mobile failures, use the official Android or iOS prerequisites and generated mobile project
   rather than manually guessing Rust targets or platform manifest changes.
7. For updater failures, verify the artifact format, signature, public key, target/architecture
   keys, HTTPS endpoint response, and installed plugin version.

## Official sources

- [Tauri v2 documentation](https://v2.tauri.app/)
- [Configuration reference](https://v2.tauri.app/reference/config/)
- [Calling Rust from the frontend](https://v2.tauri.app/develop/calling-rust/)
- [Calling the frontend from Rust](https://v2.tauri.app/develop/calling-frontend/)
- [Capabilities](https://v2.tauri.app/security/capabilities/)
- [Permissions](https://v2.tauri.app/security/permissions/)
- [Tauri releases](https://github.com/tauri-apps/tauri/releases)

Verified against the official Tauri v2 documentation on 2026-08-01. Revalidate version-sensitive
details at the time of use.
