# Godot node support — the 2D/UI surface

Every node class Gofer commits to supporting, taken from the real `ClassDB` of the pinned engine
(`godot --version` → `4.7.1.stable.official.a13da4feb`), not from documentation.

Of the 284 `Node` subclasses the engine registers, **142 are in scope** and 121 are excluded as 3D,
20 as editor-internal, 1 (`NavigationAgent3D`) as 3D despite deriving straight from `Node`. Eleven
of the 142 are abstract — they are inherited from, never instantiated — leaving **131 creatable
types**.

`_node_create` in `src-tauri/addon/plugin.gd:2128` calls `ClassDB.instantiate(node_type)`, and the
only type it refuses is `MissingNode`. All 130 others create, undo, save, reopen, and report their
properties — proven for every one of them by `godot_nodes_acceptance`, which sweeps this list
through a real editor. `protocol/godot-nodes.json` is the same list in the form that test reads.

This file is a _scope contract_: it names what the property inspector, the type-checked value
tagging, the agent's guidance, and the acceptance scenes are expected to handle, and what may be
left to fail loudly.

`*` marks an abstract class.

## Generic — no transform, no drawing

Nodes that hang anywhere in the tree.

```
Node
├─ AnimationMixer *
│  ├─ AnimationPlayer
│  └─ AnimationTree
├─ AudioStreamPlayer
├─ CanvasLayer
│  └─ ParallaxBackground
├─ HTTPRequest
├─ InstancePlaceholder *
├─ MissingNode
├─ MultiplayerSpawner
├─ MultiplayerSynchronizer
├─ NavigationAgent2D
├─ ResourcePreloader
├─ ShaderGlobalsOverride
├─ StatusIndicator
├─ Timer
└─ WorldEnvironment
```

`MissingNode` and `InstancePlaceholder` are the engine's own placeholders — they appear when a scene
references a type or file that is not there. The inspector has to survive meeting them; the agent
must never be told to create one. `MissingNode` is **refused by `node.create`**: verified, a fresh
one saves into the `.tscn` with no `type=` at all, which the loader reads as "a node inherited from
a base scene", finds no base scene, and drops — the child is gone on the next open, with the warning
`Node './Probe' was modified from inside an instance, but it has vanished.`

## 2D — `CanvasItem` → `Node2D`

```
CanvasItem *
└─ Node2D
   ├─ AnimatedSprite2D
   ├─ AudioListener2D
   ├─ AudioStreamPlayer2D
   ├─ BackBufferCopy
   ├─ Bone2D
   ├─ Camera2D
   ├─ CanvasGroup
   ├─ CanvasModulate
   ├─ CollisionObject2D *
   │  ├─ Area2D
   │  └─ PhysicsBody2D *
   │     ├─ CharacterBody2D
   │     ├─ RigidBody2D
   │     │  └─ PhysicalBone2D
   │     └─ StaticBody2D
   │        └─ AnimatableBody2D
   ├─ CollisionPolygon2D
   ├─ CollisionShape2D
   ├─ CPUParticles2D
   ├─ GPUParticles2D
   ├─ Joint2D *
   │  ├─ DampedSpringJoint2D
   │  ├─ GrooveJoint2D
   │  └─ PinJoint2D
   ├─ Light2D *
   │  ├─ DirectionalLight2D
   │  └─ PointLight2D
   ├─ LightOccluder2D
   ├─ Line2D
   ├─ Marker2D
   ├─ MeshInstance2D
   ├─ MultiMeshInstance2D
   ├─ NavigationLink2D
   ├─ NavigationObstacle2D
   ├─ NavigationRegion2D
   ├─ Parallax2D
   ├─ ParallaxLayer
   ├─ Path2D
   ├─ PathFollow2D
   ├─ Polygon2D
   ├─ RayCast2D
   ├─ RemoteTransform2D
   ├─ ShapeCast2D
   ├─ Skeleton2D
   ├─ Sprite2D
   ├─ TileMap
   ├─ TileMapLayer
   ├─ TouchScreenButton
   └─ VisibleOnScreenNotifier2D
      └─ VisibleOnScreenEnabler2D
```

