GOAL

Add a persistent **Wave** counter to the HUD in the Godot 4 project at `/home/edgars/hub/swarm`. The counter starts at `1` and increments by `1` each time the active swarm is fully cleared (all enemy units dead). The label should be visible at all times during gameplay and update in real-time.

CONSTRAINTS

- `project.godot` must NOT be modified (no new autoloads or input-map entries required for this change).
- `scenes/units/enemy.tscn` and `scripts/units/enemy.gd` must NOT be modified; the "swarm cleared" signal must be inferred from existing group membership or the swarm manager's internal state, not from per-enemy scene changes.
- All new UI nodes must live inside the existing `scenes/ui/hud.tscn` CanvasLayer so they are not affected by camera transforms.
- The wave counter must survive scene reloads within the same play session (i.e., it is owned by the HUD script, not by a transient node that gets freed between waves).
- No third-party assets or external resources may be added; only the built-in `Label` node and the project's existing font theme are permitted.

STEPS

1. **`scenes/ui/hud.tscn`** – Add a new `Label` node named `WaveLabel` as a child of the root `CanvasLayer`. Set its `text` to `"Wave: 1"`, anchor it to the top-right corner (`anchors_preset = 1`), and apply the project's default theme so it matches existing HUD elements. Save the scene.

2. **`scripts/ui/hud.gd`** – Add a `@export var wave: int = 1` and a `func _ready()` that caches the `WaveLabel` reference via `$WaveLabel`. Add a public method `func set_wave(new_wave: int)` that updates `wave` and sets `WaveLabel.text = "Wave: %d" % wave`. Connect this to the signal defined in step 3.

3. **`scripts/game/swarm_manager.gd`** – Declare a new signal `signal wave_cleared(new_wave: int)`. In the existing "all enemies dead" check (the code path that fires when the enemy group count reaches zero), emit `wave_cleared.emit(wave_number + 1)` and then spawn the next wave. If no such check exists yet, add one inside the existing `_on_enemy_died` callback that counts remaining members of the `"enemy"` group.

4. **`scripts/game/main.gd`** – In `_ready()`, connect `swarm_manager.wave_cleared` to `hud.set_wave` (e.g. `swarm_manager.wave_cleared.connect(hud.set_wave)`). Ensure the `hud` and `swarm_manager` node references are already available (they should be, given the existing scene tree). Save the scene if the connection is made in the `.tscn` editor instead of code.

5. **`scenes/ui/hud.tscn`** (editor step) – Open the scene in the Godot editor, confirm the `WaveLabel` is visible in the top-right at 1080p, and adjust `theme_override_font_sizes/font_size` to match the existing `ScoreLabel` so visual weight is consistent.

VERIFY

```sh
cd /home/edgars/hub/swarm

# 1. Confirm the WaveLabel node exists in the HUD scene
grep -q 'WaveLabel' scenes/ui/hud.tscn && echo "OK: WaveLabel present" || echo "FAIL: WaveLabel missing"

# 2. Confirm the signal and set_wave method are in place
grep -q 'signal wave_cleared' scripts/game/swarm_manager.gd && echo "OK: signal declared" || echo "FAIL: signal missing"
grep -q 'func set_wave' scripts/ui/hud.gd && echo "OK: set_wave defined" || echo "FAIL: set_wave missing"

# 3. Confirm the connection is wired in main
grep -q 'wave_cleared' scripts/game/main.gd && echo "OK: connection present" || echo "FAIL: connection missing"

# 4. Headless smoke-test: launch the game for 5 seconds, expect no script errors
timeout 5 godot --headless --path . res://scenes/game/main.tscn 2>&1 | grep -i 'script error' && echo "FAIL: script errors found" || echo "OK: no script errors"

# 5. Confirm project.godot is untouched (compare against git HEAD if in a repo)
git diff --name-only HEAD -- project.godot | grep -q 'project.godot' && echo "FAIL: project.godot modified" || echo "OK: project.godot unmodified"

# 6. Confirm enemy unit files are untouched
git diff --name-only HEAD -- scenes/units/enemy.tscn scripts/units/enemy.gd | grep -q . && echo "FAIL: enemy files modified" || echo "OK: enemy files unmodified"
```