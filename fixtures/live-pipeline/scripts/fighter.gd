extends Node2D


@export var armour: float = 0.5
@export var resistance: float = 0.2
@export var minimum_damage: int = 1

var health := 100
var ticks := 0


func _process(_delta: float) -> void:
	ticks += 1
	if ticks % 60 != 0 or health <= 0:
		return
	take_damage(10)
	print("health is now %d" % health)


func take_damage(raw: int) -> void:
	var after_armour := _apply_armour(raw)
	var after_resistance := _apply_resistance(after_armour)
	var final_damage := _floor_damage(after_resistance)
	health -= final_damage


func _apply_armour(amount: int) -> float:
	return float(amount) * armour


func _apply_resistance(amount: float) -> float:
	return amount * (1.0 - resistance)


func _floor_damage(amount: float) -> int:
	return maxi(int(amount), minimum_damage)
