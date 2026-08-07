//! Acceptance coverage for the whole 2D/UI node surface, against the real addon in a real editor.
//!
//! The other acceptance modules prove one authoring path with one or two node types. This one
//! sweeps the catalogue: every node class the project claims to support, created through
//! `node.create`, saved, and read back off disk. `protocol/godot-nodes.json` is the list, generated
//! from `ClassDB` inside the pinned editor rather than written by hand — see `nodelist.md`.
//!
//! The sweep reports every class that failed rather than stopping at the first, so one run says how
//! much of the surface actually works rather than naming a single class per run.

use crate::godot_addon_acceptance::Session;
use serde_json::{Value, json};

/// The node catalogue, pinned. A Godot upgrade that adds or removes a class shows up as a diff on
/// this file rather than as silently changed coverage.
const CATALOG: &str = include_str!("../../protocol/godot-nodes.json");

fn catalog() -> Value {
    serde_json::from_str(CATALOG).expect("parse the node catalogue")
}

fn names(field: &str) -> Vec<String> {
    catalog()[field]
        .as_array()
        .unwrap_or_else(|| panic!("{field} must be an array"))
        .iter()
        .map(|entry| entry.as_str().expect("class name").to_owned())
        .collect()
}

/// Every class the catalogue says can be instantiated, minus the ones it records as broken. The
/// broken pair get their own test, so this sweep stays a clean pass/fail on the rest.
fn creatable() -> Vec<String> {
    let broken = catalog()["knownBroken"].clone();
    names("creatable")
        .into_iter()
        .filter(|class| broken.get(class).is_none())
        .collect()
}

