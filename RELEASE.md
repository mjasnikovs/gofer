# Releasing Gofer

A release is one tag. `.github/workflows/release.yml` turns it into a GitHub release carrying an
installer for Linux, macOS and Windows.

Gofer is not signed. On macOS Gatekeeper blocks the app on first open and the user has to
right-click it and choose Open. On Windows SmartScreen warns and the user has to choose More info,
then Run anyway. Both are stated in the release notes below, because a download that looks broken is
worse than one that says why.

## Before the tag

Three gates, in order. Every one of them is a gate because it has caught something.

**1. `npm run check` is green on your machine.** It stubs the backend, so it is the cheapest gate
and the weakest.

**2. The nightly matrix is green.** All three of `ubuntu-24.04`, `windows-2025` and `macos-15`.

```bash
gh run list --workflow=nightly.yml --limit 1
```

A red platform is a platform whose installer nobody has proved runs. Fix it or drop it from the
matrix on purpose — do not tag past it.

**3. The live sweep passed, on your machine.**

```bash
npm run test:live:build
npm run test:live:reset
```

Nothing schedules this and nothing can: no runner has a display, a Godot install and a model server
at once. It is the maintainer's gate. `check` stubs the backend, and the backend is where the class
of bug this suite exists to catch has always lived.

## Tagging

Move the version in all three files that carry it, then commit and tag.

```bash
npm run set-version -- 0.2.0
npm run check:version
cargo check --manifest-path src-tauri/Cargo.toml   # writes the new version into Cargo.lock
git commit -a -m "Release 0.2.0"
git tag v0.2.0
git push origin master v0.2.0
```

The tag push is what starts the workflow. It drafts a release, builds three platforms into it, and
publishes only when all three have uploaded. A failed platform leaves a draft, which is a release
nobody can download rather than a release missing an installer.

To rebuild a tag that already exists, run the workflow by hand and give it the tag:

```bash
gh workflow run release.yml -f tag=v0.2.0
```

## What is built where

Neither of these can be cross-built, which is why the workflow is a matrix and not one Linux job.

| Artifact             | Built by                     | Needs                    |
| -------------------- | ---------------------------- | ------------------------ |
| The gdformat sidecar | `npm run build:gdformat`     | Python 3 and PyInstaller |
| The Node runtime     | `npm run build:node-runtime` | The pin, and network     |
| The installers       | `npm run build:release`      | Both of the above first  |

The Tauri build is what copies `src-tauri/sidecar`, `src-tauri/runtime` and `src-tauri/workers` into
the bundle, so all three have to be filled before it runs.

Targets come from the per-platform overlays beside `tauri.conf.json`, which Tauri merges by itself:

| File                      | Targets      |
| ------------------------- | ------------ |
| `tauri.linux.conf.json`   | `deb`, `rpm` |
| `tauri.macos.conf.json`   | `app`, `dmg` |
| `tauri.windows.conf.json` | `nsis`       |

There is no AppImage, and it is left out on purpose rather than forgotten. Tauri builds one through
`linuxdeploy`, which strips every library it bundles with its own copy of binutils — and that copy
cannot read the `.relr.dyn` section modern glibc emits, so the bundle fails on a current Arch host.
The runner may well manage it; nobody has watched it try. Add `"appimage"` to the Linux targets once
a run has produced one. The release workflow already uploads `*.AppImage` if it finds any.

## What the release notes have to say

Every one of these is a thing a user meets on first run and cannot work out alone.

- **macOS is unsigned.** Right-click the app, choose Open, confirm once.
- **Windows is unsigned.** SmartScreen warns. Choose More info, then Run anyway.
- **Godot 4.7.2-stable has to be installed.** Gofer does not redistribute it and refuses any other
  build by version. The health check finds it or offers a picker.
- **Node is bundled.** Nothing to install.
- **Game-window embedding is Linux-and-Wayland only.** The setting is honoured nowhere else.
- **Linux needs a secret service** — gnome-keyring or KWallet — to store the AI key. Without one
  Gofer reports "Could not access the operating system credential store".
