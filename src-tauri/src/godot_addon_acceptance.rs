//! Acceptance coverage for the editor boundary: the real addon, inside a real Godot editor,
//! answering the real [`RpcSession`].
//!
//! Every other test in this suite stands in for one side of that boundary — a fake spawner, a fake
//! addon that answers only what the test writes, JSON fixtures that describe envelopes nobody
//! sends. Those agree with the code because the same author wrote both, which is exactly how a
//! green suite once shipped an addon whose undo called a method Godot does not expose to scripting
//! and a supervisor that closed the connection on its own heartbeat. This module removes the
//! stand-ins: it stages the addon with [`AddonStager`], launches the pinned editor, and drives
//! authoring commands over the wire the desktop app uses.
//!
//! The test is gated behind the `godot-acceptance` feature so the fast `cargo test` gate stays
//! process-free; `npm run test:godot` enables it after the Node journeys have proven the binary.

use crate::addon::AddonStager;
use crate::files::Workspace;
use crate::godot_rpc::{CallRequest, HEARTBEAT_INTERVAL_MS, RpcSession};
use crate::process::{ChildProcess, ProcessSpawner, SystemProcessSpawner};
use serde_json::{Value, json};
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

/// The engine the repository pins. Kept in step with `scripts/godot-binary.mjs`, which reads the
/// same manifest and reports the version with dots where the release tag has a dash.
const ARTIFACTS: &str = include_str!("../../protocol/godot-artifacts.json");
const READY_TIMEOUT: Duration = Duration::from_secs(90);
const CALL_TIMEOUT_MS: u64 = 30_000;
const PROBE_TIMEOUT_MS: u64 = 2_000;

struct Editor {
    child: Box<dyn ChildProcess>,
    output: Arc<Mutex<String>>,
}

impl Editor {
    fn output(&self) -> String {
        self.output
            .lock()
            .map(|output| output.clone())
            .unwrap_or_default()
    }
}

impl Drop for Editor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn pinned_version_prefix() -> String {
    let manifest: Value = serde_json::from_str(ARTIFACTS).expect("parse Godot artifact manifest");
    manifest["version"]
        .as_str()
        .expect("manifest version")
        .replace('-', ".")
}

/// Resolves the pinned editor the same way the Node gate does: an absolute `GOFER_GODOT_BINARY`
/// wins, otherwise the pinned version is accepted from `PATH`. The version is always verified, so
/// neither route can silently accept a different engine.
fn pinned_editor(spawner: &impl ProcessSpawner) -> String {
    let expected = pinned_version_prefix();
    let reported = |binary: &str| {
        let arguments = [OsString::from("--version")];
        let output = spawner.output(OsStr::new(binary), &arguments).ok()?;
        output
            .status
            .success
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };

    if let Ok(configured) = std::env::var("GOFER_GODOT_BINARY") {
        assert!(
            Path::new(&configured).is_absolute(),
            "GOFER_GODOT_BINARY must be an absolute path"
        );
        let version = reported(&configured)
            .unwrap_or_else(|| panic!("Could not execute GOFER_GODOT_BINARY at {configured}"));
        assert!(
            version.starts_with(&expected),
            "Expected Godot {expected}, received {version}"
        );
        return configured;
    }
    for candidate in ["godot4", "godot"] {
        if reported(candidate).is_some_and(|version| version.starts_with(&expected)) {
            return candidate.to_owned();
        }
    }
    panic!(
        "Godot {expected} is required. Install it on PATH, or set GOFER_GODOT_BINARY to the \
         absolute path of the pinned binary."
    );
}

fn copy_tree(source: &Path, target: &Path) {
    std::fs::create_dir_all(target).expect("create target directory");
    for entry in std::fs::read_dir(source).expect("read fixture directory") {
        let entry = entry.expect("fixture entry");
        let destination = target.join(entry.file_name());
        if entry.file_type().expect("entry type").is_dir() {
            copy_tree(&entry.path(), &destination);
        } else {
            std::fs::copy(entry.path(), &destination).expect("copy fixture file");
        }
    }
}

fn fixture_worktree(directory: &TempDir) -> PathBuf {
    let worktree = directory.path().join("worktree");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("godot-project");
    copy_tree(&fixture, &worktree);
    worktree.canonicalize().expect("canonical worktree")
}

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

fn launch(worktree: &Path, port: u16, token: &str) -> Editor {
    let arguments = [
        OsString::from("--editor"),
        OsString::from("--headless"),
        OsString::from("--path"),
        worktree.as_os_str().to_owned(),
    ];
    let environment = [
        (
            OsString::from("GOFER_RPC_PORT"),
            OsString::from(port.to_string()),
        ),
        (OsString::from("GOFER_RPC_TOKEN"), OsString::from(token)),
    ];
    let binary = pinned_editor(&SystemProcessSpawner);
    let mut child = SystemProcessSpawner
        .spawn_with_env(OsStr::new(&binary), &arguments, false, &environment)
        .expect("launch the pinned Godot editor");

    // Both of the editor's streams are pipes. An unread pipe fills and stalls the editor long
    // before the addon loads, so they are drained into one buffer that a failure can quote.
    let output = Arc::new(Mutex::new(String::new()));
    for stream in [child.take_stdout(), child.take_stderr()] {
        let Some(stream) = stream else { continue };
        let sink = Arc::clone(&output);
        thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap_or(0) > 0 {
                if let Ok(mut sink) = sink.lock() {
                    sink.push_str(&line);
                }
                line.clear();
            }
        });
    }
    Editor { child, output }
}

