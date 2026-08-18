---
name: gofer-ui
description: Required before writing or changing any Gofer UI — components under src/components, anything in src/theme, any Astryx component, any panel/tab/button/input/empty-state layout. Use when adding a view, restyling one, picking a Button variant, choosing a colour or surface, adding a placeholder, or reviewing a screenshot of the app. Triggers: "add a panel", "new tab", "style this", "it looks flat", "hierarchy", "contrast", "placeholder", "which variant", Astryx, theme tokens, gofer-theme.css.
---

# Gofer UI

Astryx ships the design guidance. Read it — do not reason about visual design from memory.

## Before writing any UI

Run these and read the output. They are cheap, they are versioned with the installed package, and
they are the source of truth over anything you remember about design systems:

```bash
npm run astryx -- docs color        # surface ramp body → surface → card → popover, text roles
npm run astryx -- docs elevation    # when a surface is none / low / med / high
npm run astryx -- docs layout       # frame first: pick the shell, budget regions in px
npm run astryx -- docs principles   # the anti-pattern list
npm run astryx -- component <Name>  # props and examples, for every component you touch
```

`AGENTS.md` carries the mechanical half of this (import paths, tokens not hex, no raw `<div>`). This
skill carries the half that decides whether the screen is readable.

## The four failures this repo actually shipped

Every rule below is here because it was measured on a real Gofer screenshot, not because it is good
practice in general.

**One surface everywhere.** 89.5% of the window measured as a single grey: the header, all three
panels, and a text input's own fill were all `#262626`. A panel is not a background — give the frame
`--color-background-body` and the panels that sit on it `--color-background-surface`. If a region
floats (popover, dialog, dropdown) it takes an elevation level, and exactly one. Read
`docs elevation` for which.

**Placeholder that reads as a typed value.** The placeholder, the field's own label, an inactive
tab, and a static caption all measured `#D2D2D2` — four roles, one colour. Placeholders are a weaker
role than supporting text and must look it. Prefer not having one at all: Astryx `TextInput` takes a
`label`, and per NN/g's form research a hint inside the box disappears the moment the user types,
which is when they need it. Use a placeholder only for format examples, never to name the field.

**No primary action.** `Run project`, `Start session`, and `Merge task` all rendered as the same
grey rectangle, so nothing told the user which one the screen was for. Every screen with more than
one button names exactly one `variant="primary"`; the rest are `secondary` or `ghost`. `variant`
defaults to `secondary`, so leaving it off is a choice not to have a primary action — make that
deliberate.

**Selected state carried by one thin line.** The only difference between the active tab and its
neighbours was a 2px underline plus `#F7F7F7` vs `#D2D2D2` text. That is the component's job, not
yours — use `TabList` and let it draw the state; if the state still does not read, the theme's text
ramp is collapsed, which is a token fix, not a per-screen fix.

## Theme changes

Never hand-edit `src/theme/gofer-theme.css` — it is generated. Edit `src/theme/theme.ts` and
rebuild:

```bash
npm run astryx -- theme build src/theme/theme.ts --out src/theme/gofer-theme.css
```

Overriding a token in `theme.ts` moves it for the whole app. `--color-text-disabled` was overridden
from the neutral theme's `#525252` to `#d4d4d4` to make disabled text more readable, and that single
line is what made every placeholder in Gofer look like typed text. Before overriding a colour, check
what else uses it (`npm run astryx -- docs color`) and re-run the gate below.

Gofer extends `@astryxdesign/theme-neutral`, whose accent is `#ebebeb` in dark — deliberately
colourless. Astryx's own default accent is `#0064E0`. So in this repo emphasis has to come from
surface, weight, and size, because it cannot come from hue. Plan for that instead of fighting it.

## The gate

```bash
npm run check:design
```

This measures the built theme for collapsed distinctions: text roles less than 12 L* apart, each
step of the surface ramp less than 3 L* _above_ the one below it, an accent no brighter than body
text, and control borders under WCAG 1.4.11's 3:1. It runs inside `npm run check`.

It is a ratchet, not a bar. `scripts/design-baseline.json` lists the violations the theme is allowed
to keep; anything new fails, and fixing one means deleting its line in the same commit. The list is
empty today, which is the state to keep it in. Never add a line to that file — read the count out of
the file rather than from this sentence.

## Checking a screen by measurement, not by eye

A screenshot answers "is this flat" in one command. Anything above roughly 70% in a single colour is
a screen with no hierarchy left:

```bash
magick shot.png -format %c -depth 8 histogram:info: | sort -rn | head -5
```

To compare two roles that should differ — a placeholder against a real value, an active tab against
an inactive one — crop each and read its brightest pixel, which is the text colour with the
antialiasing stripped off:

```bash
magick shot.png -crop 240x20+294+205 +repage -depth 8 txt: | tail -n +2 | sort -t'(' -k2 -rn | head -1
```

Two roles landing on the same value is the bug, regardless of whether either passes contrast on its
own.
