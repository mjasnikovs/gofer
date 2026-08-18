//! Every mutating command, held to what Godot holds afterwards.
//!
//! A mutating command used to answer from its own bookkeeping: `saved: true` came back for a
//! project setting Godot never took, and a node reported created was one the scene did not keep. The
//! addon now ends every mutation by asking the engine for the thing it named — the setting, the
//! node, the file — and refuses to report success when the answer disagrees.
//!
//! These tests are the other half of that. Each one drives a mutating command and then reads the
//! same thing back by a route the command does not control: the sibling read command, the tree, or
//! the bytes on disk. A command whose write is skipped cannot pass one, because its own read-back
//! turns the reply into a `readback_mismatch` error and the call fails outright.
//!
//! They are grouped by the state they touch rather than one test per command, because each test
//! boots a real editor and the suite is a pre-commit gate. Every command still carries its own
//! assertion.

use crate::godot_editor_harness::{Session, fixture_worktree};
use serde_json::{Value, json};
use tempfile::TempDir;

/// The live fixture's own art: a real 8x2 atlas of 16x16 tiles.
const ATLAS: &[u8] = include_bytes!("../../fixtures/live-project/assets/tiles.png");

/// The named entry of a list command's array, by its `name` field.
fn named<'a>(result: &'a Value, field: &str, name: &str) -> Option<&'a Value> {
    result[field]
        .as_array()
        .unwrap_or_else(|| panic!("{field} must be an array in {result}"))
        .iter()
        .find(|entry| entry["name"] == name)
}

/// Every node path the tree holds, flattened, so a test can ask whether one is there.
fn paths(tree: &Value) -> Vec<String> {
    let mut found = Vec::new();
    let mut pending = vec![tree["root"].clone()];
    while let Some(node) = pending.pop() {
        if node.is_null() {
            continue;
        }
        if let Some(path) = node["path"].as_str() {
            found.push(path.to_owned());
        }
        if let Some(children) = node["children"].as_array() {
            pending.extend(children.iter().cloned());
        }
    }
    found
}

/// The four scene commands answer from the file they wrote, not from the write they attempted.
///
/// `EditorInterface.save_scene` returns OK for a save that put nothing on disk, which is how a
/// session reported `dirty: false` about a file that was minutes old. The addon now loads the saved
/// scene back — cache ignored — and compares it node for node against the tree the editor is
/// editing, so each of these calls succeeding is itself the assertion that the file matches.
#[test]
fn every_scene_command_answers_from_the_file_it_wrote() {
    let mut session = Session::start();

    // create: the file has to exist and hold the root that was asked for, under the name asked for.
    let created = session.mutate(
        "scene.create",
        json!({"path": "res://readback.tscn", "rootType": "Node2D", "rootName": "Level"}),
    );
    assert_eq!(created["scene"], "res://readback.tscn");
    let written = std::fs::read_to_string(session.worktree.join("readback.tscn"))
        .expect("scene.create must leave the file on disk");
    assert!(
        written.contains("[node name=\"Level\" type=\"Node2D\""),
        "the created file must hold the root that was asked for:\n{written}"
    );
    assert_eq!(
        session.call("scene.get_tree", json!({}))["root"]["name"],
        "Level",
        "the editor must be editing the scene that was created"
    );

    // save: the node made since the create has to be in the file afterwards.
    session.mutate(
        "node.create",
        json!({"parent": "/Level", "name": "Marker", "type": "Marker2D"}),
    );
    let saved = session.mutate("scene.save", json!({}));
    assert_eq!(saved["dirty"], false);
    let on_disk = std::fs::read_to_string(session.worktree.join("readback.tscn"))
        .expect("scene.save must leave the file on disk");
    assert!(
        on_disk.contains("name=\"Marker\""),
        "scene.save answered clean about a file without the node:\n{on_disk}"
    );

    // save_as: the new file holds the tree, and the editor now says it is editing that file.
    let elsewhere = session.mutate("scene.save_as", json!({"path": "res://elsewhere.tscn"}));
    assert_eq!(
        elsewhere["scene"], "res://elsewhere.tscn",
        "save_as reports the file the editor now owns"
    );
    assert_eq!(
        session.call("session.get_state", json!({}))["scene"],
        "res://elsewhere.tscn"
    );
    let moved = std::fs::read_to_string(session.worktree.join("elsewhere.tscn"))
        .expect("scene.save_as must leave the file on disk");
    assert!(moved.contains("name=\"Marker\""), "{moved}");

    // reload: a node that was never saved is gone, because the tree came off the disk again.
    session.mutate(
        "node.create",
        json!({"parent": "/Level", "name": "Unsaved", "type": "Marker2D"}),
    );
    session.mutate("scene.reload", json!({}));
    let reloaded = paths(&session.call("scene.get_tree", json!({})));
    assert!(
        reloaded.contains(&"/Level/Marker".to_owned()),
        "reload must bring back what the file holds: {reloaded:?}"
    );
    assert!(
        !reloaded.contains(&"/Level/Unsaved".to_owned()),
        "reload must drop what the file never had: {reloaded:?}"
    );
}

