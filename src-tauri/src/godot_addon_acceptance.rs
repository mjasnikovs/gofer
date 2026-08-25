//! Acceptance coverage for the editor boundary: the real addon, inside a real Godot editor,
//! answering the real [`crate::godot_rpc::RpcSession`].
//!
//! Every other test in this suite stands in for one side of that boundary — a fake spawner, a fake
//! addon that answers only what the test writes, JSON fixtures that describe envelopes nobody
//! sends. Those agree with the code because the same author wrote both, which is exactly how a
//! green suite once shipped an addon whose undo called a method Godot does not expose to scripting
//! and a supervisor that closed the connection on its own heartbeat. This module removes the
//! stand-ins: it takes a real editor from [`crate::godot_editor_harness`] and drives authoring
//! commands over the wire the desktop app uses.
//!
//! The test is gated behind the `godot-acceptance` feature so the fast `cargo test` gate stays
//! process-free; `npm run test:godot` enables it after the Node journeys have proven the binary.

use crate::godot_editor_harness::{PNG_BASE64_PREFIX, Session, Transports, fixture_worktree};
use crate::godot_rpc::{CallRequest, HEARTBEAT_INTERVAL_MS};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

/// The fixture project padded with enough resources that the editor's first import scan is still
/// running when the addon connects.
///
/// The window this opens is the whole point: the editor finishes starting up long after a plugin's
/// first frame, and the scene it opens for itself when the scan lands replaces whatever scene is
/// being edited. On the four-file fixture the scan is over before the addon connects, so the
/// window is invisible and a session that reports ready too early looks perfectly healthy.
fn slow_importing_worktree(directory: &TempDir) -> PathBuf {
    let worktree = fixture_worktree(directory);
    let padding = worktree.join("padding");
    std::fs::create_dir_all(&padding).expect("create padding directory");
    for index in 0..4000 {
        std::fs::write(
            padding.join(format!("padding_{index}.tres")),
            "[gd_resource type=\"Resource\" format=3]\n\n[resource]\n",
        )
        .expect("write padding resource");
    }
    worktree
}

fn child_names(tree: &Value) -> Vec<String> {
    tree["root"]["children"]
        .as_array()
        .expect("children array")
        .iter()
        .map(|child| child["name"].as_str().expect("child name").to_owned())
        .collect()
}

/// A ready session owns the edited scene; the editor must not still be about to open one.
///
/// Godot imports the project on a background thread and, when that first scan lands, opens a scene
/// for itself — the main scene, or the one a previous editor session left open — replacing
/// whatever is being edited, with no event and nobody asked. An addon that reports ready on its
/// first frame hands the session that window: `scene.create` opens the new scene, the editor's own
/// open takes the edited scene back, and the `node.create` that follows cannot resolve a root that
/// belongs to a scene the editor is no longer editing. Which side of the window a command lands on
/// is decided by how long the import takes, which is why it read as an editor-timing flake.
#[test]
fn a_ready_session_owns_the_edited_scene() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = slow_importing_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let mut session = Session::start_on_worktree(worktree, ledger, Some(directory));
    let scene = "res://owned.tscn";

    // Ready means started up: the scene the editor opens for itself is already the edited one, so
    // there is no second open still coming.
    assert_eq!(
        session.call("scene.get_tree", json!({}))["root"]["name"],
        "ProtocolFixture",
        "the editor must have finished opening its own scene before the session is ready"
    );

    // And so the scene the session opens stays the edited one, which is the only reason the node
    // below can be addressed at all.
    session.mutate("scene.create", json!({"path": scene, "rootType": "Node2D"}));
    session.mutate(
        "node.create",
        json!({"scene": scene, "parent": "/owned", "name": "Marker", "type": "Marker2D"}),
    );
    let tree = session.call("scene.get_tree", json!({}));
    assert_eq!(
        child_names(&tree),
        vec!["Marker".to_owned()],
        "the created node must appear in the scene the session opened"
    );
    // The tree is the one command documented as the source of `expectedRevision`, and it is not a
    // mutating command — so the revision has to be in its own result or an agent that reads the
    // tree before every mutation has no number to send back.
    assert_eq!(
        tree["revision"].as_u64(),
        Some(session.revision()),
        "scene.get_tree must report the revision its mutations reached: {tree}"
    );
}

/// The tree names the icon each node is drawn with, and the editor hands over the artwork.
///
/// Gofer's explorer draws Godot's own icons rather than bundled copies, so the only proof that the
/// lookup works is a real editor's theme answering with real PNGs — and a class the theme has never
/// heard of has to be left out rather than fail the batch the rest of the tree needs.
#[test]
fn the_addon_serves_the_editors_own_class_icons() {
    let mut session = Session::start();
    let scene = "res://icons.tscn";

    session.mutate("scene.create", json!({"path": scene, "rootType": "Node2D"}));
    session.mutate(
        "node.create",
        json!({"parent": "/icons", "name": "Sprite", "type": "Sprite2D"}),
    );

    let tree = session.call("scene.get_tree", json!({}));
    assert_eq!(
        tree["root"]["icon"], "Node2D",
        "a node with no script is drawn as its engine class: {tree}"
    );

    let answer = session.call(
        "editor.get_class_icons",
        json!({"classes": ["Node2D", "Sprite2D", "NoSuchClassAnywhere"]}),
    );
    assert_eq!(answer["encoding"], "png-base64");
    let icons = answer["icons"].as_object().expect("icons object");
    for class in ["Node2D", "Sprite2D"] {
        let data = icons[class]
            .as_str()
            .unwrap_or_else(|| panic!("{class} icon"));
        assert!(
            data.starts_with(PNG_BASE64_PREFIX),
            "the {class} icon must be a PNG: {data:.16}"
        );
    }
    assert_ne!(
        icons["Node2D"], icons["Sprite2D"],
        "each class must answer with its own artwork"
    );
    assert!(
        !icons.contains_key("NoSuchClassAnywhere") || icons["NoSuchClassAnywhere"].is_string(),
        "an unknown class is answered with a fallback icon or left out, never as an error"
    );
}

#[test]
fn the_addon_authors_scenes_undoably_inside_a_real_editor() {
    let mut session = Session::start();
    let scene = "res://acceptance.tscn";

    // Reaching this line already proves the handshake agrees on the project path Godot globalizes,
    // and that the supervisor's own heartbeat did not close the connection.
    let settings = session.call("project.get_settings", json!({}));
    assert_eq!(settings["projectName"], "Gofer Protocol Fixture");

    let created = session.mutate("scene.create", json!({"path": scene, "rootType": "Node2D"}));
    assert_eq!(created["scene"], scene);

    // No `scene`: the AI tool catalog documents none, so an authoring call that omits it has to
    // mean the scene the editor is editing rather than be refused against the empty string.
    session.mutate(
        "node.create",
        json!({"parent": "/acceptance", "name": "Sprite", "type": "Sprite2D"}),
    );
    assert_eq!(
        child_names(&session.call("scene.get_tree", json!({}))),
        vec!["Sprite".to_owned()],
        "the created node must appear in the edited scene"
    );

    session.mutate(
        "node.set_property",
        json!({
            "scene": scene,
            "node": "/acceptance/Sprite",
            "property": "position",
            "value": {"type": "vector2", "value": [12, 34]}
        }),
    );

    // Undo has to walk the scene's own history. An addon that cannot reach it answers an error, and
    // one that mishandles its depth bookkeeping reports a redo that is not available.
    let undone = session.mutate("session.undo", json!({}));
    assert_eq!(undone["undoDepth"], 1, "undo must consume one action");
    assert_eq!(undone["redoDepth"], 1, "undo must offer the action back");
    let state = session.call("session.get_state", json!({}));
    assert_eq!(state["canRedo"], true, "an undone action must be redoable");

    session.mutate("session.undo", json!({}));
    assert!(
        child_names(&session.call("scene.get_tree", json!({}))).is_empty(),
        "undoing the node creation must remove the node from the edited scene"
    );

    session.mutate("session.redo", json!({}));
    assert_eq!(
        child_names(&session.call("scene.get_tree", json!({}))),
        vec!["Sprite".to_owned()],
        "redo must restore the node"
    );

    session.mutate("scene.save", json!({}));
    let saved = std::fs::read_to_string(session.worktree.join("acceptance.tscn"))
        .expect("the saved scene must exist on disk");
    assert!(saved.contains("Sprite2D"), "{saved}");
    assert_eq!(
        session.call("session.get_state", json!({}))["dirty"],
        false,
        "saving must clear the dirty flag"
    );
}

/// A subtree and its properties, built in two commands rather than in two dozen.
///
/// `node.create` and `node.set_property` each answer with the revision the next one needs, so a
/// scene is authored one round trip through the model per node. A measured turn spent 44 creates
/// and 65 property writes as 109 separate asks and waited on the model for about two seconds before
/// each. These two commands take the same entries as a list, and only a real editor can say that
/// the tree, the owners, the undo history and the saved file all come out the same.
#[test]
fn the_addon_authors_a_whole_subtree_in_one_call() {
    let mut session = Session::start();
    let scene = "res://batch.tscn";
    session.mutate("scene.create", json!({"path": scene, "rootType": "Node2D"}));

    // A later entry parents onto a node an earlier entry creates, which is what makes this one call
    // rather than one call per level of the tree.
    let created = session.mutate(
        "node.create_nodes",
        json!({
            "nodes": [
                {"parent": "/batch", "name": "Player", "type": "CharacterBody2D"},
                {"parent": "/batch/Player", "name": "Body", "type": "Sprite2D"},
                {"parent": "/batch/Player", "name": "Hitbox", "type": "CollisionShape2D"},
                {"parent": "/batch", "name": "Ground", "type": "StaticBody2D"}
            ]
        }),
    );
    assert_eq!(created["created"], 4, "{created}");
    assert_eq!(
        created["nodes"],
        json!([
            "/batch/Player",
            "/batch/Player/Body",
            "/batch/Player/Hitbox",
            "/batch/Ground"
        ]),
        "{created}"
    );

    let tree = session.call("scene.get_tree", json!({}));
    assert_eq!(
        child_names(&tree),
        vec!["Player".to_owned(), "Ground".to_owned()],
        "the batch must build the tree in the order it was given: {tree}"
    );

    // Different nodes in one call: the whole point, since a scene sets one or two properties per
    // node rather than six on one.
    let written = session.mutate(
        "node.set_properties",
        json!({
            "properties": [
                {"node": "/batch/Player", "property": "position",
                 "value": {"type": "vector2", "value": [12, 34]}},
                {"node": "/batch/Player/Body", "property": "flip_h",
                 "value": {"type": "bool", "value": true}},
                {"node": "/batch/Ground", "property": "position",
                 "value": {"type": "vector2", "value": [0, 200]}}
            ]
        }),
    );
    assert_eq!(
        written["properties"].as_array().expect("properties").len(),
        3,
        "{written}"
    );
    assert_eq!(
        session.call("node.inspect", json!({"node": "/batch/Player"}))["properties"]
            .as_array()
            .expect("properties")
            .iter()
            .find(|property| property["name"] == "position")
            .expect("position")["value"],
        json!({"type": "vector2", "value": [12.0, 34.0]}),
        "the batched write must reach the node"
    );

    // All-or-nothing: an entry naming a node that is not there stops the command with nothing
    // written, so a refused batch does not leave the caller guessing which half landed.
    let refused = session.error(
        "node.set_properties",
        json!({
            "properties": [
                {"node": "/batch/Ground", "property": "position",
                 "value": {"type": "vector2", "value": [999, 999]}},
                {"node": "/batch/Nowhere", "property": "position",
                 "value": {"type": "vector2", "value": [1, 1]}}
            ]
        }),
        Some(session.revision()),
    );
    assert!(
        refused.starts_with("node_not_found"),
        "the refusal must name the missing node: {refused}"
    );
    assert_eq!(
        session.call("node.inspect", json!({"node": "/batch/Ground"}))["properties"]
            .as_array()
            .expect("properties")
            .iter()
            .find(|property| property["name"] == "position")
            .expect("position")["value"],
        json!({"type": "vector2", "value": [0.0, 200.0]}),
        "the entry before the refused one must not have been written"
    );

    // One batch is one editor action, so one undo takes the whole subtree back.
    session.mutate("session.undo", json!({}));
    session.mutate("session.undo", json!({}));
    assert!(
        child_names(&session.call("scene.get_tree", json!({}))).is_empty(),
        "two undos must take back the two batches"
    );
    session.mutate("session.redo", json!({}));
    session.mutate("session.redo", json!({}));

    session.mutate("scene.save", json!({}));
    let saved = std::fs::read_to_string(session.worktree.join("batch.tscn"))
        .expect("the saved scene must exist on disk");
    assert!(
        saved.contains("CharacterBody2D") && saved.contains("CollisionShape2D"),
        "the batch must reach the file, owners and all: {saved}"
    );
}

