# Mouse offset in Godot on Hyprland

## Symptom

The mouse does not line up with what Godot draws.

- Vertical only. Horizontal is correct.
- The error grows the further down the window you go.
- Hits editor buttons, editor popups, and the running game.

## Fix

Warp the cursor once. This re-syncs Hyprland's pointer state.

```
hyprctl dispatch 'hl.dsp.cursor.move({x=960,y=600})'
```

Note the Lua syntax. Hyprland 0.56 dropped the old `movecursor 960 600` form.

Killing every stray Godot process also cleared it once:

```
pkill -x godot
```

It is not known which of the two actually fixed it.

## Ruled out

**The display driver.** Godot 4.7.1 already runs X11 here. XWayland is enabled and `DISPLAY=:0`
works. `run/platforms/linuxbsd/prefer_wayland` is unset, so the default applies. Verified with a
script printing `DisplayServer.get_name()` — it returns `X11`. The offset appeared under both
drivers, so the driver is not the cause.

**The compositor's cursor rendering.** The cursor is drawn exactly where Hyprland says it is.
Verified by warping to a known Y, taking two `grim -c` captures at different positions, and diffing
them. Warp to y=150 drew rows 140–159. Warp to y=1050 drew rows 1040–1059.

**Hyprland window rules.** No rule in `~/.config/hypr/` targets Godot.

## Not proven

The offset could not be reproduced on demand. Synthetic cursor warps do not deliver pointer motion
to the client, so every measurement taken that way was a stale value. Reproducing it needs a real
hand on the mouse.

## Environment

- Hyprland 0.56.2, Lua config, Omarchy "quattro"
- Godot 4.7.1.stable
- Nvidia
- Three monitors, mixed heights, all scale 1: DP-7 1920x1200 at 0, DP-5 1920x1080 at 1920, DP-4
  1920x1200 at 3840

Mixed monitor heights are the most likely trigger. Untested.

## Probe

A crosshair probe lives in the session scratchpad. It draws a red line at Godot's idea of the mouse
Y. If the line does not sit under the pointer, the offset is back.

    scratchpad/crosshair.sh
