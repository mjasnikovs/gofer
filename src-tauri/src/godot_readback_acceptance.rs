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

/// A tree larger than the answer's budget is bounded, flagged, and readable a part at a time.
///
/// The bound is not the addon's envelope. The worker holds a tool result at 24,000 characters and
/// slices it there without regard for the JSON, so an oversized tree reached the model as a
/// fragment it could not parse — and `truncated`, wherever it sits, is inside the part that was
/// cut. One live call answered 235,113 characters about 2,024 running nodes; the model saw a tenth
/// of it and then asked after nodes whose names it had guessed. The default is what keeps the flag
/// readable, so the default is what this pins.
#[test]
fn a_tree_past_the_answers_budget_is_bounded_and_says_so() {
    /// The worker's cap on a tool result, from `MAX_TOOL_TEXT_CHARS` in `scripts/tool-result.mjs`.
    const WORKER_CAP: usize = 24_000;
    /// What `DEFAULT_TREE_NODES` in the addon answers with when a call names no `limit`.
    const DEFAULT_NODES: usize = 150;

    let mut session = Session::start();
    session.mutate(
        "scene.create",
        json!({"path": "res://wide.tscn", "rootType": "Node2D", "rootName": "Level"}),
    );
    let wide: Vec<Value> = (0..200)
        .map(|index| json!({"parent": "/Level", "name": format!("Marker{index}"), "type": "Marker2D"}))
        .collect();
    session.mutate("node.create_nodes", json!({"nodes": wide}));

    let bounded = session.call("scene.get_tree", json!({}));
    assert_eq!(
        bounded["truncated"], true,
        "a 201-node scene must report that the answer stopped short"
    );
    let counted = paths(&bounded).len();
    assert!(
        counted <= DEFAULT_NODES,
        "the default answered with {counted} nodes"
    );
    let measured = serde_json::to_string(&bounded)
        .expect("the tree serializes")
        .len();
    assert!(
        measured < WORKER_CAP,
        "the default answer is {measured} characters, past the worker's {WORKER_CAP}"
    );

    let ten = session.call("scene.get_tree", json!({"limit": 10}));
    assert!(paths(&ten).len() <= 10, "limit is the caller's own bound");
    assert_eq!(ten["truncated"], true);

    let shallow = session.call("scene.get_tree", json!({"depth": 0}));
    assert_eq!(paths(&shallow), vec!["/Level".to_owned()]);
    assert_eq!(shallow["truncated"], true, "the children were left out");

    let leaf = session.call("scene.get_tree", json!({"root": "/Level/Marker199"}));
    assert_eq!(leaf["root"]["name"], "Marker199");
    assert_eq!(
        leaf["truncated"], false,
        "a leaf is the whole of its subtree"
    );

    let missing = session
        .try_call("scene.get_tree", json!({"root": "/Level/Nowhere"}), None)
        .expect_err("a root that is not in the scene is refused");
    assert!(
        missing.contains("Nowhere"),
        "the refusal has to name the node that is missing: {missing}"
    );
}

