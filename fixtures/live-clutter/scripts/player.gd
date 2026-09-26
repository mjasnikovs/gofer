extends Node2D


const SPEED: float = 120.0


func _process(delta: float) -> void:
	var axis: float = 0.0
	if Input.is_action_pressed("move_left"):
		axis -= 1.0
	if Input.is_action_pressed("move_right"):
		axis += 1.0
	position.x = clampf(position.x + axis * SPEED * delta, 0.0, 620.0)