/// The eleven node commands answer from the edited tree, not from the node object they hold.
///
/// A node the editor refused to attach is still a live object with the right name and type, so a
/// reply built from it describes a node the scene does not have — and a node the root does not own
/// is left out of the file entirely on the next save. Each command is checked here against
/// `scene.get_tree` and `node.inspect`, which read the tree rather than the command's own variables.
#[test]
fn every_node_command_answers_from_the_edited_tree() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    std::fs::write(
        worktree.join("readback.gd"),
        "extends Node2D\n\n\nfunc _on_coin_body_entered(_body: Node2D) -> void:\n\tpass\n",
    )
    .expect("write the handler script");
    let ledger = directory.path().join("ledger.json");
    let mut session = Session::start_on_worktree(worktree, ledger, Some(directory));

    // A saved scene to place instances of.
    session.mutate(
        "scene.create",
        json!({"path": "res://coin.tscn", "rootType": "Area2D", "rootName": "Coin"}),
    );
    session.mutate(
        "scene.create",
        json!({"path": "res://tree.tscn", "rootType": "Node2D", "rootName": "Stage"}),
    );

    // create
    let made = session.mutate(
        "node.create",
        json!({"parent": "/Stage", "name": "Pickup", "type": "Area2D"}),
    );
    assert_eq!(made["node"], "/Stage/Pickup");
    assert!(
        paths(&session.call("scene.get_tree", json!({}))).contains(&"/Stage/Pickup".to_owned()),
        "a created node the tree does not hold was never created"
    );

    // instantiate
    let placed = session.mutate(
        "node.instantiate",
        json!({"parent": "/Stage", "path": "res://coin.tscn", "name": "Placed"}),
    );
    assert_eq!(placed["node"], "/Stage/Placed");
    assert_eq!(placed["path"], "res://coin.tscn");
    assert_eq!(
        session.call("node.inspect", json!({"node": "/Stage/Placed"}))["type"],
        "Area2D"
    );

    // duplicate
    let copied = session.mutate(
        "node.duplicate",
        json!({"node": "/Stage/Pickup", "name": "Second"}),
    );
    assert_eq!(copied["node"], "/Stage/Second");
    session.call("node.inspect", json!({"node": "/Stage/Second"}));

    // rename
    let renamed = session.mutate(
        "node.rename",
        json!({"node": "/Stage/Second", "name": "Silver"}),
    );
    assert_eq!(renamed["node"], "/Stage/Silver");
    assert_eq!(
        session.call("node.inspect", json!({"node": "/Stage/Silver"}))["name"],
        "Silver"
    );

    // reparent
    session.mutate(
        "node.create",
        json!({"parent": "/Stage", "name": "Holder", "type": "Node2D"}),
    );
    let moved = session.mutate(
        "node.reparent",
        json!({"node": "/Stage/Silver", "newParent": "/Stage/Holder"}),
    );
    assert_eq!(moved["node"], "/Stage/Holder/Silver");
    assert!(
        paths(&session.call("scene.get_tree", json!({})))
            .contains(&"/Stage/Holder/Silver".to_owned())
    );

    // set_property: the reply carries the value the node holds, which is not always the one sent.
    let written = session.mutate(
        "node.set_property",
        json!({
            "node": "/Stage/Holder",
            "property": "position",
            "value": {"type": "vector2", "value": [12, 34]}
        }),
    );
    assert_eq!(
        written["value"],
        json!({"type": "vector2", "value": [12.0, 34.0]}),
        "set_property must answer with what the node now holds"
    );
    let inspected = session.call("node.inspect", json!({"node": "/Stage/Holder"}));
    let position = inspected["properties"]
        .as_array()
        .expect("properties")
        .iter()
        .find(|property| property["name"] == "position")
        .expect("position must be reported");
    assert_eq!(
        position["value"], written["value"],
        "the write and the read have to agree: {inspected}"
    );

    // groups
    let grouped = session.mutate(
        "node.add_to_group",
        json!({"node": "/Stage/Pickup", "group": "coins"}),
    );
    assert_eq!(grouped["groups"], json!(["coins"]));
    assert_eq!(
        session.call("node.inspect", json!({"node": "/Stage/Pickup"}))["groups"],
        json!(["coins"])
    );
    let ungrouped = session.mutate(
        "node.remove_from_group",
        json!({"node": "/Stage/Pickup", "group": "coins"}),
    );
    assert_eq!(ungrouped["groups"], json!([]));
    assert_eq!(
        session.call("node.inspect", json!({"node": "/Stage/Pickup"}))["groups"],
        json!([])
    );

    // signals: the connection has to be one the tree really carries, with the flags it recorded.
    session.mutate(
        "node.set_property",
        json!({
            "node": "/Stage",
            "property": "script",
            "value": {"type": "resource", "value": {"path": "res://readback.gd"}}
        }),
    );
    let connected = session.mutate(
        "node.connect_signal",
        json!({
            "node": "/Stage/Pickup",
            "signal": "body_entered",
            "method": "_on_coin_body_entered"
        }),
    );
    assert_eq!(connected["persistent"], true);
    let wired = session.call("node.inspect", json!({"node": "/Stage/Pickup"}));
    assert_eq!(
        wired["connections"].as_array().expect("connections").len(),
        1,
        "{wired}"
    );
    let cut = session.mutate(
        "node.disconnect_signal",
        json!({
            "node": "/Stage/Pickup",
            "signal": "body_entered",
            "method": "_on_coin_body_entered"
        }),
    );
    assert_eq!(cut["connected"], false);
    assert!(
        session.call("node.inspect", json!({"node": "/Stage/Pickup"}))["connections"]
            .as_array()
            .expect("connections")
            .is_empty()
    );

    // delete
    let deleted = session.mutate("node.delete", json!({"node": "/Stage/Placed"}));
    assert_eq!(deleted["deleted"], true);
    assert!(
        session
            .error("node.inspect", json!({"node": "/Stage/Placed"}), None)
            .starts_with("node_not_found"),
        "a node reported deleted must be gone from the tree"
    );
}