`TileMap` is deprecated in favour of one `TileMapLayer` per layer, and it is **create-only here**.
Verified: it instantiates, packs, saves and reloads with its class intact, exactly like every other
node — but `node.set_cells` and `node.get_cells` reject it at `plugin.gd:2703`, the addon's only
type gate. So a `TileMap` can be built and saved and never painted or read back. It stays on this
list because projects open with it; the agent authors `TileMapLayer`.

## UI — `CanvasItem` → `Control`

```
Control
├─ BaseButton
│  ├─ Button
│  │  ├─ CheckBox
│  │  ├─ CheckButton
│  │  ├─ ColorPickerButton
│  │  ├─ MenuButton
│  │  └─ OptionButton
│  ├─ LinkButton
│  └─ TextureButton
├─ ColorRect
├─ Container
│  ├─ AspectRatioContainer
│  ├─ BoxContainer
│  │  ├─ HBoxContainer
│  │  └─ VBoxContainer
│  │     └─ ColorPicker
│  ├─ CenterContainer
│  ├─ FlowContainer
│  │  ├─ HFlowContainer
│  │  └─ VFlowContainer
│  ├─ FoldableContainer
│  ├─ GraphElement
│  │  ├─ GraphFrame
│  │  └─ GraphNode
│  ├─ GridContainer
│  ├─ MarginContainer
│  ├─ PanelContainer
│  ├─ ScrollContainer
│  ├─ SplitContainer
│  │  ├─ HSplitContainer
│  │  └─ VSplitContainer
│  ├─ SubViewportContainer
│  └─ TabContainer
├─ GraphEdit
├─ ItemList
├─ Label
├─ LineEdit
├─ MenuBar
├─ NinePatchRect
├─ Panel
├─ Range
│  ├─ ProgressBar
│  ├─ ScrollBar *
│  │  ├─ HScrollBar
│  │  └─ VScrollBar
│  ├─ Slider *
│  │  ├─ HSlider
│  │  └─ VSlider
│  ├─ SpinBox
│  └─ TextureProgressBar
├─ ReferenceRect
├─ RichTextLabel
├─ Separator *
│  ├─ HSeparator
│  └─ VSeparator
├─ TabBar
├─ TextEdit
│  └─ CodeEdit
├─ TextureRect
├─ Tree
├─ VideoStreamPlayer
└─ VirtualJoystick
```

`VirtualJoystick` is new in 4.7 and has no counterpart in older engines — anything that assumes a
node list from 4.4 or earlier will miss it.

## Viewports and windows

```
Viewport *
├─ SubViewport
└─ Window
   ├─ AcceptDialog
   │  └─ ConfirmationDialog
   │     └─ FileDialog
   └─ Popup
      ├─ PopupMenu
      └─ PopupPanel
```

`Window` and its dialogs are `Viewport`s, not `Control`s. Anything that treats "has a rect" as "is a
Control" is wrong about all eight of these.

## What is deliberately out

- **The whole `Node3D` subtree, 121 classes.** Meshes, 3D physics and joints, 3D lights, CSG,
  `GridMap`, skeleton modifiers and IK, particle attractors and collision, XR and OpenXR,
  `NavigationAgent3D`.
- **Editor-internal classes, 20.** `EditorPlugin`, `EditorDock`, `EditorInspector`,
  `EditorProperty`, `EditorFileDialog`, `ScriptEditor`, `FileSystemDock` and the rest. All abstract,
  none placeable in a user scene. The addon _extends_ `EditorPlugin`; that is authorship of the
  tool, not a node the tool offers.

Excluding them is a scope decision, not an engine limit: `ClassDB` will still instantiate a
`MeshInstance3D` if the agent asks for one. If refusing 3D is meant to be enforced rather than
merely undocumented, `_node_create` is the one place to enforce it.

## How to regenerate

The list came from `ClassDB` inside the pinned engine, so it can be rebuilt exactly rather than
hand-maintained:

```gdscript
extends SceneTree

func _initialize() -> void:
	for c in ClassDB.get_class_list():
		if ClassDB.is_parent_class(c, "Node"):
			print("%s|%s|%s" % [c, ClassDB.get_parent_class(c),
				"abstract" if not ClassDB.can_instantiate(c) else "concrete"])
	quit()
```

Run with `godot --headless --path <any project> --script dump.gd`, then drop the `Node3D` subtree,
`NavigationAgent3D`, and the editor-internal classes.
