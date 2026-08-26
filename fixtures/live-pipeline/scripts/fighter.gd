extends Node2D

# A hit of 10 should leave the fighter on 96 after the first tick: 10 raw, halved by armour to 5,
# a fifth off for resistance to 4, floored at 1. It lands on 20, and on -60 a second later.
# Nothing on this page is wrong: the scene overrides `armour` to 10.0, so the first helper
# multiplies where it should halve, and the number that does it is not in any script.

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
