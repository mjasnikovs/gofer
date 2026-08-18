extends Node2D

@export var speed: float = 24.0

var travelled := 0.0


func _process(delta: float) -> void:
	travelled += speed * delta