#[test]
fn the_session_outlives_its_own_heartbeat() {
    let session = Session::start();

    // Gofer sends `session.heartbeat` as a request and the addon answers it like any other request.
    // Because no correlation entry is ever created for it, a supervisor that recognizes only
    // correlated replies reads that answer as a stale reply and closes the connection — so the
    // session dies one heartbeat interval after a handshake that looked perfectly healthy. Only a
    // test that outlives the interval can see it.
    thread::sleep(Duration::from_millis(HEARTBEAT_INTERVAL_MS * 2 + 500));

    let state = session
        .try_call("session.get_state", json!({}), None)
        .unwrap_or_else(|error| {
            panic!(
                "the session did not survive {} heartbeats: {error}\n--- editor output ---\n{}",
                2,
                session.output()
            )
        });
    assert_eq!(state["state"], "ready");
}

#[test]
fn the_addon_refuses_stale_revisions_and_malformed_values() {
    let mut session = Session::start();
    let scene = "res://refusals.tscn";
    session.mutate("scene.create", json!({"path": scene, "rootType": "Node2D"}));
    session.mutate(
        "node.create",
        json!({"scene": scene, "parent": "/refusals", "name": "Sprite", "type": "Sprite2D"}),
    );
    let current = session.revision();

    let node = json!({"scene": scene, "node": "/refusals/Sprite", "property": "position"});
    let with_value = |value: Value| {
        let mut params = node.clone();
        params["value"] = value;
        params
    };

    assert!(
        session
            .error(
                "node.rename",
                json!({"scene": scene, "node": "/refusals/Sprite", "name": "Renamed"}),
                Some(0)
            )
            .starts_with("revision_conflict"),
        "a stale expectedRevision must be refused"
    );
    assert!(
        session
            .error(
                "node.rename",
                json!({"scene": scene, "node": "/refusals/Sprite", "name": "Renamed"}),
                None
            )
            .starts_with("revision_conflict"),
        "a missing expectedRevision must be refused"
    );
    // A bare JSON value is not a tagged value; a coercing decoder would write (0, 0) instead.
    assert!(
        session
            .error("node.set_property", with_value(json!(42)), Some(current))
            .starts_with("unsupported_value"),
        "an untagged value must be refused"
    );
    assert!(
        session
            .error(
                "node.set_property",
                with_value(json!({"type": "vector2", "value": [1]})),
                Some(current)
            )
            .starts_with("unsupported_value"),
        "a vector2 missing a component must be refused"
    );
    assert!(
        session
            .error(
                "node.rename",
                json!({"scene": "res://other.tscn", "node": "/refusals/Sprite", "name": "Renamed"}),
                Some(current)
            )
            .starts_with("wrong_scene"),
        "a request naming another scene must be refused"
    );
    assert!(
        session
            .error(
                "node.inspect",
                json!({"scene": scene, "node": "/refusals/Missing"}),
                None
            )
            .starts_with("node_not_found"),
        "an unknown node must be refused"
    );

    // Four spellings that are not a missing node but the other tool's, or no node path at all.
    // Every one was written by a real model at a real editor. The refusal for each has to carry
    // the spelling that works, because repeating the path back says only what the caller knew.
    let refused =
        |node: &str| session.error("node.inspect", json!({"scene": scene, "node": node}), None);
    let the_runtime_spelling = refused("/root/refusals/Sprite");
    assert!(
        the_runtime_spelling.contains("/refusals/Sprite")
            && the_runtime_spelling.contains("godot_runtime"),
        "a /root/ path that is in the scene must be answered with the name it has here: \
         {the_runtime_spelling}"
    );
    let the_runtime_root = refused("/root");
    assert!(
        the_runtime_root.contains("/refusals") && the_runtime_root.contains("godot_runtime"),
        "/root on its own is the running game's root, and the answer must name this scene's: \
         {the_runtime_root}"
    );
    let a_scene_path = refused(scene);
    assert!(
        a_scene_path.contains("/refusals") && a_scene_path.contains("scene file"),
        "a res:// path names a scene, not a node in one, and the answer must say so: \
         {a_scene_path}"
    );
    // A signal the node does not emit. The third refusal of this shape — `node_not_found` and
    // `property_not_found` were the first two — and the same reasoning: naming the absence repairs
    // nothing. A live turn asked to connect `/Main/ScoreLabel` to `score_changed`, which belongs to
    // an autoload rather than to a Label, and was told only that the Label has no such signal.
    let no_signal = session.error(
        "node.connect_signal",
        json!({
            "node": "/refusals/Sprite",
            "signal": "score_changed",
            "method": "_on_anything"
        }),
        Some(current),
    );
    assert!(
        no_signal.starts_with("signal_not_found") && no_signal.contains("It emits "),
        "the refusal has to name the signals it does emit: {no_signal}"
    );
    let near_signal = session.error(
        "node.connect_signal",
        json!({
            "node": "/refusals/Sprite",
            "signal": "treeentered",
            "method": "_on_anything"
        }),
        Some(current),
    );
    assert!(
        near_signal.contains("Did you mean tree_entered?"),
        "and the near one when there is one: {near_signal}"
    );

    // A node path with whitespace round it is the same path. One live turn sent
    // `{"parent ": "/Level3D ", "type ": "DirectionalLight3D"}` — the router puts the padded keys
    // back onto their parameters, and the padded value went through untouched. `Node /Level3D  was
    // not found … the scene's own root is /Level3D` came back twelve times, naming two strings that
    // look identical on screen. `_as_resource_path` has trimmed a file path since it was written.
    let padded = session.call(
        "node.inspect",
        json!({"scene": scene, "node": "  /refusals/Sprite  "}),
    );
    assert_eq!(padded["path"], "/refusals/Sprite", "{padded}");

    // A property the node does not have. Four live turns in four separate runs were told only that
    // it is absent — about `transform_2d`, which is one edit from a property the node really has,
    // and about `spacing` on a VBoxContainer, which is a theme override no near miss reaches.
    let no_property = |property: &str| {
        session.error(
            "node.set_property",
            json!({
                "scene": scene,
                "node": "/refusals/Sprite",
                "property": property,
                "value": {"type": "int", "value": 1}
            }),
            Some(current),
        )
    };
    let near = no_property("transform_2d");
    assert!(
        near.contains("Did you mean transform?"),
        "a property one edit away has to be named: {near}"
    );
    let nowhere_near = no_property("spacing");
    assert!(
        nowhere_near.contains("node.inspect"),
        "and with nothing near it, the call that lists them all: {nowhere_near}"
    );

    // A path under a root this scene does not have. Two live turns in a row wrote `/Arena/...`
    // into `create_nodes` against a scene still rooted at `ProtocolFixture`, and the refusal —
    // "Node /Arena was not found in the edited scene" — repeated the one thing they already knew.
    // The root's name is the whole repair: every node path in this tree begins with it.
    let a_root_this_scene_has_not = refused("/Arena/Ground");
    assert!(
        a_root_this_scene_has_not.contains("/refusals"),
        "a path under a root this scene does not have must be answered with the root it does: \
         {a_root_this_scene_has_not}"
    );
    assert!(
        refused("/refusals/Missing").starts_with("node_not_found"),
        "an ordinary missing node still gets the plain refusal"
    );
    assert!(
        !refused("/refusals/Missing").contains("starts at the scene"),
        "a path already under the right root is not told where the root is"
    );

    // Nothing above may have changed the scene.
    assert_eq!(
        session.revision(),
        current,
        "a refused command must not bump the revision"
    );
    assert_eq!(
        child_names(&session.call("scene.get_tree", json!({}))),
        vec!["Sprite".to_owned()],
        "a refused command must leave the scene alone"
    );
}

/// The other half of authoring a scene: the groups and signal connections it is wired with.
///
/// Nodes and properties describe what a level looks like. What makes it a game is a coin that tells
/// somebody it was touched and a group the running code can ask for every coin at once — and both of
/// those are stored in the scene, not in a script. The protocol has declared these four commands
/// mutating since v2 while the addon answered `unknown_command` for all of them, so an agent could
/// only ever wire a scene up from `_ready`, which is not where the editor keeps its wiring.
///
/// Persistence is the whole assertion. `add_to_group` without the persistent flag and `connect`
/// without `CONNECT_PERSIST` both work perfectly in the editor and are dropped when the scene is
/// packed, so this reads the saved file rather than the live tree.
#[test]
fn the_addon_wires_a_scene_with_groups_and_signals() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    // The handler has to exist before the connection names it, exactly as it does for a person: the
    // editor's own connect dialog offers to write one and refuses to connect to nothing.
    std::fs::write(
        worktree.join("wiring.gd"),
        "extends Node2D\n\n\nfunc _on_coin_body_entered(_body: Node2D) -> void:\n\tpass\n",
    )
    .expect("write the handler script");
    let ledger = directory.path().join("ledger.json");
    let mut session = Session::start_on_worktree(worktree, ledger, Some(directory));

    let scene = "res://wiring.tscn";
    session.mutate("scene.create", json!({"path": scene, "rootType": "Node2D"}));
    session.mutate(
        "node.set_property",
        json!({
            "node": "/wiring",
            "property": "script",
            "value": {"type": "resource", "value": {"path": "res://wiring.gd"}}
        }),
    );
    session.mutate(
        "node.create",
        json!({"parent": "/wiring", "name": "Coin", "type": "Area2D"}),
    );

    let grouped = session.mutate(
        "node.add_to_group",
        json!({"node": "/wiring/Coin", "group": "coins"}),
    );
    assert_eq!(grouped["groups"], json!(["coins"]), "{grouped}");
    // No `target`: it defaults to the scene root, which is where a scene's script lives.
    let connected = session.mutate(
        "node.connect_signal",
        json!({
            "node": "/wiring/Coin",
            "signal": "body_entered",
            "method": "_on_coin_body_entered"
        }),
    );
    assert_eq!(connected["target"], "/wiring");
    assert_eq!(
        connected["persistent"], true,
        "an editor connection the scene does not keep is not an editor connection"
    );

    // Inspect is where a caller reads its own work back, so it has to report both — and only the
    // groups a caller put the node in. The engine keeps its own on a CanvasItem, named after an
    // object id (`_root_canvas1653562408967`), and a live agent was answered with one beside the
    // group it had just added.
    let inspected = session.call("node.inspect", json!({"node": "/wiring/Coin"}));
    assert_eq!(inspected["groups"], json!(["coins"]));
    assert!(
        inspected["signals"]
            .as_array()
            .expect("signals array")
            .contains(&json!("body_entered")),
        "inspect must name the signals a node can emit: {inspected}"
    );
    let connections = inspected["connections"]
        .as_array()
        .expect("connections array");
    assert_eq!(connections.len(), 1, "{inspected}");
    assert_eq!(connections[0]["signal"], "body_entered");
    assert_eq!(connections[0]["method"], "_on_coin_body_entered");

    session.mutate("scene.save", json!({}));
    let saved = std::fs::read_to_string(session.worktree.join("wiring.tscn"))
        .expect("the saved scene must exist on disk");
    assert!(
        saved.contains("groups=[\"coins\"]"),
        "the saved scene must keep the group: {saved}"
    );
    assert!(
        saved.contains(
            "[connection signal=\"body_entered\" from=\"Coin\" to=\".\" \
             method=\"_on_coin_body_entered\"]"
        ),
        "the saved scene must keep the connection: {saved}"
    );

    // Both are ordinary editor actions, so both undo.
    session.mutate("session.undo", json!({}));
    session.mutate("session.undo", json!({}));
    let undone = session.call("node.inspect", json!({"node": "/wiring/Coin"}));
    assert!(
        undone["connections"]
            .as_array()
            .expect("connections array")
            .is_empty(),
        "undo must take the connection back: {undone}"
    );
    assert_eq!(undone["groups"], json!([]), "undo must take the group back");

    session.mutate("session.redo", json!({}));
    session.mutate("session.redo", json!({}));

    // Removing them is the same transaction in reverse, and both refuse what is not there.
    session.mutate(
        "node.disconnect_signal",
        json!({
            "node": "/wiring/Coin",
            "signal": "body_entered",
            "method": "_on_coin_body_entered"
        }),
    );
    session.mutate(
        "node.remove_from_group",
        json!({"node": "/wiring/Coin", "group": "coins"}),
    );
    let bare = session.call("node.inspect", json!({"node": "/wiring/Coin"}));
    assert_eq!(bare["groups"], json!([]));
    assert!(
        bare["connections"]
            .as_array()
            .expect("connections array")
            .is_empty()
    );
}

