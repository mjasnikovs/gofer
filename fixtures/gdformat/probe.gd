extends Node

signal health_changed(new_value: int)

const LIMITS: Dictionary[String, int] = {"low": 1, "high": 9}

@export var speed := 4.5
@onready var label: Label = $Label

var scores: Dictionary[String, int] = {}
var names: Array[String] = ["alpha", "beta"]
var callback := func(value: int) -> int: return value * 2


static func clamp_score(value: int) -> int:
	return clampi(value, 0, 100)


func _ready() -> void:
	health_changed.emit(10)
	var label_text := "even" if scores.size() % 2 == 0 else "odd"
	label.text = label_text
	await get_tree().process_frame
	for key: String in scores:
		print(key)
	match speed:
		0.0:
			pass
		_:
			pass
	if label is Label:
		super._ready()


func compute() -> Variant:
	var result: Variant = callback.call(2)
	return result
