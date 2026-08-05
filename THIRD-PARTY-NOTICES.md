# Third-party notices

Gofer bundles, adapts, or ships alongside the work below. Runtime dependencies resolved by npm and
Cargo carry their own licence metadata in `package-lock.json` and `src-tauri/Cargo.lock`; this file
records the work that reaches a user's machine through Gofer's own files rather than through a
package manager, plus the sources Gofer's protocol implementation was written against.

## godot-ai — selectively adapted

- Project: https://github.com/hi-godot/godot-ai
- Licence: MIT
- Used as: architecture reference, adapted in `src-tauri/addon/plugin.gd` and
  `src-tauri/addon/runtime.gd`

Gofer's editor addon is its own implementation. Three patterns are adapted from godot-ai's plugin
architecture and its runtime helper, and each adaptation is attributed where it appears in the addon
source:

- executing editor API calls from the plugin's `_process()` so every mutation runs on Godot's main
  thread;
- decoding debugger capture messages tolerantly, because the engine strips the capture prefix before
  invoking the callable;
- keeping one editor debugger session across play/stop cycles and polling the play state as the
  teardown fallback for a game that dies without a stopped signal.

```
MIT License

Copyright (c) godot-ai contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Godot Engine — protocol references

- Engine: https://github.com/godotengine/godot — MIT
- Documentation: https://docs.godotengine.org — CC BY 4.0, engine class reference derived from the
  MIT-licensed source

Gofer talks to an unmodified Godot 4.7.1-stable editor it does not redistribute. The transports it
implements were written against Godot's own documentation and source:

- the editor command-line options `--editor`, `--path`, `--lsp-port`, and `--dap-port`
  (https://docs.godotengine.org/en/latest/tutorials/editor/command_line_tutorial.html);
- the GDScript language server
  (https://docs.godotengine.org/en/4.7/classes/class_gdscriptlanguageprotocol.html), whose behaviour
  under `use_thread` and `poll_limit_usec` sets this client's timeouts;
- the debug adapter Godot implements, including the places where it defers a response, answers
  `breakpointLocations` under a `breakpoints` key, and provides no `stepOut` handler.

The `@mjasnikovs/gofer-rag` retrieval index shipped with Gofer is built from that CC BY 4.0
documentation; passages it returns are cited by chapter.

## Monaco Editor

- Project: https://github.com/microsoft/monaco-editor
- Licence: MIT
- Used as: the script editor, bundled into the renderer from the `monaco-editor` package

Gofer registers its own GDScript language, configuration, and Monarch grammar; Monaco itself is
unmodified.

## gdformat (gdtoolkit)

- Project: https://github.com/Scony/godot-gdscript-toolkit
- Licence: MIT
- Used as: a standalone `gdformat` executable, frozen per platform in CI and shipped as a bundled
  resource

The formatter is invoked as a separate process reading GDScript on standard input; Gofer requires
exactly gdtoolkit 4.5.0 and reports `formatter_unavailable` rather than formatting with any other
version. No gdtoolkit source is compiled into Gofer.

`scripts/build-gdformat.mjs` is that build. It freezes the pins in `protocol/gdformat-sidecar.json`
into `src-tauri/sidecar/`, which `tauri.conf.json` bundles as an application resource, and writes
two files beside the executable: its SHA-256, and `LICENSES.md` carrying the licence of every
package inside it. The frozen binary contains gdtoolkit, its runtime dependencies — colorama,
docopt-ng, lark, mando, PyYAML, radon, regex, six — and a CPython interpreter under the Python
Software Foundation License Version 2 (https://docs.python.org/3/license.html). PyInstaller, pip,
and setuptools produce the executable and are not inside it.

## Astryx, Pi, and other package-manager dependencies

Everything else Gofer depends on is installed by npm or Cargo and is listed, with its resolved
version, in `package-lock.json` and `src-tauri/Cargo.lock`. Their licences travel with those
packages.