/// Painting and the two resource creators answer from what is on disk and in the layer.
///
/// `set_cell` accepts a tile coordinate no tile occupies and leaves the cell empty, and
/// `ResourceSaver.save` answers OK for a tileset whose collision polygons did not survive. Both are
/// re-read by the addon; here the reply is checked against the commands a caller would use to look.
#[test]
fn cells_and_resources_answer_from_what_they_wrote() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    std::fs::write(worktree.join("tiles.png"), ATLAS).expect("write the atlas");
    let ledger = directory.path().join("ledger.json");
    let mut session = Session::start_on_worktree(worktree, ledger, Some(directory));
    session.call("resource.rescan", json!({}));

    // create_tileset: what the reply says has to be what the saved file holds.
    let built = session.call(
        "resource.create_tileset",
        json!({
            "path": "res://world.tres",
            "texture": "res://tiles.png",
            "tileSize": 16,
            "solid": [[0, 0]]
        }),
    );
    assert_eq!(built["physicsLayers"], 1);
    let described = session.call(
        "resource.describe_tileset",
        json!({"path": "res://world.tres"}),
    );
    assert_eq!(described["tileSize"], built["tileSize"]);
    assert_eq!(described["physicsLayers"], built["physicsLayers"]);
    assert_eq!(
        described["sources"][0]["tiles"]
            .as_array()
            .expect("tiles")
            .iter()
            .filter(|tile| tile["solid"] == json!(true))
            .count(),
        1,
        "the collision the reply claimed has to be in the file: {described}"
    );

    // create_shape: the reply names the class the file loads as, which is what fills a property.
    let shape = session.call(
        "resource.create_shape",
        json!({"path": "res://hitbox.tres", "shapeType": "RectangleShape2D", "size": [32, 48]}),
    );
    assert_eq!(shape["shapeType"], "RectangleShape2D");

    session.mutate(
        "scene.create",
        json!({"path": "res://painted.tscn", "rootType": "Node2D", "rootName": "Level"}),
    );
    session.mutate(
        "node.create",
        json!({"parent": "/Level", "name": "Terrain", "type": "TileMapLayer"}),
    );
    session.mutate(
        "node.set_property",
        json!({
            "node": "/Level/Terrain",
            "property": "tile_set",
            "value": {"type": "resource", "value": {"path": "res://world.tres"}}
        }),
    );

    // set_cells: the tally the paint reports has to be the tally the layer answers.
    let painted = session.mutate(
        "node.set_cells",
        json!({
            "node": "/Level/Terrain",
            "cells": [{"x": 0, "y": 0, "width": 4, "height": 2, "atlas": [0, 0]}]
        }),
    );
    assert_eq!(painted["painted"], 8);
    let read = session.call("node.get_cells", json!({"node": "/Level/Terrain"}));
    assert_eq!(read["cells"], painted["cells"]);
    assert_eq!(read["usedRect"], painted["usedRect"]);
    assert_eq!(
        read["tiles"],
        json!([{"atlas": [0, 0], "count": 8}]),
        "{read}"
    );
}

