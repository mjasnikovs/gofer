extends SceneTree

## The two vocabularies `--dump-extension-api` does not carry, printed by the engine itself.
##
## The dump has the `Key` enum but not the strings `OS.get_keycode_string` spells its values with,
## and 57 of the 190 are not a mechanical transform of the enum name — `KEY_KP_ENTER` is
## "Kp Enter", `KEY_JIS_EISU` is "JIS Eisu". The same goes for `type_string`, which is the one
## spelling of a Variant type the protocol may use as a tag.
##
## The values to walk arrive as a JSON file named on the command line rather than being iterated
## over an integer range: the dump is the one place the engine's enums are read from, so a probe
## that guessed the space would be a second source that could disagree with it.

const BEGIN := "@@GOFER-VOCABULARY-BEGIN@@"
const END := "@@GOFER-VOCABULARY-END@@"


func _init() -> void:
	var arguments := OS.get_cmdline_user_args()
	if arguments.is_empty():
		printerr("the probe takes the path of the JSON file naming the values to walk")
		quit(1)
		return
	var request: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(arguments[0]))
	var spoken := {
		"keycodes": _keycodes(request["keys"]),
		"variantTypes": _type_strings(request["variantTypes"]),
	}
	print(BEGIN)
	print(JSON.stringify(spoken))
	print(END)
	quit()


## Every keycode that survives the round trip, as the string the engine spells it with.
##
## A name the engine prints but does not resolve back to the same code would leave a written input
## action disagreeing with the one that produced it, so acceptance alone is not enough.
func _keycodes(codes: Array) -> Dictionary:
	var spellings := {}
	for code in codes:
		var whole := int(code)
		var spelled := OS.get_keycode_string(whole)
		if spelled == "" or OS.find_keycode_from_string(spelled) != whole:
			continue
		spellings[spelled] = whole
	return spellings


func _type_strings(values: Array) -> Array:
	var names := []
	for value in values:
		names.append(type_string(int(value)))
	return names
