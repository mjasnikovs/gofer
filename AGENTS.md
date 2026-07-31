# AGENTS

Project-specific guidance for AI coding agents.

<!-- ASTRYX:START -->

Astryx v0.2.0 · 154 components CLI: run every command as `npx astryx <cmd>` (shown below as
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

- No <div> — components do all layout/spacing. Full page → AppShell; sidebar nav → SideNav.
- Frame first: pick the shell (AppShell / Layout+LayoutPanel) and budget regions in px BEFORE
  writing content (`astryx docs layout`).
- Dense data = rows (Table, List/Item) edge-to-edge — never Card-wrapped list items. Card =
  dashboard widgets, galleries, settings groups only.
- Status → StatusDot/Token; Badge only for counts and enumerated states, never decoration.
- Custom styling: component props first; else style/className with tokens —
  var(--color-_|--spacing-_|--radius-*). No raw hex/px. (No StyleX/Tailwind compiler here — don't
  use xstyle/utility classes.)
- Tokens for every value (`astryx docs tokens`). Brand/accent via `astryx theme` — never override
  --color-* in :root.
- SELF-CHECK before you finish: re-read the file and replace any raw <div>/<span> layout, imported
  .css/@apply, or hardcoded value (#hex, 16px) with the component or a token
  (var(--color-_|--spacing-_|…)). If unsure a component/prop exists, run `astryx component <Name>` /
  `astryx search "<thing>"`; don't hand-roll CSS.

MORE CLI: search "<query>" find any component / hook / doc / template / block component --list 154
components by category template --list page + block recipes docs <topic> color, elevation, icons,
illustrations, internationalization, layout, migration, motion, principles, shape, spacing, styling,
theme, tokens, typography swizzle <Name> eject component source for deep customization upgrade
--apply run after any @astryxdesign/core bump
<!-- ASTRYX:END -->

## Validation

Use npm for package scripts. Run the full validation suite with:

```
npm run check
```

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
