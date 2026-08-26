extends Node2D

@onready var scoreboard: Node2D = get_parent()

var ticks := 0


func _process(_delta: float) -> void:
	ticks += 1
	if ticks % 60 == 0:
		scoreboard.add(1)
		print("score is now %d" % scoreboard.score)
