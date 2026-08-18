# Bundled sidecars

`tauri.conf.json` bundles this directory as an application resource, so everything here reaches a
user's machine and `PathResolver::resource_dir()/sidecar` is where `src-tauri/src/gdformat.rs`
looks. Tauri's build script copies it beside the executable for unbundled builds too, which is why
the packaged WebDriver journey can prove the shipped resolution path rather than an env override.

Only `README.md` is tracked. The rest is built:

| File               | What it is                                                |
| ------------------ | --------------------------------------------------------- |
| `gdformat[.exe]`   | The frozen gdtoolkit 4.5.0 formatter                      |
| `gdformat*.sha256` | That executable's checksum, recorded at build time        |
| `LICENSES.md`      | The licence of every package inside the frozen executable |

All three come from `npm run build:gdformat`. The checksum identifies the artifact a build produced
— PyInstaller embeds build paths and timestamps, so two builds of the same pins do not share a
digest — which is what lets a shipped binary be traced back to the run that made it.

The formatter is the one feature allowed to ship disabled: with no executable here and no
`GOFER_GDFORMAT` override, `gdformat::resolve` reports `formatter_unavailable` and Gofer runs
without formatting rather than formatting with an unpinned gdtoolkit. `fixtures/gdformat/README.md`
records the pin and the proof the build runs against the artifact.
