//! Acceptance coverage for the whole 2D/UI node surface, against the real addon in a real editor.
//!
//! The other acceptance modules prove one authoring path with one or two node types. This one
//! sweeps the catalogue: every node class the project claims to support, created through
//! `node.create`, saved, and read back off disk. `protocol/godot-nodes.json` is the list, generated
//! from `ClassDB` inside the pinned editor rather than written by hand — see that file's own note.
//!
//! The sweep reports every class that failed rather than stopping at the first, so one run says how
//! much of the surface actually works rather than naming a single class per run.

use crate::godot_editor_harness::Session;
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

/// A rename onto a name a sibling already has says why the name it got is different.
///
/// Godot does not refuse a clash: a node's name is unique among its siblings, so it appends a
/// number and carries on. The read-back then disagrees with the write, and two live turns in one
/// run were told only that the write asked for `UI` and Godot holds `UI2` — the mismatch, and not
/// the reason for it.
#[test]
fn a_rename_onto_a_siblings_name_says_that_is_what_happened() {
    let mut session = Session::start();
    session.mutate(
        "scene.create",
        json!({"path": "res://clash.tscn", "rootType": "Node2D"}),
    );
    for name in ["Twin", "Other"] {
        session.mutate(
            "node.create",
            json!({"parent": "/clash", "type": "Node2D", "name": name}),
        );
    }

    let clashed = session
        .try_mutate(
            "node.rename",
            json!({"node": "/clash/Other", "name": "Twin"}),
        )
        .expect_err("a name a sibling already holds cannot be written");
    assert!(
        clashed.contains("A sibling is already called Twin"),
        "the refusal has to say why the name changed: {clashed}"
    );

    // And the refusal is true about the scene. Godot renames anyway — it does not refuse a clash —
    // so before this the node kept a name nobody asked for, and the revision never moved to say so.
    let after: Vec<String> = session.call("scene.get_tree", json!({}))["root"]["children"]
        .as_array()
        .expect("children")
        .iter()
        .map(|child| child["name"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(
        after,
        vec!["Twin".to_owned(), "Other".to_owned()],
        "{after:?}"
    );

    // A rename to a name nobody has is not this, and goes through.
    let renamed = session.mutate(
        "node.rename",
        json!({"node": "/clash/Other", "name": "Third"}),
    );
    assert_eq!(renamed["node"], "/clash/Third", "{renamed}");
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
    let defaulted: Vec<&str> = inspected["atClassDefault"]
        .as_array()
        .unwrap_or_else(|| panic!("node.inspect answered without atClassDefault: {inspected}"))
        .iter()
        .filter_map(Value::as_str)
        .collect();

    // A property the class has no default for is answered with its value, whether or not it holds
    // one: `ClassDB` knows nothing about a texture that was never assigned.
    assert!(
        named.contains(&"texture"),
        "node.inspect must report texture, answered {named:?}"
    );

    // A fresh sprite sits at the origin and is unmodulated, so both of those are the class's own
    // answer restated. They are named rather than valued.
    for shipped in ["position", "modulate"] {
        assert!(
            defaulted.contains(&shipped) && !named.contains(&shipped),
            "{shipped} is at its class default and must be named, not valued: {inspected}"
        );
    }

    // And naming one answers it in full. This is the whole of what makes the narrowing safe.
    let asked = session.call(
        "node.inspect",
        json!({"node": "/read/Sprite", "properties": ["position", "modulate"]}),
    );
    let answered: Vec<&str> = asked["properties"]
        .as_array()
        .unwrap_or_else(|| panic!("an inspect that named two properties answered none: {asked}"))
        .iter()
        .filter_map(|property| property["name"].as_str())
        .collect();
    let mut answered = answered;
    answered.sort_unstable();
    assert_eq!(answered, vec!["modulate", "position"], "{asked}");
    assert!(
        asked["properties"]
            .as_array()
            .expect("two properties")
            .iter()
            .all(|property| property["value"]["type"].is_string()),
        "{asked}"
    );
}

/// Inspecting three named properties answers with three, and with nothing else.
///
/// A Label answers with 119 properties. One such answer was 15 885 characters — 81% of everything
/// twelve tool calls of a live turn returned — and in that same turn the model read the running
/// game's copy of the same node through `runtime.inspect_node` for 300 characters, because only
/// that one took a list of names. An earlier turn asked `node.inspect` for
/// `["text", "position", "size"]` by hand and was refused. This is that list, on the editor side.
#[test]
fn a_node_answers_with_only_the_properties_that_were_named() {
    let mut session = Session::start();
    session.mutate(
        "scene.create",
        json!({"path": "res://narrow.tscn", "rootType": "Node2D"}),
    );
    session.mutate(
        "node.create",
        json!({"parent": "/narrow", "name": "Caption", "type": "Label"}),
    );

    let whole = session.call("node.inspect", json!({"node": "/narrow/Caption"}));
    let all = whole["properties"]
        .as_array()
        .unwrap_or_else(|| panic!("node.inspect answered without any properties: {whole}"))
        .len();
    let defaulted = whole["atClassDefault"]
        .as_array()
        .unwrap_or_else(|| panic!("node.inspect answered without atClassDefault: {whole}"))
        .len();
    // A Label declares 119 of them here. What comes back with a value is what a caller could not
    // have known; the rest are named. Both halves are asserted, because the answer is only cheap
    // if the names are still there to ask for.
    assert!(
        all > 8 && all < 40,
        "answered {all} valued properties: {whole}"
    );
    assert!(defaulted > 60, "answered {defaulted} names: {whole}");
    assert!(all + defaulted > 100, "{all} + {defaulted}: {whole}");

    let narrowed = session.call(
        "node.inspect",
        json!({"node": "/narrow/Caption", "properties": ["text", "position", "size"]}),
    );
    let mut named: Vec<&str> = narrowed["properties"]
        .as_array()
        .unwrap_or_else(|| panic!("a narrowed inspect answered without properties: {narrowed}"))
        .iter()
        .filter_map(|property| property["name"].as_str())
        .collect();
    named.sort_unstable();
    assert_eq!(
        named,
        vec!["position", "size", "text"],
        "a narrowed inspect must answer with exactly the names it was given"
    );
    // Everything a caller reads a node for besides its properties is still there, so narrowing is
    // not a second, poorer operation the caller has to choose between.
    assert_eq!(narrowed["type"], "Label", "{narrowed}");
    assert!(
        narrowed["signals"]
            .as_array()
            .is_some_and(|signals| !signals.is_empty()),
        "a narrowed inspect must still report the signals: {narrowed}"
    );

    // `script` is the one name the whole list leaves out, because it is the node's own script
    // rather than a property of it. A caller that names it has answered that objection — and a
    // live turn asked a narrowed inspect for it on its first try and was told, of a node that
    // plainly has one, `has no property script. Did you mean script?`.
    let scripted = session.call(
        "node.inspect",
        json!({"node": "/narrow/Caption", "properties": ["script", "text"]}),
    );
    let mut both: Vec<&str> = scripted["properties"]
        .as_array()
        .unwrap_or_else(|| panic!("a narrowed inspect answered without properties: {scripted}"))
        .iter()
        .filter_map(|property| property["name"].as_str())
        .collect();
    both.sort_unstable();
    assert_eq!(
        both,
        vec!["script", "text"],
        "a named script is answered: {scripted}"
    );
    // And it is still left out of the list nobody narrowed.
    assert!(
        !whole["properties"]
            .as_array()
            .is_some_and(|all| all.iter().any(|one| one["name"] == "script")),
        "an inspect that names nothing must still leave `script` out"
    );

    // A property the inspector shows under another name is answered when it is asked for. Godot
    // registers `global_position` and friends with no usage flags at all, so the list nobody
    // narrowed leaves them out — and the narrowed list used to refuse them, about properties
    // `set_property` writes perfectly well, pointing at `node.inspect` as the way to see them.
    let computed = session.call(
        "node.inspect",
        json!({"node": "/narrow/Caption", "properties": ["global_position"]}),
    );
    assert_eq!(
        computed["properties"][0]["name"], "global_position",
        "a named property is answered whatever the inspector would do with it: {computed}"
    );
    // The two operations have to agree about what a node has.
    session.mutate(
        "node.set_property",
        json!({"node": "/narrow/Caption", "property": "global_position",
               "value": {"type": "vector2", "value": [10, 20]}}),
    );

    // A name the node does not have is refused, rather than left as a gap the caller reads as
    // "this node holds no value for it". Near enough to a real one and it is corrected; not near
    // enough and it is pointed at the call that lists them all — the rule `_nearest_property`
    // already applies to a property that is written rather than read.
    let corrected = session.error(
        "node.inspect",
        json!({"node": "/narrow/Caption", "properties": ["posit"]}),
        None,
    );
    assert!(
        corrected.contains("posit") && corrected.contains("position"),
        "a property one prefix short must be refused and corrected, said: {corrected}"
    );
    // `postion` is a transposition, so nothing is a prefix of anything and there is no correction
    // to give. What it gets instead is the call that would have answered it.
    let refused = session.error(
        "node.inspect",
        json!({"node": "/narrow/Caption", "properties": ["postion"]}),
        None,
    );
    assert!(
        refused.contains("postion") && refused.contains("node.inspect lists every property"),
        "a property nothing is near must be refused and pointed somewhere, said: {refused}"
    );
}

/// A handler written after the editor loaded the script can still be connected to.
///
/// Every live turn writes the method and then connects the signal to it, so by the time
/// `node.connect_signal` checks, the file on disk is ahead of the script the editor loaded — and
/// `has_method` reads the loaded one. One turn wrote `_on_score_timer_timeout` into `player.gd`,
/// rescanned, saved the scene and reloaded it, and was told three times running that the node's
/// script declares only `_process`. The third refusal tripped the repeated-call guard, and the
/// connection was abandoned and hand-wired in code instead.
#[test]
fn a_handler_written_after_the_script_was_loaded_can_still_be_connected() {
    let directory = tempfile::TempDir::new().expect("temporary directory");
    let worktree = crate::godot_editor_harness::fixture_worktree(&directory);
    std::fs::write(
        worktree.join("player.gd"),
        "extends Node2D\n\n\nfunc _process(_delta: float) -> void:\n\tpass\n",
    )
    .expect("write the script");
    let ledger = directory.path().join("ledger.json");
    let mut session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    session.mutate(
        "scene.create",
        json!({"path": "res://stale.tscn", "rootType": "Node2D"}),
    );
    session.mutate(
        "node.create",
        json!({"parent": "/stale", "name": "Player", "type": "Node2D"}),
    );
    session.mutate(
        "node.set_property",
        json!({"node": "/stale/Player", "property": "script",
               "value": {"type": "resource", "value": {"path": "res://player.gd"}}}),
    );
    session.mutate(
        "node.create",
        json!({"parent": "/stale", "name": "Ticker", "type": "Timer"}),
    );

    std::fs::write(
        worktree.join("player.gd"),
        "extends Node2D\n\n\nfunc _process(_delta: float) -> void:\n\tpass\n\n\n\
         func _on_ticker_timeout() -> void:\n\tpass\n",
    )
    .expect("rewrite the script");

    session.mutate(
        "node.connect_signal",
        json!({"node": "/stale/Ticker", "signal": "timeout", "method": "_on_ticker_timeout",
               "target": "/stale/Player"}),
    );

    // And a method that is on neither copy is still refused, so the re-read is not a way past the
    // check that stops a connection whose handler nobody wrote.
    let refused = session.error(
        "node.connect_signal",
        json!({"node": "/stale/Ticker", "signal": "timeout", "method": "_on_nothing",
               "target": "/stale/Player"}),
        Some(session.revision()),
    );
    assert!(
        refused.contains("_on_nothing") && refused.contains("_on_ticker_timeout"),
        "a method nobody wrote is still refused, and the ones there are named: {refused}"
    );
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
