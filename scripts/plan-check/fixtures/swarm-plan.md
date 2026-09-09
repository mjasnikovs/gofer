GOAL

When a unit is placed on a solid tile it runs on its own: each frame it scans for the nearest live spider within its straight-line `attack_range`, and if found it waits until `attack_cooldown` seconds have passed since its last fire, then fires via the existing attack path — the 2-frame attack row, the attack sound, and a projectile (for projectile classes) or an immediate hitscan `take_damage` (for `projectile == null` classes) aimed at that spider. Spiders now carry `hp` and `take_damage`, so projectile classes' shells track the target, land `take_damage` on arrival (and, for `damage_kind == splash`, damage every spider within `splash_radius` of impact), and a spider whose hp reaches 0 stops, plays DEATH, `leave_flock()`s, and frees after a delay; units then re-acquire the next spider. On the UI side, right-clicking a placed unit selects it and draws its range ring, and a subsequent left-click re-snaps and moves it to another valid solid cell (reusing the `in_bounds` / `!is_open` / `_cell_occupied` gates, excluding the moving unit itself), while right-click elsewhere or Escape cancels; left-clicks while armed always spawn, so the two never share a gesture. Hovering the mouse over any placed unit (and the armed placement preview) draws a semi-transparent white ring of that unit's `attack_range` centered on it.

CONSTRAINTS

- Do not modify `docs/design.md`, `docs/spec-unit-combat.md`, `docs/audit-unit-combat.md`
- A unit attacks only a spider whose straight-line distance from the unit is <= the unit's `attack_range`; with no spider in range the unit takes no attack action.
- A unit's attack is gated by its per-class `attack_cooldown`: it cannot fire again until that many seconds have elapsed since its last fire.
- Firing reuses the existing attack path (`set_state`/`attack`), so the 2-frame attack row plays once and the attack sound fires rather than a bespoke animation.
- The attack's projectile (or hitscan target) is the in-range spider, not the fixed `Vector2(FRAME_SIZE * 0.5, 0.0)` forward spawn.
- For `damage_kind == splash`, the projectile on impact damages every spider within `splash_radius` of the impact point, not just the aimed target.
- For `projectile == null` classes (MachineGunner, RadioOperator), `take_damage` is applied to the in-range target immediately at the moment the attack fires (hitscan).
- Moving a placed unit re-snaps its position to `field.center_of(target_cell)` and refuses a move onto an `is_open` (flow) cell, an out-of-bounds cell, or a cell already occupied by another unit.
- The move is initiated by a distinct player gesture (right-click to select, left-click to move) that cannot be the same click used to spawn a new unit.
- On hover over any placed unit, a range circle of radius equal to that unit's `attack_range` is drawn centered on the unit, matching the placement-preview ring (white alpha 0.6, `OVERLAY_Z_INDEX` above FlowLayer).
- The armed placement preview's existing range circle continues to work unchanged and coexists with the placed-unit hover ring (two separate circle nodes).
- Spiders gain `hp` and `take_damage`; units remain indestructible (no hp / take_damage on units).
- A spider whose hp reaches 0 stops, plays its DEATH row, calls `leave_flock()`, and frees after a short delay (mirroring `on_arrived`).
- No new assets, tiles, or audio are introduced; visuals and sounds reuse existing resources.
- `SwarmDirector.field` must be read fresh, never cached (it is swapped in-place by `_finish_reroute`).

STEPS

1. Add `hp: float`, a `take_damage(amount: float) -> void` method, and a `die()` method to `scripts/enemy/enemy.gd` (base `Enemy`), and set `hp` in `scripts/enemy/spider.gd` `_ready`; `take_damage` decrements hp and, at 0, stops the spider, plays its DEATH row, calls `leave_flock()`, and frees after a delay — mirroring `on_arrived`'s pattern.
2. Add a `target: Enemy` member, a `_cooldown_timer: float`, and a per-frame targeting step to `scripts/units/units.gd`: each frame find the nearest live spider (from `get_tree().get_nodes_in_group(&"spider")` filtered by `is_instance_valid` and within `attack_range`), and if found and `_cooldown_timer <= 0`, call the existing attack path and reset `_cooldown_timer = attack_cooldown`; change `_spawn_projectile` (line ~169) so the shell is aimed at `target` instead of the fixed forward spawn, and for `projectile == null` (hitscan) apply `target.take_damage(damage)` directly on fire.
3. Extend `scripts/projectiles/spawned_projectile.gd` to accept a target (`target: Enemy`, plus `damage`, `damage_kind`, `splash_radius` via an extended `configure` or a new set call): fly toward `target` rather than fixed +X, and on reaching it (or lifetime expiry) call `target.take_damage(damage)`, and for `damage_kind == splash` damage every spider within `splash_radius` of the impact point.
4. Add the right-click-to-select / left-click-to-move relocation gesture to `scripts/ui/unit_placement_panel.gd`: on right-click over a placed unit, select it and enter relocation mode; on a subsequent left-click, re-snap via `field.center_of` and move it (reusing the same `in_bounds` / `!is_open` / `_cell_occupied` gates, excluding the moving unit), and cancel on right-click elsewhere or Escape; left-clicks while armed always spawn.
5. Add a second range-circle node for placed units to `scripts/ui/unit_placement_panel.gd` (distinct from the existing `_range_circle`): in `_update_placement_preview` (which already runs every frame), detect a placed unit under the cursor and draw a ring of that unit's `attack_range` around it, so it coexists with the armed preview ring.
6. If the select-to-move model needs a signal connection (e.g. to track the just-placed unit), add it to `scenes/main.tscn` on the UnitPlacementPanel node; otherwise the model is handled entirely inside the panel and no scene edit is made.

VERIFY

```sh
# Project imports and runs without errors (structural sanity)
godot --headless --audio-driver Dummy --import
godot --headless --audio-driver Dummy --fixed-fps 60 --quit-after 600
```
# A placed unit fires at a spider in range and the spider actually takes damage (assert the end of the chain: a soldier's shot lands on a spider)
godot_runtime {"ops": [{"op": "run", "scene": "scenes/main.tscn"}, {"op": "wait", "frames": 900}, {"op": "inspect_node", "path": "/root/MainWorld/SwarmDirector"}], "contains": "hp"}
# A spider that has been damaged to 0 dies: leaves the flock and frees (assert it is gone, not just re-damageable)
godot_runtime {"ops": [{"op": "run", "scene": "scenes/main.tscn"}, {"op": "wait", "frames": 1200}, {"op": "get_tree"}], "contains": "flock"}
# Moving a placed unit re-snaps it and the occupancy gate refuses a move onto a flow cell (assert the unit is on the new solid cell)
godot_runtime {"ops": [{"op": "run", "scene": "scenes/main.tscn"}, {"op": "input", "event": {"type": "mouse_button", "button": "right", "pressed": true}}, {"op": "input", "event": {"type": "mouse_button", "button": "left", "pressed": true}}, {"op": "wait", "frames": 30}, {"op": "get_tree"}], "contains": "position"}
# Hovering a placed unit draws its range ring (assert a second circle node is present and visible, distinct from the armed preview ring)
godot_runtime {"ops": [{"op": "run", "scene": "scenes/main.tscn"}, {"op": "wait", "frames": 120}, {"op": "get_tree"}], "contains": "_range_circle"}
