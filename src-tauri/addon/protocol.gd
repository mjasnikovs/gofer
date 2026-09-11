extends RefCounted

## The protocol shapes both halves of the addon speak.
##
## `plugin.gd` runs inside the editor and `runtime.gd` inside the running game — two processes that
## share no state, and the game cannot load an `EditorPlugin` script. Everything they must encode
## identically lives here instead of being copied into both: a divergence would show up as a value
## the renderer draws two ways depending on where it came from.
##
## `decode` lives here for the same reason `encode` does, and for one more: it is the half of the
## round trip that can be checked without an editor. Nothing below touches an `EditorInterface`,
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

## Encodes every element of a packed array as the payload its own tag carries — a number, a string,
## or a vector's components — and not as a tagged value of its own. A packed array holds one type
## and the array's tag already names it, so a tag per element would say it again for every element.
static func encode_packed_items(value: Variant) -> Array:
    var encoded: Array = []
    for item in value:
        encoded.append(encode(item)["value"])
    return encoded

## Encodes a Variant as a tagged protocol value, the mirror of `decode`.
##
## Every tag is the spelling `type_string` gives that Variant type, so the name on the wire is the
## engine's own. A reference to an object — a node, a resource without a path, anything live — is
## described rather than encoded, and anything else becomes `opaque`. Those three tags are lowercase
## because they name a description rather than a Variant type, and they are read-only: nothing on
## the far side can rebuild what they point at.
static func encode(value: Variant) -> Dictionary:
    match typeof(value):
        TYPE_NIL:
            return {"type": "Nil", "value": null}
        TYPE_BOOL:
            return {"type": "bool", "value": value}
        TYPE_INT:
            return {"type": "int", "value": value}
        TYPE_FLOAT:
            return {"type": "float", "value": value}
        TYPE_STRING:
            return {"type": "String", "value": str(value)}
        TYPE_STRING_NAME:
            return {"type": "StringName", "value": str(value)}
        TYPE_NODE_PATH:
            return {"type": "NodePath", "value": str(value)}
        TYPE_VECTOR2:
            return {"type": "Vector2", "value": [value.x, value.y]}
        TYPE_VECTOR2I:
            return {"type": "Vector2i", "value": [value.x, value.y]}
        TYPE_VECTOR3:
            return {"type": "Vector3", "value": [value.x, value.y, value.z]}
        TYPE_VECTOR3I:
            return {"type": "Vector3i", "value": [value.x, value.y, value.z]}
        TYPE_VECTOR4:
            return {"type": "Vector4", "value": [value.x, value.y, value.z, value.w]}
        TYPE_VECTOR4I:
            return {"type": "Vector4i", "value": [value.x, value.y, value.z, value.w]}
        TYPE_QUATERNION:
            return {"type": "Quaternion", "value": [value.x, value.y, value.z, value.w]}
        TYPE_COLOR:
            return {"type": "Color", "value": [value.r, value.g, value.b, value.a]}
        TYPE_RECT2:
            return {"type": "Rect2", "value": [value.position.x, value.position.y, value.size.x, value.size.y]}
        TYPE_RECT2I:
            return {"type": "Rect2i", "value": [value.position.x, value.position.y, value.size.x, value.size.y]}
        TYPE_AABB:
            return {
                "type": "AABB",
                "value": [
                    value.position.x, value.position.y, value.position.z,
                    value.size.x, value.size.y, value.size.z
                ]
            }
        TYPE_PLANE:
            return {"type": "Plane", "value": [value.normal.x, value.normal.y, value.normal.z, value.d]}
        TYPE_TRANSFORM2D:
            return {
                "type": "Transform2D",
                "value": [value.x.x, value.x.y, value.y.x, value.y.y, value.origin.x, value.origin.y]
            }
        TYPE_BASIS:
            return {
                "type": "Basis",
                "value": [
                    value.x.x, value.x.y, value.x.z,
                    value.y.x, value.y.y, value.y.z,
                    value.z.x, value.z.y, value.z.z
                ]
            }
        TYPE_TRANSFORM3D:
            return {
                "type": "Transform3D",
                "value": [
                    value.basis.x.x, value.basis.x.y, value.basis.x.z,
                    value.basis.y.x, value.basis.y.y, value.basis.y.z,
                    value.basis.z.x, value.basis.z.y, value.basis.z.z,
                    value.origin.x, value.origin.y, value.origin.z
                ]
            }
        TYPE_PROJECTION:
            return {
                "type": "Projection",
                "value": [
                    value.x.x, value.x.y, value.x.z, value.x.w,
                    value.y.x, value.y.y, value.y.z, value.y.w,
                    value.z.x, value.z.y, value.z.z, value.z.w,
                    value.w.x, value.w.y, value.w.z, value.w.w
                ]
            }
        TYPE_ARRAY:
            return {"type": "Array", "value": encode_items(value)}
        TYPE_PACKED_BYTE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, \
        TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_STRING_ARRAY, \
        TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_COLOR_ARRAY, \
        TYPE_PACKED_VECTOR4_ARRAY:
            return {"type": type_string(typeof(value)), "value": encode_packed_items(value)}
        TYPE_DICTIONARY:
            var entries: Array = []
            for key in value:
                entries.append({"key": encode(key), "value": encode(value[key])})
            return {"type": "Dictionary", "value": entries}
        TYPE_OBJECT:
            if not is_instance_valid(value):
                return {"type": "Nil", "value": null}
            if value is Resource and not (value as Resource).resource_path.is_empty():
                return {
                    "type": "Resource",
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

## The element type of each packed array, keyed by the type of the packed array itself. It is what
## `decode` reads one element at a time, and what a plain `Array` written to a property declared as
## a packed array is rebuilt from.
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
## Vector2 never lands on a node as (0, 0). Four Variant types are refused by name because JSON
## cannot carry one: a `Callable`, a `Signal`, an `RID` and an `Object` each point at something
## live in this process. The tags `encode` writes for those — `node`, `object`, `opaque` — have no
## branch here for the same reason, and pretending otherwise would put a placeholder into a scene.
static func decode(value: Variant) -> Dictionary:
    if typeof(value) != TYPE_DICTIONARY:
        return decode_failed("A value must be a tagged object with a type and a value")
    var dict := value as Dictionary
    var kind: String = dict.get("type", "")
    var payload: Variant = dict.get("value", null)
    match kind:
        "Nil":
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
        "String":
            if typeof(payload) != TYPE_STRING:
                return decode_failed("A String value requires a string payload")
            return decoded(payload)
        "StringName":
            if not typeof(payload) in [TYPE_STRING, TYPE_STRING_NAME]:
                return decode_failed("A StringName value requires a string payload")
            return decoded(StringName(str(payload)))
        "NodePath":
            if not typeof(payload) in [TYPE_STRING, TYPE_STRING_NAME]:
                return decode_failed("A NodePath value requires a string payload")
            return decoded(NodePath(str(payload)))
        "Vector2":
            var v2 := numbers(payload, 2)
            return decode_failed("A Vector2 value requires two numbers") if v2.is_empty() else decoded(Vector2(v2[0], v2[1]))
        "Vector2i":
            var v2i := numbers(payload, 2)
            return decode_failed("A Vector2i value requires two numbers") if v2i.is_empty() else decoded(Vector2i(int(v2i[0]), int(v2i[1])))
        "Vector3":
            var v3 := numbers(payload, 3)
            return decode_failed("A Vector3 value requires three numbers") if v3.is_empty() else decoded(Vector3(v3[0], v3[1], v3[2]))
        "Vector3i":
            var v3i := numbers(payload, 3)
            return decode_failed("A Vector3i value requires three numbers") if v3i.is_empty() else decoded(Vector3i(int(v3i[0]), int(v3i[1]), int(v3i[2])))
        "Vector4":
            var v4 := numbers(payload, 4)
            return decode_failed("A Vector4 value requires four numbers") if v4.is_empty() else decoded(Vector4(v4[0], v4[1], v4[2], v4[3]))
        "Vector4i":
            var v4i := numbers(payload, 4)
            return decode_failed("A Vector4i value requires four numbers") if v4i.is_empty() else decoded(Vector4i(int(v4i[0]), int(v4i[1]), int(v4i[2]), int(v4i[3])))
        "Quaternion":
            var quaternion := numbers(payload, 4)
            return decode_failed("A Quaternion value requires four numbers") if quaternion.is_empty() else decoded(Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]))
        "Color":
            if typeof(payload) == TYPE_STRING or typeof(payload) == TYPE_STRING_NAME:
                var unreadable := Color(-1.0, -2.0, -3.0, -4.0)
                var named := Color.from_string(str(payload).strip_edges(), unreadable)
                if named == unreadable:
                    return decode_failed(
                        "%s is not a colour. Write a name like skyblue, a hex string like #8b5a2b, or four numbers" % str(payload)
                    )
                return decoded(named)
            var rgba := numbers(payload, 4)
            return decode_failed("A Color value requires four numbers, a name like skyblue, or a hex string like #8b5a2b") if rgba.is_empty() else decoded(Color(rgba[0], rgba[1], rgba[2], rgba[3]))
        "Rect2":
            var r2 := numbers(payload, 4)
            return decode_failed("A Rect2 value requires four numbers") if r2.is_empty() else decoded(Rect2(r2[0], r2[1], r2[2], r2[3]))
        "Rect2i":
            var r2i := numbers(payload, 4)
            return decode_failed("A Rect2i value requires four numbers") if r2i.is_empty() else decoded(Rect2i(int(r2i[0]), int(r2i[1]), int(r2i[2]), int(r2i[3])))
        "AABB":
            var box := numbers(payload, 6)
            if box.is_empty():
                return decode_failed("An AABB value requires six numbers, a position then a size")
            return decoded(AABB(_vector3_at(box, 0), _vector3_at(box, 3)))
        "Plane":
            var plane := numbers(payload, 4)
            return decode_failed("A Plane value requires four numbers") if plane.is_empty() else decoded(Plane(Vector3(plane[0], plane[1], plane[2]), plane[3]))
        "Transform2D":
            var t2d := numbers(payload, 6)
            if t2d.is_empty():
                return decode_failed("A Transform2D value requires six numbers")
            return decoded(Transform2D(Vector2(t2d[0], t2d[1]), Vector2(t2d[2], t2d[3]), Vector2(t2d[4], t2d[5])))
        "Basis":
            var basis := numbers(payload, 9)
            if basis.is_empty():
                return decode_failed("A Basis value requires nine numbers")
            return decoded(_basis_from(basis))
        "Transform3D":
            var t3d := numbers(payload, 12)
            if t3d.is_empty():
                return decode_failed("A Transform3D value requires twelve numbers")
            return decoded(Transform3D(_basis_from(t3d), _vector3_at(t3d, 9)))
        "Projection":
            var projection := numbers(payload, 16)
            if projection.is_empty():
                return decode_failed("A Projection value requires sixteen numbers, four columns of four")
            return decoded(
                Projection(
                    _vector4_at(projection, 0),
                    _vector4_at(projection, 4),
                    _vector4_at(projection, 8),
                    _vector4_at(projection, 12)
                )
            )
        "Array":
            return decode_items(payload)
        "PackedByteArray", "PackedInt32Array", "PackedInt64Array", "PackedFloat32Array", \
        "PackedFloat64Array", "PackedStringArray", "PackedVector2Array", "PackedVector3Array", \
        "PackedVector4Array", "PackedColorArray":
            return _decode_packed(kind, payload)
        "Dictionary":
            return _decode_dictionary(payload)
        "Resource":
            if typeof(payload) != TYPE_DICTIONARY:
                return decode_failed("A Resource value requires an object carrying a path")
            var path: String = (payload as Dictionary).get("path", "")
            if path.is_empty():
                return decode_failed("A Resource value requires a non-empty path")
            var resource := load(path)
            if resource == null:
                return decode_failed(_why_the_resource_did_not_load(path))
            return decoded(resource)
        "Callable", "Signal", "RID", "Object":
            return decode_failed(
                "A %s points at something live in this process, which no value can carry" % kind
            )
    return decode_failed("Value type '%s' is not supported" % kind)