/// An asset written into a directory the editor has never seen is importable after `rescan` names
/// it.
///
/// The one above writes its atlas beside `project.godot` before the editor boots, so the first
/// import scan already holds the directory and `update_file` has somewhere to put the file. That is
/// not the shape a session takes. A live run building a platformer ran `mkdir -p assets`, generated
/// seven PNGs into it, and rescanned each one; every call answered `scanned: true`, not one sidecar
/// appeared, and `create_tileset` went on saying the texture does not exist — the error that tells
/// the caller to rescan, which is what it had just done seven times. It hand-wrote the `.import`
/// files instead, which only moved the refusal to `unsupported_texture`: with a sidecar beside it
/// the image passes `ResourceLoader.exists` and still loads as nothing, so the failure now blames
/// the picture rather than the missing import.
///
/// `EditorFileSystem.update_file` registers a file in the directory tree the editor already holds,
/// and silently does nothing for one whose directory is not in it. Only a project walk adds a
/// directory, which is why the project-wide branch of `resource.rescan` recovers where the by-path
/// branch never does.
#[test]
fn a_rescan_imports_an_asset_in_a_directory_made_after_the_editor_started() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    // The editor is already up, and neither the directory nor the file was there when it scanned.
    std::fs::create_dir_all(worktree.join("assets")).expect("make the assets directory");
    std::fs::write(worktree.join("assets/late.png"), ATLAS).expect("write the atlas");

    let scanned = session.call("resource.rescan", json!({"path": "res://assets/late.png"}));
    assert_eq!(scanned["scanned"], true, "{scanned}");
    assert!(
        worktree.join("assets/late.png.import").exists(),
        "a rescan that answers `scanned: true` has to have run the importer: no .import was written"
    );

    // The proof that the import is real rather than a file on disk: the texture loads, and the one
    // command that cannot be worked around by hand cuts tiles out of it.
    let built = session.call(
        "resource.create_tileset",
        json!({
            "path": "res://assets/late.tres",
            "texture": "res://assets/late.png",
            "tileSize": 16
        }),
    );
    assert_eq!(built["grid"], json!([8, 2]), "{built}");
}