/// A save of a scene nobody changed puts nothing on disk.
///
/// A live turn moved a script, then opened and saved the scene that referenced it without changing
/// anything. `open` and `save` both answered `dirty: false, revision: 0` — and the file was rewritten
/// anyway, losing this line:
///
/// ```text
/// before  [ext_resource type="Script" uid="uid://cbk3p4i4uctns" path="res://scripts/player.gd" …]
/// after   [ext_resource type="Script"                           path="res://scripts/player.gd" …]
/// ```
///
/// The `uid` is what lets a scene find a script that has moved, so a save that changed nothing threw
/// away the only reference that still worked. Godot rewrites from the tree in memory, and a resource
/// it could not resolve at that moment has no id to write.
///
/// The rest of what that rewrite did is the everyday cost of the same bug: `load_steps` gone, a
/// `uid` on `gd_scene` that was not there, a `unique_id` on every node. None of it was asked for, and
/// all of it lands in the diff a user reads.
///
/// Godot's own `get_unsaved_scenes` is the authority here, not any counter of Gofer's: a scene it
/// does not list is one whose file already matches what the editor holds.
#[test]
fn saving_a_scene_nobody_changed_leaves_the_file_alone() {
    let mut session = Session::start();
    let scene = session.worktree.join("main.tscn");
    session.open_scene("res://main.tscn");
    let before = std::fs::read_to_string(&scene).expect("the fixture scene is on disk");

    let saved = session.mutate("scene.save", json!({}));
    assert_eq!(saved["dirty"], false);
    assert_eq!(saved["wrote"], false);
    let after = std::fs::read_to_string(&scene).expect("the scene is still on disk");
    assert_eq!(
        before, after,
        "a save of a scene nobody changed rewrote the file:\n--- before\n{before}\n--- after\n{after}"
    );

    session.mutate(
        "node.create",
        json!({"parent": "/ProtocolFixture", "name": "Marker", "type": "Marker2D"}),
    );
    let real = session.mutate("scene.save", json!({}));
    assert_eq!(real["dirty"], false);
    assert_eq!(real["wrote"], true);
    let written = std::fs::read_to_string(&scene).expect("the scene is on disk");
    assert!(
        written.contains("name=\"Marker\""),
        "the save after a real change has to reach the disk:\n{written}"
    );
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

    session.mutate(
        "scene.create",
        json!({"path": "res://coin.tscn", "rootType": "Area2D", "rootName": "Coin"}),
    );
    session.mutate(
        "scene.create",
        json!({"path": "res://tree.tscn", "rootType": "Node2D", "rootName": "Stage"}),
    );

    let made = session.mutate(
        "node.create",
        json!({"parent": "/Stage", "name": "Pickup", "type": "Area2D"}),
    );
    assert_eq!(made["node"], "/Stage/Pickup");
    assert!(
        paths(&session.call("scene.get_tree", json!({}))).contains(&"/Stage/Pickup".to_owned()),
        "a created node the tree does not hold was never created"
    );

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

    let copied = session.mutate(
        "node.duplicate",
        json!({"node": "/Stage/Pickup", "name": "Second"}),
    );
    assert_eq!(copied["node"], "/Stage/Second");
    session.call("node.inspect", json!({"node": "/Stage/Second"}));

    let renamed = session.mutate(
        "node.rename",
        json!({"node": "/Stage/Second", "name": "Silver"}),
    );
    assert_eq!(renamed["node"], "/Stage/Silver");
    assert_eq!(
        session.call("node.inspect", json!({"node": "/Stage/Silver"}))["name"],
        "Silver"
    );

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

    let deleted = session.mutate("node.delete", json!({"node": "/Stage/Placed"}));
    assert_eq!(deleted["deleted"], true);
    assert!(
        session
            .error("node.inspect", json!({"node": "/Stage/Placed"}), None)
            .starts_with("node_not_found"),
        "a node reported deleted must be gone from the tree"
    );

    let at = session.revision();
    let refused = session.error("node.delete", json!({"node": "/Stage"}), Some(at));
    assert!(refused.starts_with("cannot_delete_root"), "{refused}");
    assert!(refused.contains("scene.create"), "{refused}");
    assert!(refused.contains("node.rename"), "{refused}");
    assert_eq!(
        session.call("node.inspect", json!({"node": "/Stage"}))["name"],
        "Stage"
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

/// A scene created in a directory the project does not have yet is created, not refused.
///
/// `ResourceSaver.save` answers ERR_CANT_OPEN for a folder that is not there, and that number —
/// 19 — is what reached a live turn, twice running, about `res://scenes/bullet.tscn` in a project
/// with no `scenes` folder. `create_shape` and `create_tileset` have both made their directory
/// since they were written; `scene.create` and `scene.save_as` never did.
#[test]
fn a_scene_is_created_in_a_directory_the_project_does_not_have_yet() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let mut session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    let made = session.mutate(
        "scene.create",
        json!({
            "path": "res://scenes/arcade/bullet.tscn",
            "rootName": "Bullet",
            "rootType": "Node2D"
        }),
    );
    assert_eq!(made["scene"], "res://scenes/arcade/bullet.tscn", "{made}");
    assert!(
        worktree.join("scenes/arcade/bullet.tscn").exists(),
        "{made}"
    );

    let elsewhere = session.mutate(
        "scene.save_as",
        json!({"path": "res://levels/one/copy.tscn"}),
    );
    assert_eq!(
        elsewhere["scene"], "res://levels/one/copy.tscn",
        "{elsewhere}"
    );
    assert!(
        worktree.join("levels/one/copy.tscn").exists(),
        "{elsewhere}"
    );
}

/// A texture this tool drew is a texture the project can cut tiles out of, with no rescan between.
///
/// The capability is the point, not the pixels. Every 2D task starts with no art, and before this
/// operation the only way to make some was to leave the tool: three live turns reached for `bash`,
/// one of them writing a PNG encoder out of `struct` and `zlib` because the machine had no image
/// library, getting the colour type wrong, and spending six calls on a 16x16 tile. A Windows
/// install has neither the shell nor the library.
///
/// So the test is the whole path a caller takes — draw an atlas of two tiles, cut it, paint with
/// it — and the read-back is `create_tileset`, which is the one command that cannot be satisfied by
/// a file that merely exists.
#[test]
fn a_texture_this_tool_draws_is_one_create_tileset_can_cut() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    let drawn = session.call(
        "resource.create_texture",
        json!({
            "path": "res://art/atlas.png",
            "size": [32, 16],
            "background": "#3b2a1a",
            "rects": [
                {"x": 0, "y": 0, "width": 16, "height": 4, "color": "forestgreen"},
                {"x": 16, "y": 0, "width": 16, "height": 16, "color": "slategray"}
            ]
        }),
    );
    assert_eq!(drawn["width"], 32, "{drawn}");
    assert_eq!(drawn["height"], 16, "{drawn}");
    assert_eq!(drawn["replaced"], false, "{drawn}");
    assert!(worktree.join("art/atlas.png").exists(), "{drawn}");

    let built = session.call(
        "resource.create_tileset",
        json!({
            "path": "res://art/atlas.tres",
            "texture": "res://art/atlas.png",
            "tileSize": 16,
            "solid": [[1, 0]]
        }),
    );
    assert_eq!(built["grid"], json!([2, 1]), "{built}");

    let again = session.call(
        "resource.create_texture",
        json!({"path": "res://art/atlas.png", "size": [32, 16], "background": "black"}),
    );
    assert_eq!(again["replaced"], true, "{again}");

    let refused = session
        .try_call(
            "resource.create_texture",
            json!({"path": "res://art/bad.png", "size": 8, "background": "notacolour"}),
            None,
        )
        .expect_err("an unreadable colour must be refused");
    assert!(refused.contains("unsupported_color"), "{refused}");
    assert!(!worktree.join("art/bad.png").exists(), "{refused}");
}