## Why `load` answered null, told apart by what is on disk.
##
## One message said "rescan" for all three, and a live turn rescanned four times over a .tres the
## editor could not parse — the parse error sat in the editor output the whole time.
static func _why_the_resource_did_not_load(path: String) -> String:
    if not FileAccess.file_exists(path):
        return (
            "Resource %s could not be loaded: there is no file at that path. resource.list names "
            + "every file the project has."
        ) % path
    if not ResourceLoader.exists(path):
        return (
            "Resource %s could not be loaded. A file written into the worktree from outside the "
            + "editor is not one until `resource.rescan` names it."
        ) % path
    return (
        "Resource %s is on disk and the editor could not load it, which is what a file it cannot "
        + "parse looks like. logs.read with minSeverity error and contains %s shows the line it "
        + "stopped at; fix the file, then set the property again."
    ) % [path, path]


## Decodes a packed array from a plain JSON array of its element's own payloads.
##
## Each element is read back through `decode` under the element type's own tag, so the element
## rules are stated once: a PackedVector2Array element is two numbers because a Vector2 is.
static func _decode_packed(kind: String, payload: Variant) -> Dictionary:
    var packed := TYPE_NIL
    for candidate in PACKED_ARRAY_ELEMENTS:
        if type_string(candidate) == kind:
            packed = candidate
    if not PACKED_ARRAY_ELEMENTS.has(packed):
        return decode_failed("Value type '%s' is not supported" % kind)
    var element: int = PACKED_ARRAY_ELEMENTS[packed]
    if typeof(payload) != TYPE_ARRAY:
        return decode_failed("A %s value requires an array of %s" % [kind, type_string(element)])
    var items: Array = []
    for entry in payload as Array:
        var item := decode({"type": type_string(element), "value": entry})
        if not item["ok"]:
            return decode_failed("A %s value requires an array of %s: %s" % [kind, type_string(element), item["message"]])
        items.append(item["value"])
    return decoded(type_convert(items, packed))

