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

## Why this fixture keeps its `.uid` files

Every other live fixture ignores `*.uid`, because they are seeded fresh and Godot rewrites them on
the first import. This one commits them, and `main.tscn` names them:

    [ext_resource type="Script" uid="uid://cbk3p4i4uctns" path="res://scripts/player.gd" id="2_player"]

That is how every scene Gofer saves refers to a script, and it is the shape that breaks when a file
is moved without its sidecar. Regenerating these files would change the ids and leave the scene
pointing at nothing, so they are part of the fixture rather than build output.
