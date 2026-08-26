extends Node2D

# The scene that does exist. `run/main_scene` names `level_one.tscn`, which does not, so the only
# way to a running game is to notice that and point the setting here.

func _ready() -> void:
	print("Gofer live test scene ready")
