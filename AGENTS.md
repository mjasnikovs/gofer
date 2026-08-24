# AGENTS

Project-specific guidance for AI coding agents.

<!-- ASTRYX:START -->

Astryx v0.4.7 · 158 components CLI: run every command as `npx astryx <cmd>` (shown below as
`astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled: import
"@astryxdesign/core/reset.css"; import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:

1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s).
   No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their
   layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:

- No <div> — components do all layout/spacing, page frame included.
- Frame first: read `astryx docs layout` before writing any page or screen — page frame, region
  widths, breakpoint behavior.
- Dense data = rows (Table, List/Item), never Card-wrapped list items; Card is for standalone
  widgets. Status = StatusDot/Token; Badge = counts only.
- Custom styling: component props first; else style/className with tokens —
  var(--color-_|--spacing-_|--radius-*). No raw hex/px. (No StyleX/Tailwind compiler here — don't
  use xstyle/utility classes.)
- Tokens for every value (`astryx docs tokens`). Brand/accent belongs in the theme
  (`astryx theme list` / `theme add <slug>`, or `astryx theme template` for a custom one) — never
  override --color-* in :root.
- SELF-CHECK before you finish: re-read the file and replace any raw <div>/<span> layout, imported
  .css/@apply, or hardcoded value (#hex, 16px) with the component or a token
  (var(--color-_|--spacing-_|…)). If unsure a component/prop exists, run `astryx component <Name>` /
  `astryx search "<thing>"`; don't hand-roll CSS.

MORE CLI: search "<query>" find any component / hook / doc / template / block component --list 158
components by category template --list page + block recipes docs <topic> browser-support,
cli-integrations, color, elevation, getting-started, icons, illustrations, internationalization,
layout, migration, motion, principles, shape, spacing, styling-libraries, styling, theme, tokens,
typography, working-with-ai swizzle <Name> eject component source for deep customization upgrade
--apply run after any @astryxdesign/core bump
<!-- ASTRYX:END -->

## UI changes

Read `.claude/skills/gofer-ui/SKILL.md` before writing or changing anything under `src/components`
or `src/theme`. The Astryx block above covers imports, tokens, and props; the skill covers the part
that decides whether a screen is readable — surface layering, one primary action per screen,
placeholder discipline — and it is gated by `npm run check:design`.

## Validation

Use npm for package scripts. Run the full validation suite with:

```
npm run check
```

One gate is deliberately outside it. `npm run test:godot:api` holds what the AI tool catalog tells
the model about the _engine_ — the key names it advertises, which come out of Godot's own keycode
table — to a real editor. Nothing it covers can break because of a commit, so it does not run on
every change. Run it when the pinned version in `protocol/godot-artifacts.json` moves; a failure
there is the engine having renamed something, and the fix is the sentence in `CATALOG`.

## Asking a real model what it gets wrong

`src-tauri/src/godot_live_agent.rs` puts one real turn — the real worker, the real router, one real
editor — to whatever endpoint you point it at, and writes down every event it streamed. It asserts
nothing, because a local LLM cannot be a fixture, and it does nothing at all unless
`GOFER_LIVE_TASK` names an ask, so it costs the gate nothing.

It is the cheap half of the question: no release build, no window, about a minute a turn. The
expensive half is `wdio.live.conf.ts`, which drives the whole application by clicking it.

```
GOFER_LIVE_TASK="…" GOFER_LIVE_OUT=/tmp/turn.json \
  cargo test --manifest-path src-tauri/Cargo.toml --features godot-acceptance --lib \
  -- live_agent_acceptance --test-threads=1 --nocapture
```

Read it by counting: a wrong parameter shape that repeats inside one turn is a defect in Gofer, and
one that happens once is the model. That distinction found five of them. `dump_catalog_and_prompt`
in the same file writes the catalog and prompt the worker receives, which is what a prompt A/B
outside Rust has to be measured against.

`wdio.live.conf.ts` needs `tauri-driver` on PATH — `cargo install tauri-driver`, no root — and says
so by name when it is missing. It also runs `which WebKitWebDriver` and warns when there is none;
that warning is not a blocker, and a full sweep has run on a machine that has no such binary
anywhere on it.

## Generated command surfaces

Some command surfaces are emitted, not typed. Never hand-edit anything between a `GENERATED-BEGIN`
and a `GENERATED-END` marker — `npm run check` rejects it.

Change a source, then run:

```
npm run generate
```

The sources are `protocol/schemas/v2/request.schema.json` (which commands mutate the edited scene),
`protocol/schemas/v2/commands.json` (every command and the addon method answering it, plus the
`runtime.*` commands the addon routes to the running game), and the `generate_handler!` list in
`src-tauri/src/lib.rs` (which desktop commands exist). A new Godot command means a new catalogue
entry and a new addon method. A new desktop command means registering it in `lib.rs` and adding its
types to `src/services/desktop.ts` by hand.

The renderer spells a Godot command with `GodotCommandName`, emitted into
`src/models/godot-commands.ts`. Give a command a real params or result type by adding one entry to
`KnownGodotCommands` in that file; leave it out and it keeps the generic dictionary shape. See
`docs/adr/0002-command-names-are-generated-shapes-are-not.md`.

## Commands fail in one shape

Every `#[tauri::command]` rejects with a coded failure — `CommandError`, or the domain error of the
subsystem it belongs to. Never `Result<_, String>`: `npm run check` refuses it, because a sentence
tells the renderer nothing it can branch on. A helper deep inside may still return a sentence; the
command that owns the boundary chooses the code.

## Agent tools

Every tool the model is told about is invoked once before a turn starts, and a tool that cannot
answer stops the turn by name. A new tool needs a probe: a domain added to `CATALOG` in
`src-tauri/src/ai_tools.rs` must be answered by `probe()` in the same file, and a new local tool
needs a step in `WORKSPACE_PROBES` in `scripts/ai-reachability.mjs`. A domain with no probe fails
loudly rather than being assumed reachable.

## Waiting

Never sleep. Never use a fixed timeout to wait for something when an event, a condition, or a
retrying assertion is available — that is always, in every tool this repo uses.

- Playwright: `await expect(locator).toBeVisible()`, `locator.waitFor()`,
  `page.waitForFunction(...)`. Never `page.waitForTimeout(...)`.
- Testing Library / vitest: `findBy*`, `await waitFor(...)`. Never a `setTimeout` sleep.
- WebdriverIO: `browser.waitUntil(...)`, `element.waitForDisplayed()`. Never `browser.pause(...)`.
- Rust and Node: wait on the event, the channel, or the process the work actually signals through.
  Poll a condition only when nothing signals, and then poll fast with a deadline — a sleep long
  enough to "be safe" is both slower and flakier than the condition it is guessing at.

This applies to throwaway probes and one-off scripts exactly as much as to committed tests. A
guessed delay is either wasted seconds or a flake, usually both.

## Git workflow

- Work directly on `master` only.
- Never create, switch to, push, or merge another branch.
- Never create or use a pull request.
- When asked to commit and push, commit directly to `master` and push to `origin/master`.
- If `origin/master` rejects a direct push, report the rejection and stop. Do not work around it
  with a branch, pull request, or any other workflow.

## Code style

- One-line `if`: write single-statement conditionals on one line, no braces.
  `if (!user) return null`
- Prettier owns formatting: 4-space indent, no semicolons, single quotes, print width 120, no
  bracket spacing. Do not fight it — run the formatter.

## TypeScript types

- Do not inline object types. If a type is an object with more than 2 properties, declare a named
  `type` and use it.
- Reuse before you create. Search the codebase for an existing type first; if one fits, import it.
  Only create a new type when none exists.
- Do not hand-write types for libraries. Check whether the library ships its own types (`@types/*`
  or bundled) and import those. Author a type only when the library exports none.