/// A hand-written `.import` beside an unimported image does not make it a texture.
///
/// This is the second half of the live failure, and it outlives any fix to the first: a caller that
/// writes a sidecar itself — because it was refused, or because it read one somewhere — leaves an
/// image that `ResourceLoader.exists` says yes to and `load` answers nothing for. Whatever the
/// commands do about it, none of them may report success, and the refusal has to be about the
/// import rather than about the image being the wrong kind of file.
#[test]
fn a_hand_written_import_sidecar_is_not_an_imported_texture() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    std::fs::create_dir_all(worktree.join("assets")).expect("make the assets directory");
    std::fs::write(worktree.join("assets/hand.png"), ATLAS).expect("write the atlas");
    std::fs::write(
        worktree.join("assets/hand.png.import"),
        "[remap]\n\nimporter=\"texture\"\ntype=\"CompressedTexture2D\"\n\
         path=\"res://.godot/imported/hand.png-abc123.ctex\"\n\n[deps]\n\n\
         source_file=\"res://assets/hand.png\"\n\
         dest_files=[\"res://.godot/imported/hand.png-abc123.ctex\"]\n",
    )
    .expect("write the hand-rolled sidecar");
    session.call("resource.rescan", json!({"path": "res://assets/hand.png"}));

    let built = session.call(
        "resource.create_tileset",
        json!({
            "path": "res://assets/hand.tres",
            "texture": "res://assets/hand.png",
            "tileSize": 16
        }),
    );
    assert_eq!(
        built["grid"],
        json!([8, 2]),
        "a rescan has to import over a hand-written sidecar rather than trust it: {built}"
    );
}

/// Undo and redo answer from the editor's own history, not from a depth this addon counts.
///
/// `UndoRedo.undo` returns true for an action list it walked without doing anything, so the depths a
/// reply carries mean nothing on their own. The addon reads the history's version across the step;
/// here the reply is checked against the tree the step was supposed to change.
#[test]
fn history_commands_answer_from_the_editors_own_history() {
    let mut session = Session::start();
    session.mutate(
        "scene.create",
        json!({"path": "res://history.tscn", "rootType": "Node2D", "rootName": "Stage"}),
    );
    session.mutate(
        "node.create",
        json!({"parent": "/Stage", "name": "Marker", "type": "Marker2D"}),
    );

    let undone = session.mutate("session.undo", json!({}));
    assert_eq!(undone["undoDepth"], 0);
    assert_eq!(undone["redoDepth"], 1);
    assert!(
        !paths(&session.call("scene.get_tree", json!({}))).contains(&"/Stage/Marker".to_owned()),
        "an undo that reports a step must have taken one"
    );
    assert_eq!(
        session.call("session.get_state", json!({}))["canRedo"],
        true
    );

    let redone = session.mutate("session.redo", json!({}));
    assert_eq!(redone["undoDepth"], 1);
    assert_eq!(redone["redoDepth"], 0);
    assert!(
        paths(&session.call("scene.get_tree", json!({}))).contains(&"/Stage/Marker".to_owned()),
        "a redo that reports a step must have taken one"
    );

    // Nothing left to walk is a refusal, not a step reported against an empty history.
    assert!(
        session
            .try_mutate("session.redo", json!({}))
            .expect_err("redo past the end must be refused")
            .starts_with("redo_unavailable")
    );
}

