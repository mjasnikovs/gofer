extends RefCounted

## The protocol shapes both halves of the addon speak.
##
## `plugin.gd` runs inside the editor and `runtime.gd` inside the running game — two processes that
## share no state, and the game cannot load an `EditorPlugin` script. Everything they must encode
## identically lives here instead of being copied into both: a divergence would show up as a value
## the renderer draws two ways depending on where it came from.
##
## `decode` lives here for the same reason `encode` does, and for one more: it is the only half of
## the round trip that can be checked without an editor. Nothing below touches an `EditorInterface`,
## an `EditorPlugin`, or the edited scene, so `fixtures/godot-project/tests/protocol_test.gd` runs
## the whole codec headlessly. The editor-only part — reading the type a *node* declares a property
## with — stays in `plugin.gd` and calls `fit_to_declared_type` for the part that is arithmetic.

## Screenshots are PNG, at most 1920 px on the longest edge, and stay well under the protocol's
## 16 MiB image-envelope cap even after base64 inflation.
const MAX_IMAGE_EDGE := 1920
const MAX_IMAGE_PNG_BYTES := 8388608

## Encodes an image as the protocol's `frame` shape, downscaling anything past the edge cap.
## Returns `{"ok": true, "frame": ...}` or `{"ok": false, "code": ..., "message": ...}`; each caller
## wraps the failure in the error shape its side of the wire uses.
static func encode_frame(image: Image) -> Dictionary:
    if image == null or image.is_empty():
        return _frame_failed("capture_unavailable", "The viewport produced no image")
    var longest: int = maxi(image.get_width(), image.get_height())
    if longest > MAX_IMAGE_EDGE:
        var scale := float(MAX_IMAGE_EDGE) / float(longest)
        image.resize(
            maxi(1, int(image.get_width() * scale)),
            maxi(1, int(image.get_height() * scale)),
            Image.INTERPOLATE_BILINEAR
        )
    var png := image.save_png_to_buffer()
    if png.is_empty():
        return _frame_failed("capture_unavailable", "The viewport image could not be encoded as PNG")
    if png.size() > MAX_IMAGE_PNG_BYTES:
        return _frame_failed("capture_too_large", "The PNG frame exceeded the image envelope budget")
    return {
        "ok": true,
        "frame": {
            "encoding": "png-base64",
            "width": image.get_width(),
            "height": image.get_height(),
            "data": Marshalls.raw_to_base64(png),
        }
    }

static func _frame_failed(code: String, message: String) -> Dictionary:
    return {"ok": false, "code": code, "message": message}

## Draws the windows standing over a viewport back onto it, so one capture is what a person sees.
##
## An editor screenshot is not one window. On a real desktop Godot gives every dialog a native
## window of its own — the pinned 4.7.2 reports `is_embedded() == false` for the confirmation that
## a main scene is not a scene — and the base control's viewport texture is the editor *behind* it.
## A capture that reads only that texture shows an editor with nothing wrong with it while a modal
## waits for an answer, which is the one moment a screenshot is worth asking for.
##
## Each overlay is `{"image": Image, "offset": Vector2i}`, offset in the base image's pixels and
## drawn in the order given. Anything hanging over an edge is clipped rather than refused: a dialog
## wider than the window behind it, or dragged half off the screen, is ordinary.
static func compose_frame(base: Image, overlays: Array) -> Image:
    var bounds := Rect2i(Vector2i.ZERO, base.get_size())
    for overlay in overlays:
        var image: Image = overlay["image"]
        if image == null or image.is_empty():
            continue
        var offset: Vector2i = overlay["offset"]
        var visible := Rect2i(offset, image.get_size()).intersection(bounds)
        if visible.size.x <= 0 or visible.size.y <= 0:
            continue
        # `blit_rect` takes the source rectangle in the *source* image, so the part of the window
        # that is off the screen is subtracted from where the copy starts, not from where it lands.
        if image.get_format() != base.get_format():
            image.convert(base.get_format())
        base.blit_rect(image, Rect2i(visible.position - offset, visible.size), visible.position)
    return base

## Encodes every item of an array-like value.
static func encode_items(value: Variant) -> Array:
    var encoded: Array = []
    for item in value:
        encoded.append(encode(item))
    return encoded

