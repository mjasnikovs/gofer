extends Node

## Gofer's runtime helper, autoloaded into the running game.
##
## It answers runtime inspection and input requests over the debugger channel in a later step. Until
## then it stays inert: the autoload exists so staging, cleanup, and the project.godot ledger are
## exercised by the same entry the finished helper uses.

const PROTOCOL_VERSION := 2

func _ready() -> void:
    print("GOFER_RUNTIME_READY:%d" % PROTOCOL_VERSION)
