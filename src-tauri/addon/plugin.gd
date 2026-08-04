@tool
extends EditorPlugin

## The Gofer editor plugin.
##
## Gofer stages this addon into the active task worktree and removes it again when the session
## stops, so the plugin owns no project state of its own. The persistent editor RPC connects
## outward from here in a later step; today the plugin only announces that Gofer's managed addon
## loaded inside the editor Gofer launched.

const PROTOCOL_VERSION := 2

func _enter_tree() -> void:
    print("GOFER_ADDON_READY:%d" % PROTOCOL_VERSION)

func _exit_tree() -> void:
    print("GOFER_ADDON_STOPPED")

func _get_plugin_name() -> String:
    return "Gofer"
