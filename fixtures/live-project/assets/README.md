# The live sweep's art

`tiles.png` is a 128x32 atlas of sixteen 16x16 tiles, eight across and two down. It is original
pixel art drawn for this fixture in the palette a side-scrolling platformer is drawn in — the sweep
needs a real atlas with real tile boundaries, not a reproduction of anyone's assets.

| Row | Columns 0-3                                | Columns 4-7                                  |
| --- | ------------------------------------------ | -------------------------------------------- |
| 0   | ground, brick, question block, spent block | pipe mouth left/right, pipe shaft left/right |
| 1   | flag pole, pole ball, flag, castle brick   | bush left/right, cloud left/right            |

The sweep hands that legend to the agent in words, because nothing in Gofer reads an image: the
agent cuts the atlas into a `TileSet` with `godot_resource create_tileset`, decides for itself which
tiles collide, and paints the level onto a `TileMapLayer` with `godot_node set_cells`.