/// A level built the way a 2D game is built: one tileset, one layer, painted by the rectangle.
///
/// Everything the addon could author before this was a node per block — a live agent asked for the
/// ground of World 1-1 answered with a ColorRect and a hand-written `.tres` shape, because a
/// TileSet has no text form a caller can write and a layer's cells are a packed blob rather than a
/// property. Both halves are proven here against a real editor: that the saved tileset holds tiles
/// with collision, and that the saved scene carries the cells, since a cell painted into a layer
/// the scene does not keep is a level that is empty the next time it opens.
/// A rescan that cannot succeed says so, instead of waiting out a clock and blaming the editor.
///
/// The old sweep had one way to stop waiting: a thirty-second deadline, answered as
/// `scan_timeout: The editor is still importing the project` and marked retryable. A live session
/// got exactly that about an editor that was importing nothing of its own — the sweep had
/// re-entered itself through the progress dialog `reimport_files` opens, logged
/// `Task 'reimport' already exists` eleven times, and then advised a retry that would re-enter the
/// same way. Half a minute of silence followed by a false sentence is the worst answer available.
///
/// A file the importer cannot read is the reachable half of that: the walk lands, the file still
/// does not load, and there is nothing to wait for. It has to be refused by name and not be
/// retryable.
#[test]
fn a_file_the_importer_cannot_read_is_refused_rather_than_waited_out() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    // A PNG header over bytes that decode to nothing. The editor takes the file, tries it as an
    // image because of the extension, and never produces an imported texture.
    let mut broken = b"\x89PNG\r\n\x1a\n".to_vec();
    broken.extend_from_slice(&[0u8; 64]);
    std::fs::write(worktree.join("broken.png"), &broken).expect("write the unreadable png");

    let started = std::time::Instant::now();
    let refusal = session
        .try_call("resource.rescan", json!({"path": "res://broken.png"}), None)
        .expect_err("a file the importer cannot read has no successful rescan");

    assert!(
        refusal.starts_with("import_failed"),
        "the refusal must name the import, not the clock: {refusal}"
    );
    assert!(
        refusal.contains("broken.png"),
        "the refusal must name the file: {refusal}"
    );
    assert!(
        !refusal.contains("still importing"),
        "the editor is idle, and saying otherwise is what sent a live run round the loop: \
         {refusal}"
    );
    // The old answer took the whole deadline. This one is evidence, so it arrives when the walk
    // does — well inside the thirty seconds that used to be the only way out.
    assert!(
        started.elapsed() < std::time::Duration::from_secs(25),
        "the refusal waited out the deadline instead of answering from the walk"
    );

    // And the session is still usable: the sweep cleared its own latch rather than stranding it.
    let scanned = session.call("resource.rescan", json!({}));
    assert_eq!(scanned["scanned"], json!(true), "{scanned}");
}

#[test]
fn the_addon_builds_a_tile_level_from_an_atlas() {
    /// The live fixture's own art, which is a real 8x2 atlas of 16x16 tiles.
    const ATLAS: &[u8] = include_bytes!("../../fixtures/live-project/assets/tiles.png");

    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    std::fs::write(worktree.join("tiles.png"), ATLAS).expect("write the atlas");
    let ledger = directory.path().join("ledger.json");
    let mut session = Session::start_on_worktree(worktree, ledger, Some(directory));
    // The atlas arrived after the editor started, so the import scan has to be told about it or
    // `load` answers nothing for a file that is plainly there.
    session.call("resource.rescan", json!({}));

    // Ground, brick and the pipe's mouth collide; the cloud is scenery a player passes through.
    let built = session.call(
        "resource.create_tileset",
        json!({
            "path": "res://tiles/world.tres",
            "texture": "res://tiles.png",
            "tileSize": 16,
            "solid": [[0, 0], [1, 0], [4, 0], [5, 0]]
        }),
    );
    assert_eq!(
        built["grid"],
        json!([8, 2]),
        "the atlas is eight by two: {built}"
    );
    assert_eq!(built["tiles"].as_array().expect("tiles").len(), 16);
    assert_eq!(
        built["physicsLayers"], 1,
        "solid tiles need a physics layer"
    );
    assert_eq!(built["replaced"], false);

    // What the caller reads back before painting, which is where the tile coordinates come from.
    let described = session.call(
        "resource.describe_tileset",
        json!({"path": "res://tiles/world.tres"}),
    );
    assert_eq!(described["tileSize"], json!([16, 16]));
    let tiles = described["sources"][0]["tiles"]
        .as_array()
        .expect("the tileset's tiles");
    assert_eq!(tiles.len(), 16, "{described}");
    let solid: Vec<&Value> = tiles
        .iter()
        .filter(|tile| tile["solid"] == json!(true))
        .collect();
    assert_eq!(
        solid.len(),
        4,
        "only the four named tiles collide: {described}"
    );

    let scene = "res://level.tscn";
    session.mutate("scene.create", json!({"path": scene, "rootType": "Node2D"}));
    session.mutate(
        "node.create",
        json!({"parent": "/level", "name": "Terrain", "type": "TileMapLayer"}),
    );

    // A layer with no tileset cannot be painted, and the refusal has to say what to do about it.
    let bare = session.error(
        "node.set_cells",
        json!({"node": "/level/Terrain", "cells": [{"x": 0, "y": 0, "atlas": [0, 0]}]}),
        Some(session.revision()),
    );
    assert!(
        bare.starts_with("tileset_missing") && bare.contains("create_tileset"),
        "the refusal must name the way out: {bare}"
    );

    session.mutate(
        "node.set_property",
        json!({
            "node": "/level/Terrain",
            "property": "tile_set",
            "value": {"type": "resource", "value": {"path": "res://tiles/world.tres"}}
        }),
    );

    // A tile the tileset does not define draws nothing at all, so it is refused rather than
    // painted: `set_cell` takes any coordinate and leaves an empty layer that looks painted.
    let missing = session.error(
        "node.set_cells",
        json!({"node": "/level/Terrain", "cells": [{"x": 0, "y": 0, "atlas": [40, 40]}]}),
        Some(session.revision()),
    );
    assert!(
        missing.starts_with("tile_not_defined") && missing.contains("describe_tileset"),
        "a tile outside the atlas must be refused by name: {missing}"
    );

    // The ground of a level is one rectangle, not two hundred cells.
    let painted = session.mutate(
        "node.set_cells",
        json!({
            "node": "/level/Terrain",
            "cells": [
                {"x": 0, "y": 12, "width": 40, "height": 2, "atlas": [0, 0]},
                {"x": 20, "y": 8, "width": 3, "atlas": [1, 0]},
                {"x": 30, "y": 10, "atlas": [4, 0]},
                {"x": 31, "y": 10, "atlas": [5, 0]}
            ]
        }),
    );
    assert_eq!(painted["painted"], 85, "{painted}");
    assert_eq!(painted["cells"], 85);
    assert_eq!(painted["usedRect"], json!([0, 8, 40, 6]), "{painted}");
    assert_eq!(painted["tileSet"], "res://tiles/world.tres");

    // Read back through the command a caller checks its own work with.
    let read = session.call(
        "node.get_cells",
        json!({"node": "/level/Terrain", "limit": 4}),
    );
    assert_eq!(read["cells"], 85);
    assert_eq!(read["cellsListed"].as_array().expect("cells").len(), 4);
    assert_eq!(read["truncated"], true);
    // The tally covers every cell even when the list is cut short, which is the only way to say
    // what a level-sized layer is made of.
    let mut painted_tiles: Vec<(Value, u64)> = read["tiles"]
        .as_array()
        .expect("the tile tally")
        .iter()
        .map(|tile| {
            (
                tile["atlas"].clone(),
                tile["count"].as_u64().expect("count"),
            )
        })
        .collect();
    painted_tiles.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    assert_eq!(painted_tiles[0], (json!([0, 0]), 80), "{read}");
    assert_eq!(
        painted_tiles.len(),
        4,
        "four different tiles were painted: {read}"
    );

    // An entry with no atlas erases, which is how a level gets the gap Mario falls down.
    let erased = session.mutate(
        "node.set_cells",
        json!({
            "node": "/level/Terrain",
            "cells": [{"x": 10, "y": 12, "width": 2, "height": 2}]
        }),
    );
    assert_eq!(erased["erased"], 4, "{erased}");
    assert_eq!(erased["cells"], 81);

    // Painting is an editor action like any other, so it takes back.
    session.mutate("session.undo", json!({}));
    assert_eq!(
        session.call("node.get_cells", json!({"node": "/level/Terrain"}))["cells"],
        85,
        "undo must put the erased cells back"
    );

    session.mutate("scene.save", json!({}));
    let saved = std::fs::read_to_string(session.worktree.join("level.tscn"))
        .expect("the saved scene must exist on disk");
    assert!(
        saved.contains("tile_map_data = PackedByteArray("),
        "the saved scene must carry the painted cells: {saved}"
    );
    assert!(
        saved.contains("[ext_resource type=\"TileSet\"")
            && saved.contains("path=\"res://tiles/world.tres\"")
            && saved.contains("tile_set = ExtResource("),
        "the saved scene must reference the tileset rather than embed one: {saved}"
    );

    // A cell command only means anything on a layer, and says so rather than doing nothing.
    let wrong = session.error("node.get_cells", json!({"node": "/level"}), None);
    assert!(
        wrong.starts_with("wrong_node_type") && wrong.contains("TileMapLayer"),
        "a node that is not a layer must be refused by name: {wrong}"
    );
}