/// The ground strip a game actually wants, and the runaway the cap is for.
///
/// The cap used to be one number per side, 1024. Two recorded live turns asked for a floor as wide
/// as the window — 1152x64 and 1280x40 — and both were refused, though each draws a twelfth of the
/// pixels a 1024x1024 square does and the square was allowed. The default Godot project window is
/// 1152 wide, so the first shape the cap refused was the most ordinary one a 2D game has.
///
/// Both halves are here because moving a limit is only safe if the thing it was guarding is still
/// guarded: the cost of drawing is area, and area is what is capped now.
#[test]
fn a_floor_wider_than_the_window_is_drawn_and_a_runaway_is_still_refused() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    let drawn = session.call(
        "resource.create_texture",
        json!({
            "path": "res://art/floor.png",
            "size": [1152, 64],
            "background": "#8b5a2b",
            "rects": [{"x": 0, "y": 0, "width": 1152, "height": 8, "color": "forestgreen"}]
        }),
    );
    assert_eq!(drawn["width"], 1152, "{drawn}");
    assert_eq!(drawn["height"], 64, "{drawn}");
    assert!(worktree.join("art/floor.png").exists(), "{drawn}");

    let refused = session
        .try_call(
            "resource.create_texture",
            json!({"path": "res://art/huge.png", "size": [2048, 2048], "background": "red"}),
            None,
        )
        .expect_err("four million pixels must be refused");
    assert!(refused.contains("holds at most"), "{refused}");
    assert!(!worktree.join("art/huge.png").exists(), "{refused}");

    let refused = session
        .try_call(
            "resource.create_texture",
            json!({"path": "res://art/thin.png", "size": [8192, 2], "background": "red"}),
            None,
        )
        .expect_err("a side past the edge must be refused");
    assert!(refused.contains("on a side"), "{refused}");
    assert!(!worktree.join("art/thin.png").exists(), "{refused}");
}

