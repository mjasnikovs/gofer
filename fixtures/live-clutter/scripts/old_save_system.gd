extends Node

# An autoload nothing calls. Registered in project.godot, never mentioned by another script.

func save_game(_slot: int) -> void:
	print("OldSaveSystem.save_game was called, which nothing does")