/// An asset written into the worktree after the editor started is loadable the moment
/// `resource.rescan` answers — by name, redrawn, and for the project as a whole.
///
/// Both halves were broken, and both broke the same caller in the same way. `update_file` alone
/// registers a file and stops there: an image that arrived after startup got no `.import` and no
/// imported texture, so `load` answered nothing for it, not for a moment but permanently — a probe
/// asked 195 times over twenty seconds and was refused every time. The project-wide form did
/// import, but `scan()` is threaded and the answer left on the frame the call returned, so the
/// asset was still not there for the first hundred milliseconds after `scanned: true`.
///
/// What a caller does with either is the same thing: write a sprite, rescan, ask for the sprite,
/// be told it does not exist, rescan again. That is the hammering this test exists to keep out.
#[test]
fn the_addon_imports_an_asset_that_arrives_after_startup() {
    /// The live fixture's own art, which is a real 8x2 atlas of 16x16 tiles.
    const ATLAS: &[u8] = include_bytes!("../../fixtures/live-project/assets/tiles.png");
    /// A 48x16 PNG built here: a 3x1 grid of the same tile size, so a stale import is visible as
    /// the grid the addon reports rather than as pixels no assertion can see.
    const NARROW: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 48, 0, 0, 0, 16, 8,
        6, 0, 0, 0, 80, 174, 252, 177, 0, 0, 0, 52, 73, 68, 65, 84, 120, 156, 237, 207, 177, 13, 0,
        0, 8, 128, 48, 254, 127, 90, 143, 112, 32, 38, 12, 236, 133, 129, 249, 28, 54, 160, 1, 27,
        208, 128, 13, 104, 192, 6, 52, 96, 3, 26, 176, 1, 13, 216, 128, 6, 108, 192, 181, 5, 248,
        211, 250, 76, 51, 158, 110, 185, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];

    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    // Named on its own: the editor never walked this file, so the rescan has to import it.
    std::fs::write(worktree.join("named.png"), ATLAS).expect("write the named atlas");
    session.call("resource.rescan", json!({"path": "res://named.png"}));
    let named = session
        .try_call(
            "resource.create_tileset",
            json!({"path": "res://named.tres", "texture": "res://named.png", "tileSize": 16}),
            None,
        )
        .expect("a named rescan must leave the asset loadable");
    assert_eq!(named["grid"], json!([8, 2]), "{named}");

    // The project-wide form, which must not answer while the scan it started is still running.
    std::fs::write(worktree.join("swept.png"), ATLAS).expect("write the swept atlas");
    session.call("resource.rescan", json!({}));
    let swept = session
        .try_call(
            "resource.create_tileset",
            json!({"path": "res://swept.tres", "texture": "res://swept.png", "tileSize": 16}),
            None,
        )
        .expect("a project rescan must not answer before its own scan has landed");
    assert_eq!(swept["grid"], json!([8, 2]), "{swept}");

    // Redrawn art over the same path. The file has an `.import` beside it by now, so it looks
    // settled and `load` answers — with the old pixels. `update_file` does not re-run an importer,
    // and a project scan only notices a timestamp that moved, which a rewrite inside one second
    // does not. An agent iterating on a sprite saw its first draft for the rest of the session.
    std::fs::write(worktree.join("named.png"), NARROW).expect("redraw the named atlas");
    session.call("resource.rescan", json!({"path": "res://named.png"}));
    let redrawn = session.call(
        "resource.create_tileset",
        json!({"path": "res://redrawn.tres", "texture": "res://named.png", "tileSize": 16}),
    );
    assert_eq!(
        redrawn["grid"],
        json!([3, 1]),
        "a rescan must see the pixels on disk now, not the ones imported before: {redrawn}"
    );

    // An asset that leaves the worktree — moved away, or deleted — does not stop existing when its
    // file does: the editor's import of it still sits under `.godot`, so `load` keeps answering.
    // Tilesets were cut from textures that were no longer in the project, and reported as
    // successes. A rescan of the path it left is what makes the editor let go, which is why
    // `ai_tools::tell_the_editor_the_worktree_moved` runs one after every move and delete.
    std::fs::remove_file(worktree.join("swept.png")).expect("delete the swept atlas");
    session.call("resource.rescan", json!({"path": "res://swept.png"}));
    let vanished = session.error(
        "resource.create_tileset",
        json!({"path": "res://vanished.tres", "texture": "res://swept.png", "tileSize": 16}),
        None,
    );
    assert!(
        vanished.starts_with("texture_not_found"),
        "a deleted texture must stop being a texture: {vanished}"
    );

    // An image nobody wrote is still missing, and the refusal names the step that would fix it.
    let missing = session.error(
        "resource.create_tileset",
        json!({"path": "res://absent.tres", "texture": "res://absent.png", "tileSize": 16}),
        None,
    );
    assert!(
        missing.starts_with("texture_not_found") && missing.contains("resource.rescan"),
        "the refusal must name the way out: {missing}"
    );
}

/// The addon answers `session.cancel`, which the protocol has specified since version 2.
///
/// Gofer sends it when a caller walks away — `godot_rpc::a_stopped_turn_tells_the_addon_to_give_up`
/// covers that half on the wire. This half is that the command exists in the editor at all: it was
/// in the frozen spec, with a golden fixture, and the addon answered `unknown_command` for it.
///
/// Retracting a request the addon is really holding is
/// [`the_addon_gives_up_a_request_it_is_still_holding`].
#[test]
fn the_addon_answers_a_cancellation() {
    let mut session = Session::start();
    session.mutate(
        "scene.create",
        json!({"path": "res://cancelled.tscn", "rootType": "Node2D"}),
    );

    // Nothing is parked, so there is nothing to retract — and that is an answer, not an error: the
    // caller gave up and the reply crossed it on the way.
    let unknown = session.call("session.cancel", json!({"requestId": "never-sent"}));
    assert_eq!(unknown["requestId"], "never-sent");
    assert_eq!(unknown["cancelled"], false);

    assert!(
        session
            .error("session.cancel", json!({}), None)
            .starts_with("invalid_params"),
        "a cancellation naming no request must be refused"
    );

    // Cancelling nothing changes nothing: the session is still editing what it was.
    assert_eq!(
        session.call("session.get_state", json!({}))["state"],
        "ready"
    );
    session.mutate(
        "node.create",
        json!({"parent": "/cancelled", "name": "After", "type": "Node2D"}),
    );
}

/// A game whose main scene spins its own thread the moment it loads. The process is up and the
/// editor is playing it, so the launch is not over; nothing will ever come back from it, so the
/// launch is not finished either. That is a parked request that no editor state can retract.
const SPINNING_MAIN_SCRIPT: &str =
    "extends Node2D\n\nfunc _ready() -> void:\n\twhile true:\n\t\tpass\n";
const SPINNING_MAIN_SCENE: &str = "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://scripts/spin.gd\" id=\"1_spin\"]\n\n[node name=\"Spinning\" type=\"Node2D\"]\nscript = ExtResource(\"1_spin\")\n";

/// A request the addon is really holding is retracted, and answers its caller.
///
/// This is the case `session.cancel` exists for, and the one that was uncovered: a scene switch
/// could not be made to park — Godot 4.7 opens a scene with a missing parent by dropping the
/// orphan, and one whose root names an unknown class by substituting a placeholder, so both
/// answered at once. A launch does park, and the game has to be the reason it does: the editor
/// refusing to start one is now answered on the spot, because a main scene that is missing or is
/// not a scene puts a dialog on the editor rather than a game on the screen.
#[test]
fn the_addon_gives_up_a_request_it_is_still_holding() {
    const PARKED: &str = "acceptance-parked-launch";

    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(worktree.join("scripts/spin.gd"), SPINNING_MAIN_SCRIPT)
        .expect("write the spinning script");
    std::fs::write(worktree.join("main.tscn"), SPINNING_MAIN_SCENE)
        .expect("write the spinning main scene");
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree, ledger, Some(directory));

    // The launch is issued from its own thread because it does not answer until it is cancelled,
    // and the cancellation has to be sent while it is waiting.
    let rpc = session.rpc().clone();
    let launch = thread::spawn(move || {
        // Longer than the addon's own launch budget, so a park that is never retracted fails this
        // test as a timeout of the addon's making rather than of the transport's.
        rpc.call(
            CallRequest::new("runtime.run", json!({}))
                // Named rather than minted: the cancellation below has to reach this exact request
                // while it is still parked, so the test has to know its id in advance.
                .named(PARKED)
                .within(Some(60_000)),
        )
    });

    // The addon has to be holding it before it can give it up, and nothing announces that it is.
    // So the cancellation is retried until it takes: `cancelled: false` means the request has not
    // arrived yet, which is the same answer it gives for a request that never existed.
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut answer = json!({});
    while Instant::now() < deadline {
        answer = session.call("session.cancel", json!({"requestId": PARKED}));
        if answer["cancelled"] == json!(true) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(
        answer["cancelled"],
        json!(true),
        "the parked launch must be retracted: {answer}\n--- editor output ---\n{}",
        session.output()
    );

    // The caller is answered rather than left to its own timeout — that is the point of the
    // command, and it is the difference between stopping a turn and waiting out the launch.
    let error = launch
        .join()
        .expect("the parked call returns")
        .expect_err("a cancelled request must fail rather than answer");
    assert_eq!(error.code, "cancelled", "{}", error.message);

    // And the session is usable straight afterwards: readiness came back with the request.
    assert_eq!(
        session.call("session.get_state", json!({}))["state"],
        "ready"
    );

    // Cancelling the request did not stop the game it started, and a game spinning its main thread
    // outlives the editor that launched it unless the editor kills it.
    session.call("runtime.stop", json!({}));
    session.await_stopped();
}

/// A level built the way Godot projects are built: one scene, placed more than once.
///
/// `node.create` reaches `ClassDB` and nothing else, so before this the only way to repeat a thing
/// in a level was to rebuild it node by node — seven bricks meant twenty-one nodes, and changing
/// what a brick is reached none of them. What proves this is an instance rather than a copy is the
/// saved file: the children collapse into a single `instance=ExtResource(…)` line.
#[test]
fn the_addon_places_instances_of_a_saved_scene() {
    let mut session = Session::start();

    session.mutate(
        "scene.create",
        json!({"path": "res://brick.tscn", "rootType": "StaticBody2D"}),
    );
    session.mutate(
        "node.create",
        json!({"parent": "/brick", "name": "CollisionShape2D", "type": "CollisionShape2D"}),
    );
    session.mutate("scene.save", json!({}));

    session.mutate(
        "scene.create",
        json!({"path": "res://level.tscn", "rootType": "Node2D"}),
    );
    for name in ["Brick1", "Brick2"] {
        let placed = session.mutate(
            "node.instantiate",
            json!({"parent": "/level", "path": "res://brick.tscn", "name": name}),
        );
        assert_eq!(placed["node"], format!("/level/{name}"));
    }
    assert_eq!(
        child_names(&session.call("scene.get_tree", json!({}))),
        vec!["Brick1".to_owned(), "Brick2".to_owned()]
    );

    // A path written the way the project spells it, which is what the tools tell the model to
    // write. Godot answers `scene_file_path` as `res://…` however it was asked, so the read-back
    // compared `brick.tscn` against `res://brick.tscn` and refused a scene it had just placed
    // correctly — watched in a live turn building three coins.
    let bare = session.mutate(
        "node.instantiate",
        json!({"parent": "/level", "path": "brick.tscn", "name": "Brick3"}),
    );
    assert_eq!(bare["node"], "/level/Brick3");
    assert_eq!(
        bare["path"], "res://brick.tscn",
        "the answer names the scene the way the editor does: {bare}"
    );

    session.mutate("scene.save", json!({}));
    let saved = std::fs::read_to_string(session.worktree.join("level.tscn"))
        .expect("the saved level must exist on disk");
    assert!(
        saved.contains("[ext_resource type=\"PackedScene\"") && saved.contains("res://brick.tscn"),
        "the level must reference the scene it instantiated: {saved}"
    );
    assert_eq!(
        saved.matches("instance=ExtResource(").count(),
        3,
        "all three placements must be instances: {saved}"
    );
    // A copy would write the brick's own children into this file. An instance does not, which is
    // exactly what makes one edit to brick.tscn reach every placement of it.
    assert!(
        !saved.contains("parent=\"Brick1\""),
        "an instance must not write the source scene's children into the level: {saved}"
    );

    // One undo takes back one placement, and the third brick was placed last.
    session.mutate("session.undo", json!({}));
    assert_eq!(
        child_names(&session.call("scene.get_tree", json!({}))),
        vec!["Brick1".to_owned(), "Brick2".to_owned()],
        "undo must take the placement back"
    );
}