## Encodes a Variant as a tagged protocol value, the mirror of `decode`. A reference to an object —
## a node, a resource without a path, anything live — is described rather than encoded, and anything
## else becomes `opaque`; those tags are read-only, because nothing on the far side can rebuild what
## they point at.
static func encode(value: Variant) -> Dictionary:
    match typeof(value):
        TYPE_NIL:
            return {"type": "null", "value": null}
        TYPE_BOOL:
            return {"type": "bool", "value": value}
        TYPE_INT:
            return {"type": "int", "value": value}
        TYPE_FLOAT:
            return {"type": "float", "value": value}
        TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH:
            return {"type": "string", "value": str(value)}
        TYPE_VECTOR2:
            return {"type": "vector2", "value": [value.x, value.y]}
        TYPE_VECTOR2I:
            return {"type": "vector2i", "value": [value.x, value.y]}
        TYPE_VECTOR3:
            return {"type": "vector3", "value": [value.x, value.y, value.z]}
        TYPE_VECTOR3I:
            return {"type": "vector3i", "value": [value.x, value.y, value.z]}
        TYPE_VECTOR4, TYPE_QUATERNION:
            var kind := "vector4" if typeof(value) == TYPE_VECTOR4 else "quaternion"
            return {"type": kind, "value": [value.x, value.y, value.z, value.w]}
        TYPE_VECTOR4I:
            return {"type": "vector4i", "value": [value.x, value.y, value.z, value.w]}
        TYPE_COLOR:
            return {"type": "color", "value": [value.r, value.g, value.b, value.a]}
        TYPE_RECT2:
            return {"type": "rect2", "value": [value.position.x, value.position.y, value.size.x, value.size.y]}
        TYPE_RECT2I:
            return {"type": "rect2i", "value": [value.position.x, value.position.y, value.size.x, value.size.y]}
        TYPE_PLANE:
            return {"type": "plane", "value": [value.normal.x, value.normal.y, value.normal.z, value.d]}
        TYPE_TRANSFORM2D:
            return {
                "type": "transform2d",
                "value": [value.x.x, value.x.y, value.y.x, value.y.y, value.origin.x, value.origin.y]
            }
        TYPE_BASIS:
            return {
                "type": "basis",
                "value": [
                    value.x.x, value.x.y, value.x.z,
                    value.y.x, value.y.y, value.y.z,
                    value.z.x, value.z.y, value.z.z
                ]
            }
        TYPE_TRANSFORM3D:
            return {
                "type": "transform3d",
                "value": [
                    value.basis.x.x, value.basis.x.y, value.basis.x.z,
                    value.basis.y.x, value.basis.y.y, value.basis.y.z,
                    value.basis.z.x, value.basis.z.y, value.basis.z.z,
                    value.origin.x, value.origin.y, value.origin.z
                ]
            }
        TYPE_ARRAY, TYPE_PACKED_BYTE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, \
        TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_STRING_ARRAY, \
        TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_COLOR_ARRAY, \
        TYPE_PACKED_VECTOR4_ARRAY:
            return {"type": "array", "value": encode_items(value)}
        TYPE_DICTIONARY:
            var entries: Array = []
            for key in value:
                entries.append({"key": encode(key), "value": encode(value[key])})
            return {"type": "dictionary", "value": entries}
        TYPE_OBJECT:
            # An object property that holds nothing is not `TYPE_NIL`: `Sprite2D.texture` on a fresh
            # node is a Variant of type Object carrying a null pointer, and it lands here rather
            # than in the branch above. Without this guard `get_class` was called on nothing, which
            # is 341 properties across 120 of the 131 node types — every unset `material`,
            # `shape`, `icon`, and `theme`.
            if not is_instance_valid(value):
                return {"type": "null", "value": null}
            if value is Resource and not (value as Resource).resource_path.is_empty():
                return {
                    "type": "resource",
                    "value": {
                        "path": (value as Resource).resource_path, "resourceType": value.get_class()
                    }
                }
            if value is Node:
                return {
                    "type": "node",
                    "value": {
                        "path": str((value as Node).get_path()),
                        "nodeType": value.get_class(),
                        "instanceId": value.get_instance_id()
                    }
                }
            return {
                "type": "object",
                "value": {"className": value.get_class(), "instanceId": value.get_instance_id()}
            }
    return {
        "type": "opaque",
        "value": {"typeName": type_string(typeof(value)), "text": var_to_str(value)}
    }

## The element type of each packed array, keyed by the type of the packed array itself. The wire
## carries every array as a plain `array`, so this is what a setting declared as a packed array is
## rebuilt from.
const PACKED_ARRAY_ELEMENTS := {
    TYPE_PACKED_BYTE_ARRAY: TYPE_INT,
    TYPE_PACKED_INT32_ARRAY: TYPE_INT,
    TYPE_PACKED_INT64_ARRAY: TYPE_INT,
    TYPE_PACKED_FLOAT32_ARRAY: TYPE_FLOAT,
    TYPE_PACKED_FLOAT64_ARRAY: TYPE_FLOAT,
    TYPE_PACKED_STRING_ARRAY: TYPE_STRING,
    TYPE_PACKED_VECTOR2_ARRAY: TYPE_VECTOR2,
    TYPE_PACKED_VECTOR3_ARRAY: TYPE_VECTOR3,
    TYPE_PACKED_VECTOR4_ARRAY: TYPE_VECTOR4,
    TYPE_PACKED_COLOR_ARRAY: TYPE_COLOR,
}

