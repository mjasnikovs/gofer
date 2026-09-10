extends CharacterBody2D

signal died
signal health_changed(current: int, maximum: int)

const MAX_HEALTH := 100
const DASH_SPEED := 480.0
const WALK_SPEED := 160.0
const JUMP_VELOCITY := -420.0
const INVULNERABLE_SECONDS := 0.8

@export var acceleration: float = 12.0
@export var friction: float = 18.0
@export var coyote_frames: int = 6

var health := MAX_HEALTH
var invulnerable_left := 0.0
var coyote_left := 0
var facing := 1
var dashing := false

@onready var sprite: Sprite2D = $Sprite2D
@onready var hurtbox: Area2D = $Hurtbox
@onready var dash_timer: Timer = $DashTimer


func _ready() -> void:
	hurtbox.body_entered.connect(_on_hurtbox_body_entered)
	dash_timer.timeout.connect(_on_dash_timer_timeout)
	health_changed.emit(health, MAX_HEALTH)


func _physics_process(delta: float) -> void:
	_tick_timers(delta)
	_apply_gravity(delta)
	_read_input(delta)
	move_and_slide()
	_update_facing()


func _tick_timers(delta: float) -> void:
	if invulnerable_left > 0.0:
		invulnerable_left -= delta
	if is_on_floor():
		coyote_left = coyote_frames
	elif coyote_left > 0:
		coyote_left -= 1


func _apply_gravity(delta: float) -> void:
	if is_on_floor():
		return
	velocity += get_gravity() * delta


func _read_input(delta: float) -> void:
	var axis := Input.get_axis("move_left", "move_right")
	var target := axis * (DASH_SPEED if dashing else WALK_SPEED)
	var rate := acceleration if axis != 0.0 else friction
	velocity.x = lerp(velocity.x, target, clamp(rate * delta, 0.0, 1.0))
	if Input.is_action_just_pressed("jump") and coyote_left > 0:
		velocity.y = JUMP_VELOCITY
		coyote_left = 0
	if Input.is_action_just_pressed("dash") and not dashing:
		dashing = true
		dash_timer.start()


func _update_facing() -> void:
	if velocity.x > 1.0:
		facing = 1
	elif velocity.x < -1.0:
		facing = -1
	sprite.flip_h = facing < 0


func take_damage(amount: int) -> void:
	if invulnerable_left > 0.0:
		return
	health = max(health - amount, 0)
	invulnerable_left = INVULNERABLE_SECONDS
	health_changed.emit(health, MAX_HEALTH)
	if health == 0:
		died.emit()
		queue_free()


func heal(amount: int) -> void:
	health = min(health + amount, MAX_HEALTH)
	health_changed.emit(health, MAX_HEALTH)


func _on_hurtbox_body_entered(body: Node2D) -> void:
	if body.is_in_group("enemies"):
		take_damage(10)


func _on_dash_timer_timeout() -> void:
	dashing = false