/// What instancing refuses, starting with the one that cannot be undone by reopening the file.
#[test]
fn the_addon_refuses_an_instance_that_would_contain_itself() {
    let mut session = Session::start();

    session.mutate(
        "scene.create",
        json!({"path": "res://inner.tscn", "rootType": "Node2D"}),
    );
    session.mutate("scene.save", json!({}));
    session.mutate(
        "scene.create",
        json!({"path": "res://outer.tscn", "rootType": "Node2D"}),
    );
    session.mutate(
        "node.instantiate",
        json!({"parent": "/outer", "path": "res://inner.tscn", "name": "Inner"}),
    );
    session.mutate("scene.save", json!({}));
    let current = session.revision();

    // Straight into itself. Saved, this file could never be opened again: the loader recurses until
    // it runs out of stack, and the failure lands on whoever opens it next.
    assert!(
        session
            .error(
                "node.instantiate",
                json!({"parent": "/outer", "path": "res://outer.tscn"}),
                Some(current)
            )
            .starts_with("recursive_instance"),
        "a scene must not be instantiated inside itself"
    );

    // The same trap one step further out: inner holds nothing, but outer holds inner, so putting
    // outer inside inner would close the loop.
    session.open_scene("res://inner.tscn");
    let inner_revision = session.revision();
    assert!(
        session
            .error(
                "node.instantiate",
                json!({"parent": "/inner", "path": "res://outer.tscn"}),
                Some(inner_revision)
            )
            .starts_with("recursive_instance"),
        "a scene that reaches the edited one through its own dependencies must be refused"
    );

    assert!(
        session
            .error(
                "node.instantiate",
                json!({"parent": "/inner", "path": "res://nothing.tscn"}),
                Some(inner_revision)
            )
            .starts_with("invalid_scene"),
        "a path that is not a loadable scene must be refused"
    );
    assert!(
        session
            .error(
                "node.instantiate",
                json!({"parent": "/inner/Missing", "path": "res://outer.tscn"}),
                Some(inner_revision)
            )
            .starts_with("node_not_found"),
        "an unknown parent must be refused"
    );

    assert_eq!(
        session.revision(),
        inner_revision,
        "a refused command must not bump the revision"
    );
}

/// What the wiring commands refuse, which is what stops a scene that looks right from doing nothing.
#[test]
fn the_addon_refuses_wiring_that_would_never_fire() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    std::fs::write(
        worktree.join("wiring.gd"),
        "extends Node2D\n\n\nfunc _on_coin_body_entered(_body: Node2D) -> void:\n\tpass\n",
    )
    .expect("write the handler script");
    let ledger = directory.path().join("ledger.json");
    let mut session = Session::start_on_worktree(worktree, ledger, Some(directory));

    let scene = "res://refused_wiring.tscn";
    session.mutate("scene.create", json!({"path": scene, "rootType": "Node2D"}));
    session.mutate(
        "node.set_property",
        json!({
            "node": "/refused_wiring",
            "property": "script",
            "value": {"type": "resource", "value": {"path": "res://wiring.gd"}}
        }),
    );
    session.mutate(
        "node.create",
        json!({"parent": "/refused_wiring", "name": "Coin", "type": "Area2D"}),
    );
    let current = session.revision();
    let coin = "/refused_wiring/Coin";

    assert!(
        session
            .error(
                "node.connect_signal",
                json!({"node": coin, "signal": "nonsense", "method": "_on_coin_body_entered"}),
                Some(current)
            )
            .starts_with("signal_not_found"),
        "a signal the node cannot emit must be refused"
    );
    // `Object.connect` takes a method the target does not have and says so only when the signal
    // first fires — in the running game, as an error with no author.
    // The root carries the script, so the refusal names what that script really declares. Two live
    // turns were told only `\/Pickup has no method _on_body_entered to receive body_entered`, twice
    // each, which is true and repairs nothing.
    let absent = session.error(
        "node.connect_signal",
        json!({"node": coin, "signal": "body_entered", "method": "_on_nothing"}),
        Some(current),
    );
    assert!(
        absent.starts_with("method_not_found"),
        "a method the target does not have must be refused: {absent}"
    );
    assert!(
        absent.contains("_on_coin_body_entered") && absent.contains("target"),
        "and the refusal names what the script does declare, and where a method may live: {absent}"
    );

    assert!(
        session
            .error(
                "node.disconnect_signal",
                json!({"node": coin, "signal": "body_entered", "method": "_on_coin_body_entered"}),
                Some(current)
            )
            .starts_with("not_connected"),
        "disconnecting what was never connected must be refused"
    );
    assert!(
        session
            .error(
                "node.remove_from_group",
                json!({"node": coin, "group": "coins"}),
                Some(current)
            )
            .starts_with("group_not_found"),
        "removing a group the node is not in must be refused"
    );
    // A target with no script at all is the commonest reason there is no method, and says so.
    session.mutate(
        "node.create",
        json!({"parent": "/refused_wiring", "name": "Bare", "type": "Node2D"}),
    );
    let scriptless = session.error(
        "node.connect_signal",
        json!({
            "node": coin,
            "signal": "body_entered",
            "method": "_on_nothing",
            "target": "/refused_wiring/Bare"
        }),
        Some(session.revision()),
    );
    assert!(
        scriptless.contains("No script is attached"),
        "a target with no script has no methods of its own, and the refusal says so: {scriptless}"
    );

    session.mutate(
        "node.connect_signal",
        json!({"node": coin, "signal": "body_entered", "method": "_on_coin_body_entered"}),
    );
    let repeated = session.revision();
    assert!(
        session
            .error(
                "node.connect_signal",
                json!({"node": coin, "signal": "body_entered", "method": "_on_coin_body_entered"}),
                Some(repeated)
            )
            .starts_with("already_connected"),
        "connecting the same pair twice must be refused"
    );

    assert_eq!(
        session.revision(),
        repeated,
        "a refused command must not bump the revision"
    );
}

/// Finds the one entry in a `{"settings": [...]}`-style result array whose `name` matches.
/// The same lookup, for asserting that something is *not* listed.
fn find_named_or_none<'a>(result: &'a Value, field: &str, name: &str) -> Option<&'a Value> {
    result[field]
        .as_array()
        .unwrap_or_else(|| panic!("{field} must be an array in {result}"))
        .iter()
        .find(|entry| entry["name"] == name)
}

fn find_named<'a>(result: &'a Value, field: &str, name: &str) -> &'a Value {
    result[field]
        .as_array()
        .unwrap_or_else(|| panic!("{field} must be an array in {result}"))
        .iter()
        .find(|entry| entry["name"] == name)
        .unwrap_or_else(|| panic!("no {field} entry named {name} in {result}"))
}