/// A path that climbs out of the project is refused by the addon, not followed.
///
/// `res://../` is a real path to Godot: `globalize_path` resolves it out of the project and every
/// writer follows it. Measured on the pinned 4.7.2 before this gate existed —
/// `Image.save_png("res://../escaped.png")` and `ResourceSaver.save(shape, "res://../escaped.tres")`
/// both landed one directory above the project and both answered OK.
///
/// The router refuses this before the socket. This is the wire's own backstop, which is also the
/// desktop client's, and it is tested here because only a real editor can prove the file is not
/// there afterwards.
#[test]
fn a_path_that_climbs_out_of_the_project_is_refused_by_the_addon() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let outside = worktree
        .parent()
        .expect("the worktree has a parent")
        .to_path_buf();
    let session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    for (command, params) in [
        (
            "resource.create_texture",
            json!({"path": "res://../escaped.png", "size": 8, "background": "red"}),
        ),
        (
            "resource.create_shape",
            json!({
                "path": "res://../escaped.tres",
                "shapeType": "RectangleShape2D",
                "size": [8, 8]
            }),
        ),
        (
            "resource.create_texture",
            json!({"path": "assets/../../escaped.png", "size": 8, "background": "red"}),
        ),
    ] {
        let refused = session
            .try_call(command, params.clone(), None)
            .expect_err("a path that climbs out must be refused");
        assert!(
            refused.starts_with("outside_workspace"),
            "{command} {params}: {refused}"
        );
    }
    assert!(
        !outside.join("escaped.png").exists() && !outside.join("escaped.tres").exists(),
        "nothing may be written above the project"
    );

    let drawn = session.call(
        "resource.create_texture",
        json!({"path": "res://art/dots..png.png", "size": 4, "background": "red"}),
    );
    assert_eq!(drawn["width"], 4, "{drawn}");

    let mut session = session;
    let root = session.call("scene.get_tree", json!({}))["root"]["path"]
        .as_str()
        .expect("a root path")
        .to_owned();
    let named = session.mutate(
        "node.create",
        json!({"parent": root, "type": "Label", "name": "Note"}),
    );
    session.mutate(
        "node.set_property",
        json!({
            "node": named["path"],
            "property": "text",
            "value": {"type": "string", "value": "see ../docs/readme"}
        }),
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

    std::fs::create_dir_all(worktree.join("assets")).expect("make the assets directory");
    std::fs::write(worktree.join("assets/late.png"), ATLAS).expect("write the atlas");

    let scanned = session.call("resource.rescan", json!({"path": "res://assets/late.png"}));
    assert_eq!(scanned["scanned"], true, "{scanned}");
    assert!(
        worktree.join("assets/late.png.import").exists(),
        "a rescan that answers `scanned: true` has to have run the importer: no .import was written"
    );

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

/// An asset whose first import failed is importable again once the file behind it is fixed.
///
/// The failed import is not nothing: Godot writes the `.import` sidecar for it anyway, and from
/// then on the file is one the editor has already looked at. A project walk skips it — which is why
/// the walk `resource.rescan` falls back to, the branch its own comment calls the last resort,
/// changed nothing at all. A live turn building a top-down arena hand-rolled a PNG encoder, got the
/// colour type wrong, rescanned into `import_failed`, fixed the encoder, wrote a genuinely valid
/// RGBA PNG over the same path — and was told `import_failed` again, about a file `file(1)` reads
/// as a PNG. It escaped by running `rm -f assets/*.import` in the shell, which is not a door a
/// Windows install has and not one the tool should need.
///
/// The sidecar of an import that produced nothing is what gets taken away before the walk, so the
/// walk meets a file it has never imported. Everything else about the rescan is unchanged.
#[test]
fn a_rescan_imports_an_asset_again_after_its_first_import_failed() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    std::fs::create_dir_all(worktree.join("assets")).expect("make the assets directory");
    let mut broken = b"\x89PNG\r\n\x1a\n".to_vec();
    broken.extend_from_slice(&[0u8; 64]);
    std::fs::write(worktree.join("assets/fixed.png"), &broken).expect("write the broken image");

    let refused = session.try_call(
        "resource.rescan",
        json!({"path": "res://assets/fixed.png"}),
        None,
    );
    assert!(
        refused.is_err(),
        "an image that cannot be imported must not answer scanned: {refused:?}"
    );

    std::fs::write(worktree.join("assets/fixed.png"), ATLAS).expect("write the real atlas");
    let scanned = session.call("resource.rescan", json!({"path": "res://assets/fixed.png"}));
    assert_eq!(scanned["scanned"], true, "{scanned}");

    let built = session.call(
        "resource.create_tileset",
        json!({
            "path": "res://assets/fixed.tres",
            "texture": "res://assets/fixed.png",
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

    let reset = session.call("project.reset_setting", json!({"name": "readback/knob"}));
    assert_eq!(reset["changed"], true, "{reset}");
    assert_eq!(
        reset["previous"],
        json!({"type": "int", "value": 7}),
        "{reset}"
    );
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

    session.call(
        "project.set_setting",
        json!({"name": "physics/2d/default_gravity", "value": {"type": "float", "value": 1400.0}}),
    );
    let reverted = session.call(
        "project.reset_setting",
        json!({"name": "physics/2d/default_gravity"}),
    );
    assert_eq!(reverted["changed"], true, "{reverted}");
    assert_eq!(
        reverted["previous"],
        json!({"type": "float", "value": 1400.0}),
        "{reverted}"
    );
    assert_ne!(
        reverted["value"], reverted["previous"],
        "a reverted setting must answer with the value it now reads as: {reverted}"
    );

    let again = session.call(
        "project.reset_setting",
        json!({"name": "physics/2d/default_gravity"}),
    );
    assert_eq!(again["changed"], false, "{again}");

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

    session.call(
        "project.remove_input_action",
        json!({"name": "readback_jump"}),
    );
    assert!(
        !project().contains("readback_jump"),
        "an action reported removed must be gone from project.godot:\n{}",
        project()
    );

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

    let toggled = session.call(
        "project.set_plugin_enabled",
        json!({"plugin": "gofer", "enabled": true}),
    );
    assert_eq!(toggled["enabled"], true);
    assert_eq!(
        toggled["changed"], false,
        "a plugin already enabled was not changed"
    );

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

/// A resource this tool wrote carries a UID the project can resolve.
///
/// `ResourceSaver.save` stamps a fresh UID into a `.tres` header, and the project only knows that
/// UID once it is in `.godot/uid_cache.bin`. `update_file` does not put it there. Every scene that
/// then references the file loads with
/// `ext_resource, invalid UID: uid://… - using text path instead`, once per reference, every run.
///
/// A live turn met exactly that: two shapes from `resource.create_shape`, two warnings in the
/// running game, and the agent spent six calls chasing them — a `bash cat` the workspace refused
/// because it named a scene, a `cat` for `.uid` sidecars that are not there, a `sed` that would not
/// parse, and finally a `sed` that stripped the UID line out of both files by hand.
#[test]
fn a_resource_this_tool_wrote_carries_a_uid_the_project_can_resolve() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    session.call(
        "resource.create_shape",
        json!({"path": "res://shapes/coin.tres", "shapeType": "CircleShape2D", "radius": 8}),
    );
    let written = std::fs::read_to_string(worktree.join("shapes/coin.tres")).expect("the shape");
    let stamped = written
        .split("uid=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap_or_else(|| panic!("the file carries no uid at all: {written}"))
        .to_owned();

    registered(&worktree, "res://shapes/coin.tres", &stamped);

    session.call(
        "resource.create_texture",
        json!({"path": "res://art/atlas.png", "size": [16, 16], "background": "#3b2a1a"}),
    );
    session.call(
        "resource.create_tileset",
        json!({
            "path": "res://art/world.tres",
            "texture": "res://art/atlas.png",
            "tileSize": [16, 16]
        }),
    );
    registered(&worktree, "res://art/world.tres", "the tileset");
}

/// The project's own UID table, as the running game reads it.
fn registered(worktree: &std::path::Path, path: &str, stamped: &str) {
    let cache = worktree.join(".godot/uid_cache.bin");
    let held = std::fs::read(&cache).unwrap_or_default();
    assert!(
        held.windows(path.len())
            .any(|window| window == path.as_bytes()),
        "{stamped} is stamped into {path} but {} does not hold that path, so everything that \
         references it loads with `invalid UID`",
        cache.display()
    );
}

/// A scene already at the path is not a scene to create.
///
/// `ResourceSaver.save` writes over whatever is there, and a live turn tidying a project sent
/// `{"op": "create", "path": "scenes/main.tscn", "rootName": "Main", "rootType": "Node2D"}` against
/// the scene it had open. The whole file became an empty root. The agent noticed and spent the rest
/// of its turn rebuilding the scene from what it had read earlier; nothing said a word while the
/// file went.
#[test]
fn creating_a_scene_over_one_that_exists_is_refused_rather_than_done() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let mut session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    session.mutate(
        "scene.create",
        json!({"path": "res://level.tscn", "rootType": "Node2D", "rootName": "Level"}),
    );
    session.mutate(
        "node.create",
        json!({"parent": "/Level", "name": "Player", "type": "Node2D"}),
    );
    session.mutate("scene.save", json!({}));
    let before = std::fs::read_to_string(worktree.join("level.tscn")).expect("the scene");
    assert!(before.contains("Player"), "{before}");

    let at = session.call("scene.get_tree", json!({}))["revision"]
        .as_u64()
        .expect("the scene reports its revision");
    let refused = session
        .try_call(
            "scene.create",
            json!({"path": "res://level.tscn", "rootType": "Node2D", "rootName": "Level"}),
            Some(at),
        )
        .expect_err("a scene that is already there is refused");
    assert!(refused.contains("already_exists"), "{refused}");
    assert!(refused.contains("scene.open"), "{refused}");
    assert!(refused.contains("scene.save_as"), "{refused}");

    let after = std::fs::read_to_string(worktree.join("level.tscn")).expect("the scene");
    assert_eq!(before, after, "nothing may be written by a refused create");

    session.mutate(
        "scene.create",
        json!({"path": "res://levels/two.tscn", "rootType": "Node2D", "rootName": "Two"}),
    );
    assert!(worktree.join("levels/two.tscn").exists());
}
