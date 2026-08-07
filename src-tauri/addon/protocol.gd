extends RefCounted

## The protocol shapes both halves of the addon speak.
##
## `plugin.gd` runs inside the editor and `runtime.gd` inside the running game — two processes that
## share no state, and the game cannot load an `EditorPlugin` script. Everything they must encode
## identically lives here instead of being copied into both: a divergence would show up as a value
## the renderer draws two ways depending on where it came from.

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

## Encodes every item of an array-like value.
static func encode_items(value: Variant) -> Array:
    var encoded: Array = []
    for item in value:
        encoded.append(encode(item))
    return encoded

## Encodes a Variant as a tagged protocol value, the mirror of `plugin.gd`'s `_decode_value`. A
## reference to an object — a node, a resource without a path, anything live — is described rather
## than encoded, and anything else becomes `opaque`; those tags are read-only, because nothing on
## the far side can rebuild what they point at.
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