#[test]
fn configuration_editors_persist_across_restarts_and_clean_up() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");

    {
        let session = Session::start_on_worktree(worktree.clone(), ledger.clone(), None);

        // Typed reads: values cross the wire tagged, and restart-required settings are marked.
        let name = session.call(
            "project.get_setting",
            json!({"name": "application/config/name"}),
        );
        assert_eq!(
            name["value"],
            json!({"type": "string", "value": "Gofer Protocol Fixture"})
        );
        assert_eq!(name["restartRequired"], false);

        let restart = session.call(
            "project.search_settings",
            json!({"query": "text_to_speech"}),
        );
        assert_eq!(
            find_named(&restart, "settings", "audio/general/text_to_speech")["restartRequired"],
            true,
            "a restart-required setting must say so"
        );
        let search = session.call("project.search_settings", json!({"query": "rendering"}));
        assert!(
            search["totalMatches"].as_u64().expect("totalMatches")
                >= search["settings"].as_array().expect("settings").len() as u64
        );

        // A settings name is slashes and underscores and never a space, so a query matched as one
        // substring makes every natural way of asking a guaranteed miss. One live turn asked for
        // "line numbers", "split mode", "grid step", "filesystem split", "2d snap" and eight more,
        // got nothing every time, and concluded two of the three things it wanted were not
        // settings at all. Every word, in any order, is what a person means.
        // A setting that does not exist points at the search that finds one. Two live turns met
        // `setting_not_found` and had nothing to do with it but guess again.
        let absent = session.error(
            "project.get_setting",
            json!({"name": "physics/3d/.gravity"}),
            None,
        );
        assert!(
            absent.contains("project.search_settings"),
            "the refusal has to name the call that finds the real name: {absent}"
        );

        let spoken = session.call("project.search_settings", json!({"query": "text speech"}));
        assert!(
            find_named(&spoken, "settings", "audio/general/text_to_speech")["name"]
                == "audio/general/text_to_speech",
            "a two-word query has to reach a name that holds both: {spoken}"
        );
        // One word is still the substring match it always was, and order does not matter.
        let backwards = session.call(
            "project.search_settings",
            json!({"query": "speech general"}),
        );
        assert_eq!(
            backwards["totalMatches"], spoken["totalMatches"],
            "the order of the words is not part of the question"
        );
        let missing = session.call(
            "project.search_settings",
            json!({"query": "text nosuchword"}),
        );
        assert_eq!(
            missing["totalMatches"], 0,
            "every word has to be there: {missing}"
        );

        // Set persists to project.godot immediately; reading it back proves the round trip.
        let set = session.call(
            "project.set_setting",
            json!({
                "name": "gofer_acceptance/persisted",
                "value": {"type": "string", "value": "survives-restart"}
            }),
        );
        assert_eq!(set["saved"], true);
        assert_eq!(set["restartRequired"], false);

        // A custom setting has no default, so resetting it removes it entirely.
        session.call(
            "project.set_setting",
            json!({"name": "gofer_acceptance/temporary", "value": {"type": "int", "value": 7}}),
        );
        let reset = session.call(
            "project.reset_setting",
            json!({"name": "gofer_acceptance/temporary"}),
        );
        assert_eq!(reset["exists"], false);
        assert!(
            session
                .error(
                    "project.get_setting",
                    json!({"name": "gofer_acceptance/temporary"}),
                    None
                )
                .starts_with("setting_not_found")
        );

        // Settings with typed commands refuse the generic write path.
        assert!(
            session
                .error(
                    "project.set_setting",
                    json!({"name": "input/bypass", "value": {"type": "null"}}),
                    None
                )
                .starts_with("reserved_setting")
        );

        // A setting the engine declared keeps the type it declared.
        assert!(
            session
                .error(
                    "project.set_setting",
                    json!({"name": "application/config/name", "value": {"type": "int", "value": 5}}),
                    None
                )
                .starts_with("type_mismatch"),
            "an int must not land on a String setting"
        );
        assert_eq!(
            session.call(
                "project.get_setting",
                json!({"name": "application/config/name"})
            )["value"],
            json!({"type": "string", "value": "Gofer Protocol Fixture"}),
            "a refused write must leave the setting alone"
        );

        // A packed array crosses the wire as a plain array and is rebuilt from the type the
        // setting was declared with, so a value read out can be written straight back.
        let tags = session.call(
            "project.get_setting",
            json!({"name": "application/config/tags"}),
        );
        assert_eq!(tags["value"], json!({"type": "array", "value": []}));
        session.call(
            "project.set_setting",
            json!({
                "name": "application/config/tags",
                "value": {"type": "array", "value": [{"type": "string", "value": "gofer-acceptance"}]}
            }),
        );
        assert_eq!(
            session.call(
                "project.get_setting",
                json!({"name": "application/config/tags"})
            )["value"],
            json!({"type": "array", "value": [{"type": "string", "value": "gofer-acceptance"}]})
        );
        assert!(
            session
                .error(
                    "project.set_setting",
                    json!({
                        "name": "application/config/tags",
                        "value": {"type": "array", "value": [{"type": "int", "value": 3}]}
                    }),
                    None
                )
                .starts_with("type_mismatch"),
            "a mistyped element must be refused, not coerced"
        );

        // Search answers with settings only: the property list opens with a category header.
        let searched = session.call("project.search_settings", json!({"query": ""}));
        for entry in searched["settings"].as_array().expect("settings") {
            let name = entry["name"].as_str().expect("name");
            session.call("project.get_setting", json!({"name": name}));
        }

        // Autoloads: Gofer's own is visible but protected; ordinary ones come and go.
        let autoloads = session.call("project.list_autoloads", json!({}));
        let managed = find_named(&autoloads, "autoloads", "GoferRuntime");
        assert_eq!(managed["goferManaged"], true);
        assert_eq!(managed["enabled"], true);
        session.call(
            "project.set_autoload",
            json!({"name": "AcceptanceHelper", "path": "res://tests/protocol_test.gd"}),
        );
        assert!(
            session
                .error(
                    "project.set_autoload",
                    json!({"name": "Ghost", "path": "res://nothing_is_here.gd"}),
                    None
                )
                .starts_with("autoload_path_not_found"),
            "an autoload that points nowhere breaks the next editor start"
        );
        assert_eq!(
            find_named(
                &session.call("project.list_autoloads", json!({})),
                "autoloads",
                "AcceptanceHelper"
            )["enabled"],
            true
        );
        session.call(
            "project.remove_autoload",
            json!({"name": "AcceptanceHelper"}),
        );
        assert!(
            session.call("project.list_autoloads", json!({}))["autoloads"]
                .as_array()
                .expect("autoloads")
                .iter()
                .all(|entry| entry["name"] != "AcceptanceHelper")
        );
        assert!(
            session
                .error(
                    "project.remove_autoload",
                    json!({"name": "GoferRuntime"}),
                    None
                )
                .starts_with("gofer_managed")
        );

        // A setting written with dots where Godot uses slashes is a different setting, and the
        // difference is invisible: it saves, it reads back, and the one that governs the project is
        // untouched. A live agent set `application.run.main_scene`, was told `saved: true`, read its
        // own value back to confirm it, and the game went on running the scene it always had.
        let mistyped = session.error(
            "project.set_setting",
            json!({
                "name": "application.run.main_scene",
                "value": {"type": "string", "value": "res://acceptance.tscn"}
            }),
            None,
        );
        assert!(
            mistyped.starts_with("setting_not_found")
                && mistyped.contains("application/run/main_scene"),
            "a mistyped built-in must be refused by naming the one it meant: {mistyped}"
        );
        // A custom setting is not a mistake, so it is still allowed — and says it made one.
        let invented = session.call(
            "project.set_setting",
            json!({"name": "acceptance/custom_knob", "value": {"type": "int", "value": 7}}),
        );
        assert_eq!(invented["created"], true);
        let changed = session.call(
            "project.set_setting",
            json!({"name": "acceptance/custom_knob", "value": {"type": "int", "value": 8}}),
        );
        assert_eq!(
            changed["created"], false,
            "a setting that already existed was changed, not created"
        );

        // Input Map: actions round-trip as typed events, built-ins are marked and protected.
        let action = session.call(
            "project.set_input_action",
            json!({"name": "acceptance_jump", "events": [{"kind": "key", "key": "Space"}]}),
        );
        assert_eq!(action["deadzone"], json!(0.5));
        assert_eq!(action["events"], json!([{"kind": "key", "key": "Space"}]));
        let actions = session.call("project.list_input_actions", json!({}));
        assert_eq!(
            find_named(&actions, "actions", "acceptance_jump")["builtIn"],
            false
        );
        // A built-in nobody has touched is named rather than written out. Godot registers 72 of
        // them and four recorded live runs each read all 72, none of which the project had chosen.
        let untouched: Vec<&str> = actions["atEngineDefault"]
            .as_array()
            .unwrap_or_else(|| panic!("no atEngineDefault: {actions}"))
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(untouched.contains(&"ui_accept"), "{actions}");
        assert!(untouched.len() > 40, "{actions}");
        assert!(
            find_named_or_none(&actions, "actions", "ui_accept").is_none(),
            "{actions}"
        );
        // And naming it answers it in full, which is how its events are read.
        let asked = session.call(
            "project.list_input_actions",
            json!({"names": ["ui_accept", "acceptance_jump"]}),
        );
        assert_eq!(find_named(&asked, "actions", "ui_accept")["builtIn"], true);
        assert!(
            !find_named(&asked, "actions", "ui_accept")["events"]
                .as_array()
                .expect("events")
                .is_empty(),
            "{asked}"
        );
        assert_eq!(
            asked["actions"].as_array().expect("two").len(),
            2,
            "{asked}"
        );
        assert!(
            session
                .error(
                    "project.list_input_actions",
                    json!({"names": ["never_bound"]}),
                    None
                )
                .starts_with("action_not_found")
        );
        assert!(
            session
                .error(
                    "project.set_input_action",
                    json!({"name": "acceptance_bad", "events": [{"kind": "key", "key": "NotAKey"}]}),
                    None
                )
                .starts_with("unsupported_value")
        );
        session.call(
            "project.remove_input_action",
            json!({"name": "acceptance_jump"}),
        );
        assert!(
            session
                .error(
                    "project.remove_input_action",
                    json!({"name": "ui_accept"}),
                    None
                )
                .starts_with("builtin_input_action")
        );

        // A built-in action is rebound and then handed back: reset drops the override so the
        // engine's own binding applies again, which is why project.godot must not keep it.
        session.call(
            "project.set_input_action",
            json!({"name": "ui_accept", "events": [{"kind": "key", "key": "F9"}]}),
        );
        assert_eq!(
            find_named(
                &session.call("project.list_input_actions", json!({})),
                "actions",
                "ui_accept"
            )["events"],
            json!([{"kind": "key", "key": "F9"}])
        );
        assert_eq!(
            session.call("project.reset_input_action", json!({"name": "ui_accept"}))["reset"],
            true
        );
        assert!(
            session
                .error(
                    "project.reset_input_action",
                    json!({"name": "acceptance_custom"}),
                    None
                )
                .starts_with("custom_input_action"),
            "a custom action has no built-in binding to return to"
        );

        // The key names the catalog advertises are held to the engine by `godot_api_drift`, which
        // is its own gate: they can only break when the pinned Godot version moves.

        // Plugins: the Gofer plugin reports itself and refuses to be disabled mid-session.
        let plugins = session.call("project.list_plugins", json!({}));
        let gofer = find_named(&plugins, "plugins", "gofer");
        assert_eq!(gofer["enabled"], true);
        assert_eq!(gofer["goferManaged"], true);
        assert!(
            session
                .error(
                    "project.set_plugin_enabled",
                    json!({"plugin": "gofer", "enabled": false}),
                    None
                )
                .starts_with("gofer_managed")
        );
        assert!(
            session
                .error(
                    "project.set_plugin_enabled",
                    json!({"plugin": "missing", "enabled": true}),
                    None
                )
                .starts_with("plugin_not_found")
        );

        // Editor settings are machine-wide, so the write path is exercised by setting a value back
        // to itself: the developer's real settings file must not change under a test.
        let found = session.call("editor.search_settings", json!({"query": "font_size"}));
        let candidate = found["settings"]
            .as_array()
            .expect("settings")
            .iter()
            .find(|entry| entry["value"]["type"] == "int")
            .cloned()
            .expect("an integer editor setting about font sizes");
        let fetched = session.call("editor.get_setting", json!({"name": candidate["name"]}));
        assert_eq!(fetched["value"], candidate["value"]);
        let written = session.call(
            "editor.set_setting",
            json!({"name": candidate["name"], "value": candidate["value"]}),
        );
        assert_eq!(written["machineWide"], true);
    }
    // Dropping the session killed the editor and unstaged the addon.

    // The write survived in project.godot while every Gofer-owned entry was removed.
    let saved =
        std::fs::read_to_string(worktree.join("project.godot")).expect("saved project.godot");
    // Godot writes a dotted setting as a section plus a key, not as one literal line.
    assert!(
        saved.contains("[gofer_acceptance]") && saved.contains("persisted=\"survives-restart\""),
        "the setting must persist in project.godot:\n{saved}"
    );
    assert!(
        saved.contains("config/tags=PackedStringArray(\"gofer-acceptance\")"),
        "a packed array must persist as the type it was read as:\n{saved}"
    );
    for gone in [
        "GoferRuntime",
        "addons/gofer",
        "AcceptanceHelper",
        "acceptance_jump",
        "ui_accept",
    ] {
        assert!(
            !saved.contains(gone),
            "project.godot must not keep {gone} after cleanup:\n{saved}"
        );
    }

    // A fresh editor on the same worktree reads the value back.
    let restarted = Session::start_on_worktree(worktree, ledger, None);
    let persisted = restarted.call(
        "project.get_setting",
        json!({"name": "gofer_acceptance/persisted"}),
    );
    assert_eq!(
        persisted["value"],
        json!({"type": "string", "value": "survives-restart"}),
        "the setting must survive an editor restart"
    );
}

/// An editor setting written through `editor.set_setting` is still there in the next editor.
///
/// EditorSettings are machine-wide, and Godot 4.7.2 gives GDScript no way to write them: the
/// class exposes `set_setting` and nothing that flushes, which was checked against the pinned
/// binary's own `--doctool` dump. The engine saves them when the editor exits — and Gofer never
/// lets it, because stopping a session kills the child process outright. So every editor setting
/// an agent changed was applied to the live editor and thrown away at the end of the session,
/// while `editor.set_setting` answered as though it had been kept.
///
/// The two editors share a config home the test owns, because that is the only way to ask the
/// question at all. Every other editor this suite starts gets a throwaway one, so that the
/// developer running the suite does not find their own editor settings rewritten by a test.
#[test]
fn an_editor_setting_survives_the_editor_it_was_written_in() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let config_home = TempDir::new().expect("temporary editor config home");
    let transports = || Transports {
        editor_config_home: Some(config_home.path().to_path_buf()),
        ..Transports::default()
    };

    let written = {
        let mut session =
            Session::start_on_worktree_with(worktree.clone(), ledger.clone(), None, transports());
        let found = session.call("editor.search_settings", json!({"query": "font_size"}));
        let candidate = found["settings"]
            .as_array()
            .expect("settings")
            .iter()
            .find(|entry| entry["value"]["type"] == "int")
            .cloned()
            .expect("an integer editor setting about font sizes");
        let name = candidate["name"].as_str().expect("setting name").to_owned();
        let size = candidate["value"]["value"]
            .as_i64()
            .expect("an integer font size");
        // A value the default settings cannot already hold, so reading it back proves the write
        // rather than the default.
        let target = size + 7;
        let result = session.call(
            "editor.set_setting",
            json!({"name": name, "value": {"type": "int", "value": target}}),
        );
        assert_eq!(result["value"], json!({"type": "int", "value": target}));
        assert_eq!(result["machineWide"], true);
        // What `godot_session::stop` now does before it falls back to killing. Dropping the
        // session instead is the kill, and the kill is what used to throw the setting away.
        session.quit_editor();
        (name, target)
    };

    let session = Session::start_on_worktree_with(worktree, ledger, Some(directory), transports());
    let reread = session.call("editor.get_setting", json!({"name": written.0}));
    assert_eq!(
        reread["value"],
        json!({"type": "int", "value": written.1}),
        "the editor setting must survive the editor it was written in\n--- editor output ---\n{}",
        session.output()
    );
}

/// The rules the Godot tab enforces are rules a real editor takes, both on and off.
///
/// Six setting names, checked against the engine rather than against this repo's idea of it. A name
/// Godot does not have is answered `setting_not_found`, a value of the wrong kind is answered
/// `type_mismatch`, and a warning level the engine will not hold is answered by the addon's own
/// read-back — so a typo in any of the six fails here rather than in an editor that quietly ignored
/// what Gofer asked for. The off half matters as much as the on half: it is what unticking a box in
/// the settings dialog has to undo.
#[test]
fn the_editor_takes_every_rule_gofer_enforces() {
    use crate::godot_policy::{GAME_EMBED_MODE, STRICT_TYPING_WARNINGS, policy_calls};
    use crate::settings::GodotSettings;

    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let config_home = TempDir::new().expect("temporary editor config home");
    let mut session = Session::start_on_worktree_with(
        worktree,
        ledger,
        None,
        Transports {
            editor_config_home: Some(config_home.path().to_path_buf()),
            ..Transports::default()
        },
    );

    let apply = |session: &mut Session, settings: GodotSettings| {
        for call in policy_calls(&settings) {
            session.call(call.command, call.params);
        }
    };
    let reads_as = |session: &mut Session, name: &str, command: &str| -> Value {
        session.call(command, json!({"name": name}))["value"].clone()
    };

    apply(
        &mut session,
        GodotSettings {
            strict_typing: true,
            embed_game_window: true,
        },
    );
    for warning in STRICT_TYPING_WARNINGS {
        assert_eq!(
            reads_as(&mut session, warning, "project.get_setting"),
            json!({"type": "int", "value": 2}),
            "{warning} must read as Error\n--- editor output ---\n{}",
            session.output()
        );
    }
    // 1 is Embed Game. 2 also embeds and then floats the workspace back out of the editor, which is
    // the opposite of what the rule is for.
    assert_eq!(
        reads_as(&mut session, GAME_EMBED_MODE, "editor.get_setting"),
        json!({"type": "int", "value": 1}),
        "the game must be embedded\n--- editor output ---\n{}",
        session.output()
    );

    apply(
        &mut session,
        GodotSettings {
            strict_typing: false,
            embed_game_window: false,
        },
    );
    for warning in STRICT_TYPING_WARNINGS {
        assert_eq!(
            reads_as(&mut session, warning, "project.get_setting"),
            json!({"type": "int", "value": 0}),
            "{warning} must go back to Ignore\n--- editor output ---\n{}",
            session.output()
        );
    }
    assert_eq!(
        reads_as(&mut session, GAME_EMBED_MODE, "editor.get_setting"),
        json!({"type": "int", "value": 0}),
        "the embed mode must go back to per-project\n--- editor output ---\n{}",
        session.output()
    );
}

