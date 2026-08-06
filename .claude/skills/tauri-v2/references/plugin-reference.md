# Official Tauri v2 plugins

## Workflow

1. Open the plugin's current official page.
2. Confirm supported platforms and minimum Rust version.
3. Install using the project's package manager and documented Tauri CLI command.
4. Inspect changes to `Cargo.toml`, the frontend manifest, `lib.rs`, and capabilities.
5. Read the generated permission schema. Grant only required operations and scopes.
6. Run the project's Tauri build/check on each targeted platform.

`cargo tauri add <plugin>` can automatically add the plugin's default permission. Do not assume the
default grants the operation or resource scope you need, and do not duplicate it with broad
individual permissions without inspecting its definition.

## Current official pages

| Feature            | Plugin                           | Frontend package                       | Official documentation                                          |
| ------------------ | -------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| Clipboard          | `tauri-plugin-clipboard-manager` | `@tauri-apps/plugin-clipboard-manager` | [Clipboard](https://v2.tauri.app/plugin/clipboard/)             |
| Deep links         | `tauri-plugin-deep-link`         | `@tauri-apps/plugin-deep-link`         | [Deep Linking](https://v2.tauri.app/plugin/deep-linking/)       |
| Dialogs            | `tauri-plugin-dialog`            | `@tauri-apps/plugin-dialog`            | [Dialog](https://v2.tauri.app/plugin/dialog/)                   |
| Filesystem         | `tauri-plugin-fs`                | `@tauri-apps/plugin-fs`                | [File System](https://v2.tauri.app/plugin/file-system/)         |
| Global shortcuts   | `tauri-plugin-global-shortcut`   | `@tauri-apps/plugin-global-shortcut`   | [Global Shortcut](https://v2.tauri.app/plugin/global-shortcut/) |
| HTTP client        | `tauri-plugin-http`              | `@tauri-apps/plugin-http`              | [HTTP Client](https://v2.tauri.app/plugin/http-client/)         |
| Notifications      | `tauri-plugin-notification`      | `@tauri-apps/plugin-notification`      | [Notifications](https://v2.tauri.app/plugin/notification/)      |
| Open URL/path      | `tauri-plugin-opener`            | `@tauri-apps/plugin-opener`            | [Opener](https://v2.tauri.app/plugin/opener/)                   |
| Process lifecycle  | `tauri-plugin-process`           | `@tauri-apps/plugin-process`           | [Process](https://v2.tauri.app/plugin/process/)                 |
| Shell and sidecars | `tauri-plugin-shell`             | `@tauri-apps/plugin-shell`             | [Shell](https://v2.tauri.app/plugin/shell/)                     |
| Store              | `tauri-plugin-store`             | `@tauri-apps/plugin-store`             | [Store](https://v2.tauri.app/plugin/store/)                     |
| Updater            | `tauri-plugin-updater`           | `@tauri-apps/plugin-updater`           | [Updater](https://v2.tauri.app/plugin/updater/)                 |

Use the [official plugin directory](https://v2.tauri.app/plugin/) for plugins not listed here.

## Permission rules

- Read permission identifiers from `src-tauri/gen/schemas/` or the current permission table. Plugin
  releases can add, deprecate, or regroup them.
- A `default` permission is a named set, not “everything.” For example, the shell default currently
  grants URL opening with a predefined scope; it does not grant process execution.
- Resource scopes remain necessary even when a command permission is enabled. The HTTP default
  enables fetch operations but allows no origins until configured.
- Dialog-selected paths do not automatically authorize arbitrary filesystem operations in every
  design. Confirm the filesystem plugin's runtime and persisted-scope behavior for the installed
  version.
- Clipboard reads, shell execution, filesystem writes, process restart/exit, global shortcuts, and
  updater installation deserve explicit product and threat-model review.
- Prefer the opener plugin for opening URLs or paths when process execution is not required.

## Version discipline

Do not put `@latest` into a reproducible project without reviewing the resolved version and lockfile
diff. Keep the Rust plugin crate and frontend plugin package on compatible v2 releases, then
validate with the Tauri info command.

When exact API timing matters, consult the plugin's linked changelog from its official page or the
[plugins-workspace v2 branch](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins).

Verified against official Tauri v2 plugin pages on 2026-08-01.
