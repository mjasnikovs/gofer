extends Node2D


const SPEED := 120.0

var direction := 0.0


func _process(delta: float) -> void:
	direction = _direction_for(Input.is_action_pressed("move_left"), Input.is_action_pressed("move_right"))
	position.x += direction * SPEED * delta
	position.x = clampf(position.x, 0.0, 620.0)


func _direction_for(left: bool, right: bool) -> float:
	var axis := 0.0
	if left:
		axis += 1.0
	if right:
		axis -= 1.0
	return axis
