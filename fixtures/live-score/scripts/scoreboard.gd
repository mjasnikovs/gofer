extends Node2D

# The variable the task is about is `score`. Everything else on this page only looks like it.

const SCOREBOARD_PATH := "user://scoreboard.cfg"

var score := 0
var high_score := 0
var scoreboard: Array[int] = []

@onready var score_label: Label = $ScoreLabel


func _ready() -> void:
	reset_score()
	_refresh()


func add(amount: int) -> void:
	score += amount
	if score > high_score:
		high_score = score
	scoreboard.append(score)
	_refresh()


func reset_score() -> void:
	score = 0
	scoreboard.clear()


func _refresh() -> void:
	score_label.text = "Score: %d" % score