/// Every asset of a batch is importable, however many rescans a caller sends at once.
///
/// A live run wrote eight PNGs into a directory `bash mkdir` had made and rescanned all eight in
/// one batch, as an agent naturally does. Seven answered `scanned: true` in half a second and one
/// took three and a half. Only the slow one ended up with an `.import` beside it, and only that
/// texture could be cut into a tileset: the other seven were refused `texture_not_found` and
/// advised to rescan, which is the loop this whole command exists to end.
#[test]
fn the_addon_imports_every_asset_of_a_batch_rescan() {
    const ATLAS: &[u8] = include_bytes!("../../fixtures/live-project/assets/tiles.png");
    let names = ["tileset", "mario", "goomba", "koopa", "castle", "bush"];

    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    // The directory is put into the editor's tree *before* any art is written into it, which is
    // the state the live run was in and the only state in which a by-path rescan takes the
    // `update_file` path at all. A directory the editor has never seen falls back to a project
    // walk, and a project walk imports everything it finds — so a test that skips this step
    // never reaches the code that broke.
    let assets = worktree.join("assets");
    std::fs::create_dir_all(&assets).expect("create the assets directory");
    std::fs::write(assets.join("gen.py"), "# generator\n").expect("write the generator");
    session.call("resource.rescan", json!({"path": "res://assets/gen.py"}));

    for name in names {
        std::fs::write(assets.join(format!("{name}.png")), ATLAS).expect("write the atlas");
    }

    // One batch, the way an agent sends them: the answers must not depend on how many are in it.
    // They are staggered by a few milliseconds because that is how a batch really arrives — and
    // because a request that lands *during* another one's import is the case that broke.
    let rpc = session.rpc();
    thread::scope(|scope| {
        for (index, name) in names.iter().enumerate() {
            scope.spawn(move || {
                thread::sleep(Duration::from_millis(12 * index as u64));
                let answer = rpc
                    .call(
                        CallRequest::new(
                            "resource.rescan",
                            json!({"path": format!("res://assets/{name}.png")}),
                        )
                        .within(Some(60_000)),
                    )
                    .unwrap_or_else(|error| panic!("rescan {name} failed: {}", error.message));
                assert_eq!(answer.result["scanned"], true, "{}", answer.result);
            });
        }
    });

    assert_cuttable(&session, &assets_names(&names), "as separate calls");

    // And the shape the command is now for: everything just written, named in one call. The
    // engine's own `reimport_files` takes a list, and one call is the only way it imports one.
    let listed = ["brick", "pipe", "coin", "flag"];
    for name in listed {
        std::fs::write(assets.join(format!("{name}.png")), ATLAS).expect("write the atlas");
    }
    let batched = session.call(
        "resource.rescan",
        json!({"path": listed.iter().map(|name| format!("res://assets/{name}.png"))
            .collect::<Vec<String>>()}),
    );
    assert_eq!(batched["scanned"], true, "{batched}");
    assert_cuttable(&session, &assets_names(&listed), "as one listed call");
}

fn assets_names(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

/// Cuts every named atlas into a tileset and reports the ones the editor refuses, which is the
/// question a rescan's `scanned: true` is an answer to.
fn assert_cuttable(session: &Session, names: &[String], sent: &str) {
    let refused: Vec<String> = names
        .iter()
        .filter_map(|name| {
            session
                .try_call(
                    "resource.create_tileset",
                    json!({
                        "path": format!("res://assets/{name}.tres"),
                        "texture": format!("res://assets/{name}.png"),
                        "tileSize": 16
                    }),
                    None,
                )
                .err()
                .map(|error| format!("{name}: {error}"))
        })
        .collect();
    assert!(
        refused.is_empty(),
        "a rescan that answered `scanned: true` must leave its asset loadable, sent {sent}: \
         {refused:?}\n--- editor output ---\n{}",
        session.output()
    );
}

/// A rescan sent while the editor is already importing still imports its own file.
///
/// `EditorFileSystem::reimport_files` refuses outright while an import is running —
/// `ERR_FAIL_COND_MSG(importing, "Attempted to call reimport_files() recursively")` — and the
/// editor pumps its own main loop from inside that import, because the progress dialog runs
/// `Main::iteration()` when it opens and on every forced step. So the addon's `_process` runs
/// again while `importing` is set, answers the next request from the socket, and the
/// `reimport_files` it makes for that file is dropped on the floor with an error nobody reads.
///
/// The caller is told `scanned: true` for a file that was never imported. A live run wrote eight
/// PNGs and got seven of those answers.
#[test]
fn a_rescan_that_lands_during_an_import_still_imports_its_file() {
    const ATLAS: &[u8] = include_bytes!("../../fixtures/live-project/assets/tiles.png");

    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    std::fs::write(worktree.join("first.png"), ATLAS).expect("write the first atlas");
    std::fs::write(worktree.join("second.png"), ATLAS).expect("write the second atlas");

    // The second rescan is sent while the first one's import is running, which is the whole point:
    // sent together they are read in one frame and settled one after another, and the window this
    // test is about never opens.
    let rpc = session.rpc();
    thread::scope(|scope| {
        scope.spawn(|| {
            rpc.call(
                CallRequest::new(
                    "resource.rescan".to_owned(),
                    json!({"path": "res://first.png"}),
                )
                .within(Some(60_000)),
            )
            .expect("the first rescan");
        });
        scope.spawn(|| {
            thread::sleep(Duration::from_millis(15));
            rpc.call(
                CallRequest::new(
                    "resource.rescan".to_owned(),
                    json!({"path": "res://second.png"}),
                )
                .within(Some(60_000)),
            )
            .expect("the second rescan");
        });
    });

    let cut = session.try_call(
        "resource.create_tileset",
        json!({"path": "res://second.tres", "texture": "res://second.png", "tileSize": 16}),
        None,
    );
    assert!(
        cut.is_ok(),
        "a rescan answered from inside another one's import must still import its own file: \
         {cut:?}\n--- editor output ---\n{}",
        session.output()
    );
}

/// A parked project walk is answered by its own scan, not by somebody else's reimport.
///
/// The addon counts `filesystem_changed` to know when the walk it started has landed. The editor
/// emits that signal at the end of every `reimport_files` too, so a single-file rescan running
/// beside a parked walk moves the counter the walk is waiting on. The walk then answers
/// `scanned: true` while its own scan is still running, and the assets it was started for are not
/// there yet — which is the same lie by a different route.
#[test]
fn a_parked_project_walk_waits_for_its_own_scan() {
    const ATLAS: &[u8] = include_bytes!("../../fixtures/live-project/assets/tiles.png");

    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree.clone(), ledger, Some(directory));

    // A directory the editor has never walked, so only the project-wide form can register it, and
    // enough art in it that the walk cannot be over in a frame.
    let art = worktree.join("art");
    std::fs::create_dir_all(&art).expect("create the art directory");
    for index in 0..24 {
        std::fs::write(art.join(format!("tile_{index}.png")), ATLAS).expect("write the atlas");
    }
    // The file whose own rescan will emit `filesystem_changed` from its reimport while the walk
    // is parked behind its scan.
    std::fs::write(worktree.join("beside.png"), ATLAS).expect("write the atlas beside it");

    let rpc = session.rpc();
    thread::scope(|scope| {
        scope.spawn(|| {
            rpc.call(
                CallRequest::new("resource.rescan".to_owned(), json!({})).within(Some(60_000)),
            )
            .expect("the project walk");
        });
        scope.spawn(|| {
            thread::sleep(Duration::from_millis(15));
            rpc.call(
                CallRequest::new(
                    "resource.rescan".to_owned(),
                    json!({"path": "res://beside.png"}),
                )
                .within(Some(60_000)),
            )
            .expect("the rescan beside it");
        });
    });

    // The walk has answered. Everything it was walking over must be loadable now.
    let refused: Vec<String> = (0..24)
        .filter_map(|index| {
            session
                .try_call(
                    "resource.create_tileset",
                    json!({
                        "path": format!("res://art/tile_{index}.tres"),
                        "texture": format!("res://art/tile_{index}.png"),
                        "tileSize": 16
                    }),
                    None,
                )
                .err()
                .map(|error| format!("tile_{index}: {error}"))
        })
        .collect();
    assert!(
        refused.is_empty(),
        "a project rescan must not answer before its own scan has landed: {refused:?}\
         \n--- editor output ---\n{}",
        session.output()
    );
}

/// A script named where a scene belongs, which is what the everyday project defect looks like: a
/// main scene that was renamed, or a setting written with the file that was being edited.
const NOT_A_SCENE: &str = "extends Node\n\nfunc _ready() -> void:\n\tpass\n";

/// A project whose main scene is not a scene still reaches a ready session.
///
/// Readiness waits for the scene the editor opens for itself after its first import scan, because
/// that open replaces whatever is being edited. The wait asked `ResourceLoader.exists(main_scene)`
/// — and a `.gd` file exists. It is a Script, so the editor never opens it as a scene and the
/// startup open the addon was waiting for never comes: `session.get_state` answered `importing`
/// for as long as the editor lived, and every mutating command was refused `not_ready`. The whole
/// session is unusable on a project a person can open and work in perfectly well.
#[test]
fn a_project_whose_main_scene_is_not_a_scene_still_becomes_ready() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(worktree.join("scripts/not_a_scene.gd"), NOT_A_SCENE)
        .expect("write the script the project will name as its main scene");
    let project = worktree.join("project.godot");
    let configured = std::fs::read_to_string(&project)
        .expect("read the fixture project")
        .replace(
            "run/main_scene=\"res://main.tscn\"",
            "run/main_scene=\"res://scripts/not_a_scene.gd\"",
        );
    std::fs::write(&project, configured).expect("write the project");
    let ledger = directory.path().join("ledger.json");
    // Starting the session is the assertion: it polls `session.get_state` until the addon answers
    // ready, and gives up with the editor's output when it never does.
    let mut session = Session::start_on_worktree(worktree, ledger, Some(directory));

    let state = session.call("session.get_state", json!({}));
    assert_eq!(state["state"], "ready", "{state}");
    assert_eq!(
        state["scene"], "",
        "the editor opens no scene for a main scene it cannot open, so the session edits none: \
         {state}"
    );

    // Ready has to mean usable, not just labelled: a mutation is what `not_ready` was refusing.
    let scene = "res://authored.tscn";
    session.mutate("scene.create", json!({"path": scene, "rootType": "Node2D"}));
    session.mutate(
        "node.create",
        json!({"scene": scene, "parent": "/authored", "name": "Marker", "type": "Marker2D"}),
    );
    assert_eq!(
        child_names(&session.call("scene.get_tree", json!({}))),
        vec!["Marker".to_owned()],
        "a session on such a project must author scenes like any other"
    );
}

