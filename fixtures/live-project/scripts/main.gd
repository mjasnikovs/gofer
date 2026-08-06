extends Node2D

const TICK_MESSAGE := "live tick"

@export var tick_interval: float = 1.0

var total_ticks := 0

@onready var timer: Timer = $Ticker/Timer


func _ready() -> void:
	timer.wait_time = tick_interval
	timer.timeout.connect(_on_timeout)
	print("Gofer live test scene ready")


func _on_tick(ticks: int) -> void:
	total_ticks = ticks
	_announce(ticks)
	if ticks == 5:
		push_warning("Live test reached five ticks")


func _announce(ticks: int) -> void:
	print("%s %d" % [TICK_MESSAGE, ticks])


func _on_timeout() -> void:
	_on_tick(total_ticks + 1)