struct Session {
    rpc: RpcSession,
    editor: Editor,
    _directory: Option<TempDir>,
    stager: AddonStager,
    worktree: PathBuf,
    revision: u64,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.rpc.stop();
        let _ = self.stager.unstage(&self.worktree);
    }
}

impl Session {
    /// Stages the addon into a fresh worktree, launches the editor, and waits for the addon to
    /// report that it is ready.
    fn start() -> Self {
        let directory = TempDir::new().expect("temporary directory");
        let worktree = fixture_worktree(&directory);
        let ledger = directory.path().join("ledger.json");
        Self::start_on_worktree(worktree, ledger, Some(directory))
    }

    /// Launches a session against a worktree the caller prepared and keeps alive, so a test can
    /// stop one session and start another against the same files to prove persistence.
    fn start_on_worktree(worktree: PathBuf, ledger: PathBuf, directory: Option<TempDir>) -> Self {
        let stager = AddonStager::new(ledger);
        let workspace = Workspace::open(&worktree).expect("open worktree");
        stager.stage(&workspace).expect("stage the Gofer addon");
        assert!(
            stager.staged(&worktree).expect("ledger readable"),
            "staging must record the worktree so stopping can revert it"
        );

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind RPC listener");
        let port = listener.local_addr().expect("listener address").port();
        let token = "a1".repeat(32);
        let rpc = RpcSession::start(listener, token.clone(), worktree.display().to_string());
        let editor = launch(&worktree, port, &token);

        let session = Self {
            rpc,
            editor,
            _directory: directory,
            stager,
            worktree,
            revision: 0,
        };
        session.await_ready();
        session
    }

    /// Polls until the addon answers as ready. The editor imports the project and enables plugins
    /// before the addon connects, so early probes are expected to fail and use a short timeout.
    fn await_ready(&self) {
        let deadline = Instant::now() + READY_TIMEOUT;
        let mut last = "no reply".to_owned();
        while Instant::now() < deadline {
            match self.request("session.get_state", json!({}), None, PROBE_TIMEOUT_MS) {
                Ok(result) if result["state"] == "ready" => return,
                Ok(result) => last = result.to_string(),
                Err(error) => last = error,
            }
            thread::sleep(Duration::from_millis(250));
        }
        panic!(
            "the addon never reported a ready session: {last}\n--- editor output ---\n{}",
            self.editor.output()
        );
    }

    fn request(
        &self,
        command: &str,
        params: Value,
        expected_revision: Option<u64>,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        self.rpc
            .call(CallRequest {
                id: format!("acceptance-{id}"),
                command: command.to_owned(),
                params,
                expected_revision,
                timeout_ms: Some(timeout_ms),
            })
            .map(|response| response.result)
            .map_err(|error| format!("{}: {}", error.code, error.message))
    }

    fn try_call(
        &self,
        command: &str,
        params: Value,
        expected_revision: Option<u64>,
    ) -> Result<Value, String> {
        self.request(command, params, expected_revision, CALL_TIMEOUT_MS)
    }

    fn call(&self, command: &str, params: Value) -> Value {
        self.try_call(command, params, None)
            .unwrap_or_else(|error| panic!("{command} failed: {error}"))
    }

    /// Sends a mutating command carrying the revision the session last observed, and adopts the
    /// revision the addon reports back.
    fn mutate(&mut self, command: &str, params: Value) -> Value {
        let expected = self.revision;
        let response = self
            .rpc
            .call(CallRequest {
                id: format!("acceptance-mutate-{expected}-{command}"),
                command: command.to_owned(),
                params,
                expected_revision: Some(expected),
                timeout_ms: Some(CALL_TIMEOUT_MS),
            })
            .unwrap_or_else(|error| {
                panic!("{command} failed at revision {expected}: {}", error.message)
            });
        let revision = response
            .revision
            .unwrap_or_else(|| panic!("{command} answered without a revision"));
        assert!(
            revision >= expected,
            "{command} moved the revision backwards: {expected} -> {revision}"
        );
        self.revision = revision;
        response.result
    }

    fn error(&self, command: &str, params: Value, expected_revision: Option<u64>) -> String {
        self.try_call(command, params, expected_revision)
            .err()
            .unwrap_or_else(|| panic!("{command} was expected to fail"))
    }
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
    assert_eq!(
        child_names(&session.call("scene.get_tree", json!({}))),
        vec!["Marker".to_owned()],
        "the created node must appear in the scene the session opened"
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

    session.mutate(
        "node.create",
        json!({"scene": scene, "parent": "/acceptance", "name": "Sprite", "type": "Sprite2D"}),
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
                session.editor.output()
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
    let current = session.revision;

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

    // Nothing above may have changed the scene.
    assert_eq!(
        session.revision, current,
        "a refused command must not bump the revision"
    );
    assert_eq!(
        child_names(&session.call("scene.get_tree", json!({}))),
        vec!["Sprite".to_owned()],
        "a refused command must leave the scene alone"
    );
}

/// Finds the one entry in a `{"settings": [...]}`-style result array whose `name` matches.
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
        assert_eq!(
            find_named(&actions, "actions", "ui_accept")["builtIn"],
            true
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
