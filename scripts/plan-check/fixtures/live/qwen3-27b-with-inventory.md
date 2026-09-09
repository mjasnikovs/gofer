GOAL

Display a persistent "Wave: N" label in the HUD of the main game scene. The counter starts at 0 and increments by 1 each time the `SwarmDirector` reports that the current wave of enemies has been fully eliminated.

CONSTRAINTS

- `project.godot`, `shaders/pixel_offset.gdshader`, and every file under `assets/` and `audio/` must NOT be modified.
- `scripts/enemy/flow_field.gd`, `scripts/enemy/flow_layer.gd`, `scripts/enemy/flock_hash.gd`, and all `test_scenes/*` files must NOT be modified.
- The wave counter must not introduce a new scene file; it is a single `Label` node added to an existing scene.
- The signal emission in `scripts/enemy/swarm_director.gd` must not alter existing enemy-spawning or flow-field logic.
- The label must be visible in the default viewport resolution and must not require a new font asset (use the existing `assets/fonts/Silkscreen-Regular.ttf`).

STEPS

1. **`scripts/enemy/swarm_director.gd`**
   - Add a new signal at the top of the class: `signal wave_cleared(new_wave: int)`.
   - Add a `var _wave_number: int = 0` member (initialised to 0).
   - In the existing logic that detects "all enemies of the current wave are dead" (the branch that triggers the next spawn or the idle state), increment `_wave_number` and emit the signal: `wave_cleared.emit(_wave_number)`.
   - If the director already tracks a `current_wave` or similar counter, reuse it; otherwise the new `_wave_number` is the single source of truth.

2. **`scenes/main.tscn`**
   - Under the root node, add a `Label` node named `WaveCounter`.
   - Set its `text` to `"Wave: 0"`.
   - Set its `theme_override_font_sizes/font_size` to `16`.
   - Set its `theme_override_colors/font_color` to `Color(1, 1, 1, 1)`.
   - Anchor it to the top-left: `anchor_left = 0`, `anchor_top = 0`, `offset_left = 8`, `offset_top = 8`, `offset_right = 120`, `offset_bottom = 28`.
   - Set `horizontal_alignment` to `HORIZONTAL_ALIGNMENT_LEFT` and `vertical_alignment` to `VERTICAL_ALIGNMENT_TOP`.
   - Ensure the label is in a `CanvasLayer` (or the UI layer) so it renders above the 3D/2D world, not affected by the pixel-perfect viewport shader in `materials/pixel_viewport_material.tres`.

3. **`scripts/ui/development_ui.gd`**
   - In `_ready()`, obtain a reference to the label: `var _wave_label: Label = get_node_or_null("../WaveCounter")` (adjust the relative path to match the node hierarchy in `scenes/main.tscn`).
   - Obtain a reference to the `SwarmDirector` node: `var _director: Node = get_tree().get_first_node_in_group("swarm_director")` (or use a direct node path if the director is a sibling).
   - Connect the signal: `_director.wave_cleared.connect(_on_wave_cleared)`.
   - Add the callback:
     ```gdscript
     func _on_wave_cleared(new_wave: int) -> void:
         if _wave_label:
             _wave_label.text = "Wave: %d" % new_wave
     ```
   - Guard the connection with `if _director and _director.has_signal("wave_cleared")` to avoid crashing when the director is absent (e.g. in test scenes that don't instantiate it).

VERIFY

```sh
cd /home/edgars/hub/swarm

# 1. Confirm the signal exists in the swarm director
grep -n 'signal wave_cleared' scripts/enemy/swarm_director.gd