## One decoded value. Every decoding function answers in this shape, so a caller checks `ok` once
## and never has to know which step refused.
static func decoded(value: Variant) -> Dictionary:
    return {"ok": true, "value": value, "message": ""}

static func decode_failed(message: String) -> Dictionary:
    return {"ok": false, "value": null, "message": message}

## Decodes one tagged protocol value into a Variant, the mirror of `encode`.
##
## Returns the `decoded` shape. A malformed payload is rejected rather than coerced, so a bad
## Vector2 never lands on a node as (0, 0). The tags `encode` writes for things it could only
## describe — `node`, `object`, `opaque` — have no branch here on purpose: nothing on this side can
## rebuild what they point at, and pretending otherwise would put a placeholder into a scene.
static func decode(value: Variant) -> Dictionary:
    if typeof(value) != TYPE_DICTIONARY:
        return decode_failed("A value must be a tagged object with a type and a value")
    var dict := value as Dictionary
    var kind: String = dict.get("type", "")
    var payload: Variant = dict.get("value", null)
    match kind:
        "null":
            return decoded(null)
        "bool":
            if typeof(payload) != TYPE_BOOL:
                return decode_failed("A bool value requires a boolean payload")
            return decoded(payload)
        "int":
            if not typeof(payload) in [TYPE_INT, TYPE_FLOAT]:
                return decode_failed("An int value requires a numeric payload")
            return decoded(int(payload))
        "float":
            if not typeof(payload) in [TYPE_INT, TYPE_FLOAT]:
                return decode_failed("A float value requires a numeric payload")
            return decoded(float(payload))
        "string":
            if typeof(payload) != TYPE_STRING:
                return decode_failed("A string value requires a string payload")
            return decoded(payload)
        "vector2":
            var v2 := numbers(payload, 2)
            return decode_failed("A vector2 value requires two numbers") if v2.is_empty() else decoded(Vector2(v2[0], v2[1]))
        "vector2i":
            var v2i := numbers(payload, 2)
            return decode_failed("A vector2i value requires two numbers") if v2i.is_empty() else decoded(Vector2i(int(v2i[0]), int(v2i[1])))
        "vector3":
            var v3 := numbers(payload, 3)
            return decode_failed("A vector3 value requires three numbers") if v3.is_empty() else decoded(Vector3(v3[0], v3[1], v3[2]))
        "vector3i":
            var v3i := numbers(payload, 3)
            return decode_failed("A vector3i value requires three numbers") if v3i.is_empty() else decoded(Vector3i(int(v3i[0]), int(v3i[1]), int(v3i[2])))
        "vector4":
            var v4 := numbers(payload, 4)
            return decode_failed("A vector4 value requires four numbers") if v4.is_empty() else decoded(Vector4(v4[0], v4[1], v4[2], v4[3]))
        "vector4i":
            var v4i := numbers(payload, 4)
            return decode_failed("A vector4i value requires four numbers") if v4i.is_empty() else decoded(Vector4i(int(v4i[0]), int(v4i[1]), int(v4i[2]), int(v4i[3])))
        "quaternion":
            var quaternion := numbers(payload, 4)
            return decode_failed("A quaternion value requires four numbers") if quaternion.is_empty() else decoded(Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]))
        "color":
            var rgba := numbers(payload, 4)
            return decode_failed("A color value requires four numbers") if rgba.is_empty() else decoded(Color(rgba[0], rgba[1], rgba[2], rgba[3]))
        "rect2":
            var r2 := numbers(payload, 4)
            return decode_failed("A rect2 value requires four numbers") if r2.is_empty() else decoded(Rect2(r2[0], r2[1], r2[2], r2[3]))
        "rect2i":
            var r2i := numbers(payload, 4)
            return decode_failed("A rect2i value requires four numbers") if r2i.is_empty() else decoded(Rect2i(int(r2i[0]), int(r2i[1]), int(r2i[2]), int(r2i[3])))
        "plane":
            var plane := numbers(payload, 4)
            return decode_failed("A plane value requires four numbers") if plane.is_empty() else decoded(Plane(Vector3(plane[0], plane[1], plane[2]), plane[3]))
        "transform2d":
            var t2d := numbers(payload, 6)
            if t2d.is_empty():
                return decode_failed("A transform2d value requires six numbers")
            return decoded(Transform2D(Vector2(t2d[0], t2d[1]), Vector2(t2d[2], t2d[3]), Vector2(t2d[4], t2d[5])))
        "basis":
            var basis := numbers(payload, 9)
            if basis.is_empty():
                return decode_failed("A basis value requires nine numbers")
            return decoded(_basis_from(basis))
        "transform3d":
            var t3d := numbers(payload, 12)
            if t3d.is_empty():
                return decode_failed("A transform3d value requires twelve numbers")
            return decoded(Transform3D(_basis_from(t3d), Vector3(t3d[9], t3d[10], t3d[11])))
        "array":
            return decode_items(payload)
        "dictionary":
            return _decode_dictionary(payload)
        "resource":
            if typeof(payload) != TYPE_DICTIONARY:
                return decode_failed("A resource value requires an object carrying a path")
            var path: String = (payload as Dictionary).get("path", "")
            if path.is_empty():
                return decode_failed("A resource value requires a non-empty path")
            var resource := load(path)
            if resource == null:
                # A file written into the worktree from outside the editor is the usual reason,
                # and naming the way out of it is what stops a caller asking again and again.
                return decode_failed(
                    (
                        "Resource %s could not be loaded. A file written into the worktree from "
                        + "outside the editor is not one until `resource.rescan` names it."
                    ) % path
                )
            return decoded(resource)
    return decode_failed("Value type '%s' is not supported" % kind)