/// The nine configuration commands answer from ProjectSettings and EditorSettings.
///
/// This is where the defect that started the refactor lived: `project.set_setting` answered
/// `saved: true` for a name Godot did not take, and the project went on running the scene it always
/// had. Every write here is checked against the matching read command, and the settings that persist
/// are checked against project.godot itself.
#[test]
fn every_configuration_command_answers_from_godot() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));
    let project =
        || std::fs::read_to_string(worktree.join("project.godot")).expect("project.godot");

    // set_setting
    let set = session.call(
        "project.set_setting",
        json!({"name": "readback/knob", "value": {"type": "int", "value": 7}}),
    );
    assert_eq!(set["saved"], true);
    assert_eq!(set["created"], true);
    assert_eq!(
        session.call("project.get_setting", json!({"name": "readback/knob"}))["value"],
        json!({"type": "int", "value": 7})
    );
    assert!(project().contains("knob=7"), "{}", project());

    // reset_setting
    let reset = session.call("project.reset_setting", json!({"name": "readback/knob"}));
    assert_eq!(reset["exists"], false);
    assert!(
        session
            .error(
                "project.get_setting",
                json!({"name": "readback/knob"}),
                None
            )
            .starts_with("setting_not_found"),
        "a setting reported reset must be gone"
    );

    // set_autoload
    let autoload = session.call(
        "project.set_autoload",
        json!({"name": "ReadbackHelper", "path": "res://tests/protocol_test.gd"}),
    );
    assert_eq!(autoload["enabled"], true);
    assert_eq!(
        named(
            &session.call("project.list_autoloads", json!({})),
            "autoloads",
            "ReadbackHelper"
        )
        .expect("the autoload must be listed")["path"],
        "res://tests/protocol_test.gd"
    );

    // remove_autoload
    session.call("project.remove_autoload", json!({"name": "ReadbackHelper"}));
    assert!(
        named(
            &session.call("project.list_autoloads", json!({})),
            "autoloads",
            "ReadbackHelper"
        )
        .is_none(),
        "an autoload reported removed must be gone from project.godot"
    );

    // set_input_action: the reply's events are the ones the file now holds.
    let action = session.call(
        "project.set_input_action",
        json!({"name": "readback_jump", "events": [{"kind": "key", "key": "Space"}]}),
    );
    assert_eq!(action["events"], json!([{"kind": "key", "key": "Space"}]));
    assert_eq!(
        named(
            &session.call("project.list_input_actions", json!({})),
            "actions",
            "readback_jump"
        )
        .expect("the action must be listed")["events"],
        action["events"]
    );

    // remove_input_action
    session.call(
        "project.remove_input_action",
        json!({"name": "readback_jump"}),
    );
    assert!(
        !project().contains("readback_jump"),
        "an action reported removed must be gone from project.godot:\n{}",
        project()
    );

    // reset_input_action: the override leaves project.godot, and the engine's binding takes over.
    session.call(
        "project.set_input_action",
        json!({"name": "ui_accept", "events": [{"kind": "key", "key": "F9"}]}),
    );
    assert!(project().contains("ui_accept"), "{}", project());
    assert_eq!(
        session.call("project.reset_input_action", json!({"name": "ui_accept"}))["reset"],
        true
    );
    assert!(
        !project().contains("ui_accept"),
        "an override reported reset must be gone from project.godot:\n{}",
        project()
    );

    // set_plugin_enabled: what the editor says about the plugin, not what it was asked to do.
    let toggled = session.call(
        "project.set_plugin_enabled",
        json!({"plugin": "gofer", "enabled": true}),
    );
    assert_eq!(toggled["enabled"], true);
    assert_eq!(
        toggled["changed"], false,
        "a plugin already enabled was not changed"
    );

    // editor.set_setting: machine-wide, so it is written back to itself — and the reply carries the
    // value the editor holds rather than the one it was handed.
    let candidate =
        session.call("editor.search_settings", json!({"query": "font_size"}))["settings"]
            .as_array()
            .expect("settings")
            .iter()
            .find(|entry| entry["value"]["type"] == "int")
            .cloned()
            .expect("an integer editor setting about font sizes");
    let written = session.call(
        "editor.set_setting",
        json!({"name": candidate["name"], "value": candidate["value"]}),
    );
    assert_eq!(written["value"], candidate["value"]);
    assert_eq!(
        session.call("editor.get_setting", json!({"name": candidate["name"]}))["value"],
        written["value"]
    );
}

/// A scene path written without `res://` is the same path, for every scene command.
///
/// The editor names the scene it edits `res://scenes/hud.tscn` however the request spelled it, and
/// the addon confirms a switch by comparing against that name. A caller's `scenes/hud.tscn` opened
/// the scene and then matched nothing: `scene.create` re-asked for a switch that had already
/// happened until it expired, and answered `scene_switch_timeout` about a scene the editor was
/// already editing. `scene.save_as` failed the same comparison and called the save a readback
/// mismatch.
#[test]
fn a_scene_path_without_the_scheme_is_the_same_scene() {
    let mut session = Session::start();

    let created = session.mutate(
        "scene.create",
        json!({"path": "bare.tscn", "rootType": "Node2D", "rootName": "Bare"}),
    );
    assert_eq!(
        created["scene"], "res://bare.tscn",
        "a create without the scheme answers with the name the editor uses"
    );
    assert_eq!(
        session.call("scene.get_tree", json!({}))["root"]["name"],
        "Bare",
        "the editor must be editing the scene that was created"
    );

    let moved = session.mutate("scene.save_as", json!({"path": "moved.tscn"}));
    assert_eq!(moved["scene"], "res://moved.tscn");

    session.open_scene("bare.tscn");
    assert_eq!(
        session.call("session.get_state", json!({}))["scene"],
        "res://bare.tscn",
        "an open without the scheme lands on the same scene"
    );
}