/// The scenes the editor is still holding, and writing them, both read out of the editor itself.
///
/// Gofer's `dirty` flag counts only the mutations Gofer made, so nothing anywhere knew about work a
/// person did in the editor — and a merge stops that editor with `get_tree().quit()`, which neither
/// asks nor saves. This is the answer that has to be true before a merge is allowed to be built on
/// it: an edited scene is named, a saved one is not, and saving is confirmed by asking again rather
/// than by `save_all_scenes` returning.
#[test]
fn the_editor_names_the_work_it_is_holding_and_writes_it_on_request() {
    let mut session = Session::start();
    let scene = "res://holding.tscn";

    session.mutate("scene.create", json!({"path": scene, "rootType": "Node2D"}));
    session.mutate("scene.save", json!({}));
    assert_eq!(
        unsaved_scenes(&mut session),
        Vec::<String>::new(),
        "a scene just written to disk is not work the editor is holding"
    );

    session.mutate(
        "node.create",
        json!({"scene": scene, "parent": "/holding", "name": "Marker", "type": "Marker2D"}),
    );
    assert_eq!(
        unsaved_scenes(&mut session),
        vec![scene.to_owned()],
        "an edit that has not reached disk must be named"
    );

    let written = session.call("session.save_all_scenes", json!({}));
    assert_eq!(
        written["saved"],
        json!([scene]),
        "saving must answer with what it wrote: {written}"
    );
    assert_eq!(
        unsaved_scenes(&mut session),
        Vec::<String>::new(),
        "and the editor must be holding nothing afterwards"
    );
    let on_disk = std::fs::read_to_string(session.worktree.join("holding.tscn"))
        .expect("the saved scene must exist on disk");
    assert!(
        on_disk.contains("Marker2D"),
        "the edit must be in the file, not just reported as saved: {on_disk}"
    );
}

/// The scenes the editor says it is holding changes to, sorted so the assertion reads the same way
/// twice.
fn unsaved_scenes(session: &mut Session) -> Vec<String> {
    let answer = session.call("session.get_unsaved_scenes", json!({}));
    let mut scenes: Vec<String> = answer["scenes"]
        .as_array()
        .expect("scenes array")
        .iter()
        .map(|scene| scene.as_str().expect("scene path").to_owned())
        .collect();
    scenes.sort();
    scenes
}

/// `dirty` is the editor's answer about the edited scene, not a count of what Gofer did to it.
///
/// The flag was set by Gofer's own mutations and cleared by Gofer's own saves, so anything the
/// editor did to the same scene went unseen. A scene switch is the reachable proof: switching away
/// and back rebaselines the session (`_track_edited_scene` zeroes the flag), while the editor is
/// still holding the change and still says so in `session.get_unsaved_scenes`. The same divergence
/// is what a person pressing Ctrl+S produces — the file lands on disk and the session goes on
/// reporting a dirty scene — and neither direction is something a caller can work around, because
/// `dirty` is the field every unsaved-work prompt is built on.
#[test]
fn the_dirty_flag_answers_for_the_editor_across_a_scene_switch() {
    let mut session = Session::start();
    let first = "res://dirty_first.tscn";
    let second = "res://dirty_second.tscn";
    session.mutate("scene.create", json!({"path": first, "rootType": "Node2D"}));
    session.mutate("scene.save", json!({}));
    session.mutate(
        "scene.create",
        json!({"path": second, "rootType": "Node2D"}),
    );
    session.mutate("scene.save", json!({}));

    session.open_scene(first);
    session.mutate(
        "node.create",
        json!({"parent": "/dirty_first", "name": "Marker", "type": "Marker2D"}),
    );
    assert_eq!(
        session.call("session.get_state", json!({}))["dirty"],
        true,
        "a mutated scene is dirty"
    );

    session.open_scene(second);
    session.open_scene(first);

    // The editor's own answer first: it is the fact the session's flag has to agree with.
    assert_eq!(
        unsaved_scenes(&mut session),
        vec![first.to_owned()],
        "the editor must still be holding the change the switch did not save"
    );
    let state = session.call("session.get_state", json!({}));
    assert_eq!(
        state["dirty"], true,
        "a scene the editor is still holding changes to must read as dirty: {state}"
    );

    // And the agreement has to hold the other way, or the flag is merely stuck on.
    session.mutate("scene.save", json!({}));
    assert_eq!(
        unsaved_scenes(&mut session),
        Vec::<String>::new(),
        "the save must reach disk"
    );
    assert_eq!(
        session.call("session.get_state", json!({}))["dirty"],
        false,
        "and a written scene must read as clean"
    );
}

/// Undo and redo answer for the editor's own history, not for a count of Gofer's mutations.
///
/// The depths were bumped by Gofer's mutations and zeroed on every scene switch, so they were a
/// record of this session's traffic rather than of the history the editor would actually step.
/// Switching away and back is the reachable proof: the scene keeps its history in the editor, the
/// counters do not, and `session.undo` then refuses an undo the Edit menu offers. The same gap runs
/// the other way for a person pressing Ctrl+Z — the counter stays high over a history that moved,
/// and the next `session.undo` steps one action further back than the caller asked for, into work
/// nobody told it about.
#[test]
fn undo_answers_for_the_editors_history_across_a_scene_switch() {
    let mut session = Session::start();
    let first = "res://history_first.tscn";
    let second = "res://history_second.tscn";
    session.mutate("scene.create", json!({"path": first, "rootType": "Node2D"}));
    session.mutate("scene.save", json!({}));
    session.mutate(
        "scene.create",
        json!({"path": second, "rootType": "Node2D"}),
    );
    session.mutate("scene.save", json!({}));

    session.open_scene(first);
    session.mutate(
        "node.create",
        json!({"parent": "/history_first", "name": "Marker", "type": "Marker2D"}),
    );
    assert_eq!(
        session.call("session.get_state", json!({}))["canUndo"],
        true,
        "the mutation is undoable while the session is still counting it"
    );

    session.open_scene(second);
    session.open_scene(first);

    let state = session.call("session.get_state", json!({}));
    assert_eq!(
        state["canUndo"], true,
        "the editor kept this scene's history across the switch, so the session must offer it: \
         {state}"
    );
    session.mutate("session.undo", json!({}));
    assert!(
        child_names(&session.call("scene.get_tree", json!({}))).is_empty(),
        "the undo must remove the node the editor's history is holding"
    );
    let after = session.call("session.get_state", json!({}));
    assert_eq!(
        after["canUndo"], false,
        "with the scene back at its saved state there is nothing left to undo: {after}"
    );
    assert_eq!(
        after["canRedo"], true,
        "and the undone action is offered back"
    );

    session.mutate("session.redo", json!({}));
    assert_eq!(
        child_names(&session.call("scene.get_tree", json!({}))),
        vec!["Marker".to_owned()],
        "redo must restore the node"
    );
}

/*
 * A size written under a Control's own floor says which floor, and how to move it.
 *
 * `Control.size` is clamped to `get_combined_minimum_size()`, and a `Label`'s minimum is the text
 * in it. Measured here and in three shapes beside it: a `Panel`, a `ColorRect` and a `Panel` inside
 * a `VBoxContainer` all take (64, 64) exactly. So this is not a property that cannot be written —
 * it is one with a floor, and only a write under the floor is refused.
 *
 * Two live turns met it, in two different runs: a `Label` asked for (0, 0) and answered (1, 23),
 * and a body asked for (64, 64) and answered (80, 80).
 */
#[test]
fn a_size_under_a_controls_floor_says_which_floor() {
    let mut session = Session::start();
    let scene = "res://sizes.tscn";
    session.mutate(
        "scene.create",
        json!({"path": scene, "rootType": "Control"}),
    );
    session.mutate(
        "node.create",
        json!({"scene": scene, "parent": "/sizes", "name": "Words", "type": "Label"}),
    );
    session.mutate(
        "node.create",
        json!({"scene": scene, "parent": "/sizes", "name": "Plain", "type": "Panel"}),
    );

    let refused = session.error(
        "node.set_property",
        json!({
            "scene": scene,
            "node": "/sizes/Words",
            "property": "size",
            "value": {"type": "vector2", "value": [0.0, 0.0]},
        }),
        Some(session.revision()),
    );
    assert!(refused.starts_with("readback_mismatch"), "{refused}");
    assert!(
        refused.contains("custom_minimum_size"),
        "the refusal must name the floor to move: {refused}"
    );

    // A size the node will take is not refused at all, which is most of them.
    let held = session.mutate(
        "node.set_property",
        json!({
            "scene": scene,
            "node": "/sizes/Plain",
            "property": "size",
            "value": {"type": "vector2", "value": [64.0, 64.0]},
        }),
    );
    assert_eq!(held["value"]["value"], json!([64.0, 64.0]));

    // And a property that is not a size keeps the refusal it had.
    let elsewhere = session.error(
        "node.set_property",
        json!({
            "scene": scene,
            "node": "/sizes/Plain",
            "property": "anchors_preset",
            "value": {"type": "int", "value": 15},
        }),
        Some(session.revision()),
    );
    assert!(!elsewhere.contains("custom_minimum_size"), "{elsewhere}");
}

/*
 * A full-screen panel: the refusal names the four properties that do the job.
 *
 * `anchors_preset` is the inspector's own control and no scene stores it. Measured here and in
 * three shapes beside it — a `Panel` under a `Control`, a `VBoxContainer`, a `Panel` inside one,
 * and a preset out of range — every write reads back 0, and the anchors under it do not move. It is
 * also the property every model reaches for, because a full-screen panel is the commonest thing
 * anyone asks a `Control` for: three live UI turns hit it.
 *
 * So the write stays refused, and the refusal carries the way onward. The second half of this test
 * is that way onward actually working.
 */
#[test]
fn the_preset_no_scene_holds_names_the_anchors_that_do() {
    let mut session = Session::start();
    let scene = "res://anchors.tscn";
    session.mutate(
        "scene.create",
        json!({"path": scene, "rootType": "Control"}),
    );
    session.mutate(
        "node.create",
        json!({"scene": scene, "parent": "/anchors", "name": "Target", "type": "Panel"}),
    );

    let refused = session.error(
        "node.set_property",
        json!({
            "scene": scene,
            "node": "/anchors/Target",
            "property": "anchors_preset",
            "value": {"type": "int", "value": 15},
        }),
        Some(session.revision()),
    );
    assert!(
        refused.starts_with("readback_mismatch"),
        "a write no scene can hold is still a failed write: {refused}"
    );
    for named in [
        "anchor_left",
        "anchor_top",
        "anchor_right",
        "anchor_bottom",
        "offset_right",
        "offset_bottom",
    ] {
        assert!(
            refused.contains(named),
            "the refusal must name {named}: {refused}"
        );
    }

    // And what it names works, which is the half that makes the sentence worth reading.
    let at = |name: &str, value: f64| {
        json!({
            "node": "/anchors/Target",
            "property": name,
            "value": {"type": "float", "value": value},
        })
    };
    session.mutate(
        "node.set_properties",
        json!({
            "scene": scene,
            "properties": [
                at("anchor_left", 0.0),
                at("anchor_top", 0.0),
                at("anchor_right", 1.0),
                at("anchor_bottom", 1.0),
                at("offset_right", 0.0),
                at("offset_bottom", 0.0),
            ],
        }),
    );
    let held = session.call(
        "node.inspect",
        json!({"scene": scene, "node": "/anchors/Target"}),
    );
    let properties = held["properties"].as_array().expect("properties");
    let value_of = |want: &str| {
        properties
            .iter()
            .find(|one| one["name"] == want)
            .map(|one| one["value"]["value"].clone())
            .unwrap_or(Value::Null)
    };
    assert_eq!(value_of("anchor_right"), json!(1.0));
    assert_eq!(value_of("anchor_bottom"), json!(1.0));

    // An ordinary refusal is unchanged: only the property that cannot be written gains a sentence.
    let ordinary = session.error(
        "node.set_property",
        json!({
            "scene": scene,
            "node": "/anchors/Target",
            "property": "nothing_of_the_sort",
            "value": {"type": "int", "value": 1},
        }),
        Some(session.revision()),
    );
    assert!(!ordinary.contains("anchor_left"), "{ordinary}");
}