/// Reports every failure at once. A sweep that panics on the first refusal tells you one class name
/// per run, and there are 131 of them.
fn report(what: &str, failures: &[String]) {
    assert!(
        failures.is_empty(),
        "{} of them failed to {what}:\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
}

/// Every supported node can be created, saved, and found in the file afterwards.
///
/// `node.create` reaches `ClassDB.instantiate` and refuses only `MissingNode`, so this is less about
/// whether the addon knows each type and more about whether each type survives the round trip the
/// editor puts it through: attached under a root it does not expect, owned, packed, and written as
/// text.
#[test]
fn every_supported_node_is_created_and_survives_a_save() {
    let mut session = Session::start();
    let scene = "res://nodes.tscn";
    session.mutate("scene.create", json!({"path": scene, "rootType": "Node2D"}));

    let classes = creatable();
    let mut refused = Vec::new();
    for class in &classes {
        if let Err(error) = session.try_mutate(
            "node.create",
            json!({"parent": "/nodes", "name": class, "type": class}),
        ) {
            refused.push(format!("{class}: {error}"));
        }
    }
    report("be created", &refused);

    session.mutate("scene.save", json!({}));
    let saved = std::fs::read_to_string(session.worktree.join("nodes.tscn"))
        .expect("the swept scene must exist on disk");

    let mut missing = Vec::new();
    for class in &classes {
        // The type is what a `.tscn` records; a node that saved without one is a node the loader
        // will drop the next time the scene is opened.
        if !saved.contains(&format!("type=\"{class}\"")) {
            missing.push(class.clone());
        }
    }
    report("survive the save", &missing);
}

/// A saved sweep opens again with every node still in it.
///
/// Saving is not the same as surviving: a node can be written into the file and still be discarded
/// on load, which is what `MissingNode` does. Reopening is the only check that catches that.
#[test]
fn a_swept_scene_reopens_with_every_node_intact() {
    let mut session = Session::start();
    let scene = "res://reopen.tscn";
    session.mutate("scene.create", json!({"path": scene, "rootType": "Node2D"}));

    let classes = creatable();
    for class in &classes {
        let _ = session.try_mutate(
            "node.create",
            json!({"parent": "/reopen", "name": class, "type": class}),
        );
    }
    session.mutate("scene.save", json!({}));

    // Away and back, so the tree comes from the file rather than from what the editor still holds.
    session.mutate(
        "scene.create",
        json!({"path": "res://elsewhere.tscn", "rootType": "Node2D"}),
    );
    session.open_scene(scene);

    let tree = session.call("scene.get_tree", json!({}));
    let present: Vec<String> = tree["root"]["children"]
        .as_array()
        .expect("children array")
        .iter()
        .map(|child| child["type"].as_str().unwrap_or_default().to_owned())
        .collect();

    let lost: Vec<String> = classes
        .iter()
        .filter(|class| !present.contains(class))
        .cloned()
        .collect();
    report("come back after a reopen", &lost);
}

/// A node's properties can be read back.
///
/// `node.inspect` once answered name, type, path, groups, signals and connections and no properties
/// at all, so the AI could set `position` and never ask what `position` was: every edit written
/// blind, and nothing about a scene it did not author knowable. `texture` is here on purpose — an
/// unset object property is the one the encoder used to crash on.
#[test]
fn a_node_reports_its_property_values() {
    let mut session = Session::start();
    session.mutate(
        "scene.create",
        json!({"path": "res://read.tscn", "rootType": "Node2D"}),
    );
    session.mutate(
        "node.create",
        json!({"parent": "/read", "name": "Sprite", "type": "Sprite2D"}),
    );

    let inspected = session.call("node.inspect", json!({"node": "/read/Sprite"}));
    let properties = inspected["properties"].as_array().unwrap_or_else(|| {
        panic!("node.inspect answered without any properties: {inspected}");
    });

    let named: Vec<&str> = properties
        .iter()
        .filter_map(|property| property["name"].as_str())
        .collect();
    for wanted in ["position", "texture", "modulate"] {
        assert!(
            named.contains(&wanted),
            "node.inspect must report {wanted}, answered {named:?}"
        );
    }
}

/// The properties an AI reaches for first can be written, on every family of node.
///
/// `Control.position` and `Control.size` and every `theme_override_*` carry no storage flag — the
/// scene saves anchors and offsets instead — so anything that enumerates only stored properties
/// hides exactly what laying out and styling a UI needs. They are written here by name to prove the
/// write path does not care.
#[test]
fn the_properties_an_ai_reaches_for_can_be_written() {
    let mut session = Session::start();
    let scene = "res://props.tscn";
    session.mutate("scene.create", json!({"path": scene, "rootType": "Node2D"}));

    let writes: [(&str, &str, &str, Value); 7] = [
        (
            "Sprite2D",
            "Sprite",
            "position",
            json!({"type": "vector2", "value": [12, 34]}),
        ),
        (
            "Label",
            "Text",
            "text",
            json!({"type": "string", "value": "hello"}),
        ),
        (
            "Label",
            "Text",
            "size",
            json!({"type": "vector2", "value": [200, 50]}),
        ),
        (
            "Label",
            "Text",
            "theme_override_colors/font_color",
            json!({"type": "color", "value": [1, 0, 0, 1]}),
        ),
        (
            "Label",
            "Text",
            "theme_override_font_sizes/font_size",
            json!({"type": "int", "value": 42}),
        ),
        (
            "Button",
            "Press",
            "disabled",
            json!({"type": "bool", "value": true}),
        ),
        (
            "TileMapLayer",
            "Terrain",
            "y_sort_origin",
            json!({"type": "int", "value": 8}),
        ),
    ];

    for (class, name, _, _) in &writes {
        let _ = session.try_mutate(
            "node.create",
            json!({"parent": "/props", "name": name, "type": class}),
        );
    }

    let mut refused = Vec::new();
    for (class, name, property, value) in writes {
        if let Err(error) = session.try_mutate(
            "node.set_property",
            json!({"node": format!("/props/{name}"), "property": property, "value": value}),
        ) {
            refused.push(format!("{class}.{property}: {error}"));
        }
    }
    report("be written", &refused);

    session.mutate("scene.save", json!({}));
    let saved = std::fs::read_to_string(session.worktree.join("props.tscn"))
        .expect("the property scene must exist on disk");
    for written in [
        "position = Vector2(12, 34)",
        "text = \"hello\"",
        "theme_override_colors/font_color = Color(1, 0, 0, 1)",
        "theme_override_font_sizes/font_size = 42",
        "disabled = true",
    ] {
        assert!(
            saved.contains(written),
            "{written} is missing from:\n{saved}"
        );
    }
}

/// A resource property can be given a resource.
///
/// `node.set_property` resolves a resource by loading the path it is handed, so a property can only
/// be filled from a file that already exists — and the addon can create exactly one kind of
/// resource, a tileset. There is no way to give a `CollisionShape2D` a shape or a `Button` a
/// stylebox, which is most of what makes those nodes worth creating. This test fails until there is.
#[test]
fn a_shape_can_be_given_to_a_collision_shape() {
    let mut session = Session::start();
    session.mutate(
        "scene.create",
        json!({"path": "res://shape.tscn", "rootType": "Node2D"}),
    );
    session.mutate(
        "node.create",
        json!({"parent": "/shape", "name": "Body", "type": "StaticBody2D"}),
    );
    session.mutate(
        "node.create",
        json!({"parent": "/shape/Body", "name": "Hitbox", "type": "CollisionShape2D"}),
    );

    let made = session.try_call(
        "resource.create_shape",
        json!({"path": "res://hitbox.tres", "shapeType": "RectangleShape2D", "size": [32, 48]}),
        None,
    );
    assert!(
        made.is_ok(),
        "nothing can create a shape resource, so a CollisionShape2D can never be filled: {}",
        made.unwrap_err()
    );

    session.mutate(
        "node.set_property",
        json!({
            "node": "/shape/Body/Hitbox",
            "property": "shape",
            "value": {"type": "resource", "value": {"path": "res://hitbox.tres"}}
        }),
    );
    session.mutate("scene.save", json!({}));
    let saved = std::fs::read_to_string(session.worktree.join("shape.tscn"))
        .expect("the shape scene must exist on disk");
    assert!(saved.contains("hitbox.tres"), "{saved}");
}

/// The two classes the catalogue records as broken, asserted as they ought to behave.
///
/// `MissingNode` is the engine's placeholder for a type it could not find. Created deliberately it
/// remembers nothing, saves with no type at all, and is dropped the next time the scene opens — so
/// `node.create` should refuse it rather than hand back a node that quietly disappears.
///
/// `TileMap` is deprecated but still opens in existing projects, and the cell commands reject it,
/// so a level already built on one cannot be read or painted at all.
#[test]
fn the_known_broken_classes_behave() {
    let mut session = Session::start();
    session.mutate(
        "scene.create",
        json!({"path": "res://broken.tscn", "rootType": "Node2D"}),
    );

    let missing = session.try_mutate(
        "node.create",
        json!({"parent": "/broken", "name": "Ghost", "type": "MissingNode"}),
    );
    assert!(
        missing.is_err(),
        "node.create accepted MissingNode, which saves with no type and vanishes on the next open"
    );

    session.mutate(
        "node.create",
        json!({"parent": "/broken", "name": "Legacy", "type": "TileMap"}),
    );
    let refusal = session
        .try_call("node.get_cells", json!({"node": "/broken/Legacy"}), None)
        .expect_err("node.get_cells must refuse a TileMap");
    assert!(
        refusal.contains("TileMapLayer"),
        "the refusal has to name what to use instead, answered: {refusal}"
    );
}