## Decodes every tagged item of an array payload into an untyped Array.
static func decode_items(payload: Variant) -> Dictionary:
    if typeof(payload) != TYPE_ARRAY:
        return decode_failed("An Array value requires an array of tagged values")
    var items: Array = []
    for entry in payload:
        var item := decode(entry)
        if not item["ok"]:
            return item
        items.append(item["value"])
    return decoded(items)

## The tag a value of a given Godot type is written under, which is `type_string`'s own spelling
## for every one of them but `Object`: the only object shape a value can rebuild is a saved
## resource, so a property declared as an Object is told to send a `Resource`.
##
## Every entry is held to `decode` itself by `protocol_test.gd`, so a tag named here is one the
## codec really reads. `Callable`, `Signal` and `RID` are absent because nothing can build one from
## JSON, and a type with no tag gains no sentence rather than an invented one.
const TAG_FOR_TYPE := {
    TYPE_NIL: "Nil",
    TYPE_BOOL: "bool",
    TYPE_INT: "int",
    TYPE_FLOAT: "float",
    TYPE_STRING: "String",
    TYPE_VECTOR2: "Vector2",
    TYPE_VECTOR2I: "Vector2i",
    TYPE_RECT2: "Rect2",
    TYPE_RECT2I: "Rect2i",
    TYPE_VECTOR3: "Vector3",
    TYPE_VECTOR3I: "Vector3i",
    TYPE_TRANSFORM2D: "Transform2D",
    TYPE_VECTOR4: "Vector4",
    TYPE_VECTOR4I: "Vector4i",
    TYPE_PLANE: "Plane",
    TYPE_QUATERNION: "Quaternion",
    TYPE_AABB: "AABB",
    TYPE_BASIS: "Basis",
    TYPE_TRANSFORM3D: "Transform3D",
    TYPE_PROJECTION: "Projection",
    TYPE_COLOR: "Color",
    TYPE_STRING_NAME: "StringName",
    TYPE_NODE_PATH: "NodePath",
    TYPE_OBJECT: "Resource",
    TYPE_DICTIONARY: "Dictionary",
    TYPE_ARRAY: "Array",
    TYPE_PACKED_BYTE_ARRAY: "PackedByteArray",
    TYPE_PACKED_INT32_ARRAY: "PackedInt32Array",
    TYPE_PACKED_INT64_ARRAY: "PackedInt64Array",
    TYPE_PACKED_FLOAT32_ARRAY: "PackedFloat32Array",
    TYPE_PACKED_FLOAT64_ARRAY: "PackedFloat64Array",
    TYPE_PACKED_STRING_ARRAY: "PackedStringArray",
    TYPE_PACKED_VECTOR2_ARRAY: "PackedVector2Array",
    TYPE_PACKED_VECTOR3_ARRAY: "PackedVector3Array",
    TYPE_PACKED_VECTOR4_ARRAY: "PackedVector4Array",
    TYPE_PACKED_COLOR_ARRAY: "PackedColorArray",
}