## Decodes every tagged item of an array payload into an untyped Array.
static func decode_items(payload: Variant) -> Dictionary:
    if typeof(payload) != TYPE_ARRAY:
        return decode_failed("An array value requires an array of tagged values")
    var items: Array = []
    for entry in payload:
        var item := decode(entry)
        if not item["ok"]:
            return item
        items.append(item["value"])
    return decoded(items)

## Fits a decoded value onto the type a property or setting was declared with.
##
## The wire has one array tag, so a value the engine declared as a packed array is written back as
## a plain array; the declared type is what says which packed array to rebuild. Every element is
## checked first, because `type_convert` coerces a mistyped element instead of refusing it — a
## string in a PackedInt32Array would silently become 0.
static func fit_to_declared_type(value: Variant, declared: int) -> Dictionary:
    if declared == TYPE_NIL or typeof(value) == declared:
        return decoded(value)
    # A whole number is the natural way to write a float setting, and a string is the only way the
    # protocol carries a StringName or a NodePath.
    if declared == TYPE_FLOAT and typeof(value) == TYPE_INT:
        return decoded(float(value))
    if typeof(value) == TYPE_STRING and declared in [TYPE_STRING_NAME, TYPE_NODE_PATH]:
        return decoded(type_convert(value, declared))
    if typeof(value) == TYPE_ARRAY and PACKED_ARRAY_ELEMENTS.has(declared):
        var element: int = PACKED_ARRAY_ELEMENTS[declared]
        for index in (value as Array).size():
            var actual := typeof(value[index])
            # A whole number is a valid way to write one element of a float array.
            if actual == element or (element == TYPE_FLOAT and actual == TYPE_INT):
                continue
            return decode_failed(
                "a %s takes %s elements, but item %d is %s"
                % [type_string(declared), type_string(element), index, type_string(actual)]
            )
        return decoded(type_convert(value, declared))
    return decode_failed(
        "expected %s, received %s" % [type_string(declared), type_string(typeof(value))]
    )

## Rebuilds a Dictionary from the `{"key": ..., "value": ...}` entries `encode` writes.
static func _decode_dictionary(payload: Variant) -> Dictionary:
    if typeof(payload) != TYPE_ARRAY:
        return decode_failed("A dictionary value requires an array of key and value entries")
    var result := {}
    for entry in payload:
        if typeof(entry) != TYPE_DICTIONARY or not (entry as Dictionary).has("key") \
                or not (entry as Dictionary).has("value"):
            return decode_failed("A dictionary entry requires a key and a value")
        var key := decode((entry as Dictionary)["key"])
        if not key["ok"]:
            return key
        var item := decode((entry as Dictionary)["value"])
        if not item["ok"]:
            return item
        result[key["value"]] = item["value"]
    return decoded(result)

## Rebuilds a Basis from nine numbers laid out as three columns, the order `encode` writes.
static func _basis_from(numbers: PackedFloat64Array) -> Basis:
    return Basis(
        Vector3(numbers[0], numbers[1], numbers[2]),
        Vector3(numbers[3], numbers[4], numbers[5]),
        Vector3(numbers[6], numbers[7], numbers[8])
    )

## Returns `size` floats from `payload`, or an empty array when the payload is not that many
## numbers. Callers treat empty as malformed, so a zero-length component list is never valid.
static func numbers(payload: Variant, size: int) -> PackedFloat64Array:
    if typeof(payload) != TYPE_ARRAY:
        return PackedFloat64Array()
    var array := payload as Array
    if array.size() != size:
        return PackedFloat64Array()
    var result := PackedFloat64Array()
    for item in array:
        if not typeof(item) in [TYPE_INT, TYPE_FLOAT]:
            return PackedFloat64Array()
        result.append(float(item))
    return result