## What a value written under the wrong tag is told, past the two type names.
##
## `expected Color, received String` is true and says nothing about the one thing that would have
## worked. `loc-21-platformer` wrote `{"type": "String", "value": "#5c8a3c"}` for two ColorRects:
## the colour was right, the tag was not, and `{"type": "Color", "value": "#5c8a3c"}` takes that
## exact text — `Color.from_string` reads names and hex, which is why the `color` arm above accepts
## a string at all. So the colour case names the value back, and every other type names its tag.
static func under_the_tag_it_takes(declared: int, value: Variant) -> String:
    if not TAG_FOR_TYPE.has(declared):
        return ""
    var tag: String = TAG_FOR_TYPE[declared]
    if declared == TYPE_COLOR and typeof(value) in [TYPE_STRING, TYPE_STRING_NAME]:
        return (
            '. The colour is right and the tag is not: send {"type": "Color", "value": "%s"} —'
            + " a colour tag reads a name or a hex string as well as four numbers."
        ) % str(value)
    return '. This property takes a %s: send {"type": "%s", "value": …}.' % [type_string(declared), tag]

## Fits a decoded value onto the type a property or setting was declared with.
##
## A packed array has a tag of its own, and a plain `Array` written to a property declared as one
## still fits: the declared type says which packed array to rebuild. Every element is checked
## first, because `type_convert` coerces a mistyped element instead of refusing it — a string in a
## PackedInt32Array would silently become 0.
static func fit_to_declared_type(value: Variant, declared: int) -> Dictionary:
    if declared == TYPE_NIL or typeof(value) == declared:
        return decoded(value)
    if declared == TYPE_FLOAT and typeof(value) == TYPE_INT:
        return decoded(float(value))
    if declared == TYPE_INT and typeof(value) == TYPE_FLOAT:
        var number: float = value
        if is_finite(number) and is_equal_approx(number, round(number)):
            return decoded(roundi(number))
        return decode_failed(
            "expected int, received %s, which is not a whole number" % str(number)
        )
    if typeof(value) == TYPE_STRING and declared in [TYPE_STRING_NAME, TYPE_NODE_PATH]:
        return decoded(type_convert(value, declared))
    if typeof(value) == TYPE_ARRAY and PACKED_ARRAY_ELEMENTS.has(declared):
        var element: int = PACKED_ARRAY_ELEMENTS[declared]
        for index in (value as Array).size():
            var actual := typeof(value[index])
            if actual == element or (element == TYPE_FLOAT and actual == TYPE_INT):
                continue
            return decode_failed(
                "a %s takes %s elements, but item %d is %s"
                % [type_string(declared), type_string(element), index, type_string(actual)]
            )
        return decoded(type_convert(value, declared))
    return decode_failed(
        (
            "expected %s, received %s%s"
            % [
                type_string(declared),
                type_string(typeof(value)),
                under_the_tag_it_takes(declared, value)
            ]
        )
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

## The three components at `index`, for the numbers a value writes as several vectors in a row.
static func _vector3_at(components: PackedFloat64Array, index: int) -> Vector3:
    return Vector3(components[index], components[index + 1], components[index + 2])

## The four components at `index`, for a Projection's columns.
static func _vector4_at(components: PackedFloat64Array, index: int) -> Vector4:
    return Vector4(
        components[index], components[index + 1], components[index + 2], components[index + 3]
    )

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
