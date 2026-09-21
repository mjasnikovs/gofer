//! Which parameters of a tool call name a file, and what the router does about each one.
//!
//! Three questions with one answer between them: is this string a path, does it carry Godot's
//! scheme, and does it climb out of the task worktree. The catalogue answers the first — a
//! parameter declared [`tool_params::Kind::Path`] — and the rest is what the router does once it
//! has that.
//!
//! Two conventions meet in the catalogue and neither is wrong: the editor names a file the way
//! Godot does, `res://scripts/mario.gd`, and everything that reaches the filesystem names it the
//! way the worktree does. The model has no way to know which domain wants which, so the mapping is
//! done here rather than explained to it.

use crate::ai_tools::ToolFailure;
use crate::tool_params::{self, Operation};
use serde_json::Value;
use tauri::{AppHandle, Runtime};

/// A directory named the way the project names it, whichever way it was written.
///
/// `res://` and stray slashes are taken off, because a model that has been reading scene paths all
/// turn writes `res://assets` as readily as `assets`, and both mean the same folder. The scheme is
/// off before this sees it now — `under` is a path the operation declares, so the router normalises
/// it with every other one — and the trim stays as the backstop it always was.
///
/// The root is no directory at all, and that is what `None` says. `res://`, `/` and `.` all come
/// out of the trimming with nothing left, and nothing was matched as a prefix against every
/// worktree-relative path — so `godot_resource list` and `godot_script list` answered
/// `{"files": []}` about a worktree full of files. `res://` is the spelling a model reaching for
/// the whole project writes, precisely because this helper accepts it everywhere else.
pub(crate) fn named_directory(named: &str) -> Option<String> {
    let trimmed = named
        .trim()
        .trim_start_matches("res://")
        .trim_matches('/')
        .trim();
    (!trimmed.is_empty() && trimmed != ".").then(|| trimmed.to_owned())
}

/// Whether a path is Gofer's own staged addon rather than anything in the project.
///
/// `addons/gofer` is not the user's code and Gofer says so itself: it stages the directory into the
/// worktree on session start and writes `addons/gofer/` into the checkout's Git exclude file, under
/// the marker "the managed Godot addon is never part of the project". Listing it contradicts that,
/// and it is the *first* thing most turns read — ten of the sixteen entries in a bare fixture's
/// listing are it.
///
/// The cost is not the bytes. A live turn stuck on a runtime call that would not answer stopped
/// working on the game and spent four subagent calls reading `addons/gofer/runtime.gd` to work out
/// why — debugging Gofer instead of the thing it was asked to build, down a road it only knew about
/// because the listing named it. A file nobody may usefully change does not belong in the answer to
/// "what is in this project".
pub(crate) fn is_goferns_own(path: &str) -> bool {
    path == crate::addon::ADDON_DIRECTORY
        || path.starts_with(&format!("{}/", crate::addon::ADDON_DIRECTORY))
}

/// Whether one worktree-relative path sits inside that directory. No directory means every path.
pub(crate) fn is_under(path: &str, under: Option<&str>) -> bool {
    under.is_none_or(|under| {
        path.strip_prefix(under)
            .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// Resolves every path a gated call names before the user is asked about it. Outside-worktree
/// files are refused outright — "outside the worktree" is not a decision to put in front of the
/// user one file at a time — and the resolution is the workspace's own, so this check cannot drift
/// from the one the operation itself will run.
pub(crate) fn reject_outside_paths<R: Runtime>(
    app: &AppHandle<R>,
    operation: &Operation,
    params: &Value,
) -> Result<(), ToolFailure> {
    let named = paths_named(operation, params);
    if named.is_empty() {
        return Ok(());
    }
    let workspace = crate::active_workspace(app)?;
    for path in &named {
        workspace.resolve(path)?;
    }
    Ok(())
}

/// Rewrites `res://…` into the worktree-relative path the file tools take, once, for every
/// operation the desktop answers itself.
///
/// Two conventions meet in this catalog and neither is wrong: the editor names a file the way Godot
/// does, `res://scripts/mario.gd`, and everything that reaches the filesystem names it the way the
/// worktree does, `scripts/mario.gd`. A model has no way to know which domain wants which, and it
/// reaches for `res://` because that is what it just used to build the scene — then `godot_script
/// open` answers that the file does not exist, about a file it wrote a moment ago. The mapping is
/// exact, so it is done here rather than explained. Confinement is untouched: what is left after
/// the prefix is still a relative path, so `res://../secrets` is refused exactly as `../secrets` is.
///
/// It runs in `dispatch_under`, before anything is held to the parameters, because an arm that has
/// to remember to call it is an arm that can forget to.
/// `script_domain` and `debug_domain` called it; `resource_domain` never did, and nothing failed —
/// `files::validate_relative` strips the scheme too, so an unnormalised `delete` reached the right
/// file while [`crate::read_ledger`], which keys on the string the caller wrote, missed every
/// record for it. The delete then ran with no hash to be held to at all.
///
/// Which parameters are paths is the operation's own row rather than a list kept here: a name the
/// table declares as a path is rewritten wherever it sits, including inside the `entry` shape a
/// list of files declares, so a new operation inherits this by declaring its parameters.
///
/// Only the operations [`tool_params::Answers::Rust`] answers. Everything routed to the addon is
/// forwarded verbatim and the addon names files the way Godot does — `_as_resource_path` puts the
/// scheme back on a worktree-relative path, and `project.set_autoload` refuses a path that does not
/// carry it, because that string is written into `project.godot` for the engine to load.
pub(crate) fn as_the_worktree_names_them(operation: &Operation, params: &mut Value) {
    if operation.route() != tool_params::Answers::Rust {
        return;
    }
    let Some(object) = params.as_object_mut() else {
        return;
    };
    for param in operation.params {
        if let Some(value) = object.get_mut(param.name) {
            worktree_relative(param, value);
        }
    }
}

/// One declared parameter, and everything the table says lives inside it.
fn worktree_relative(param: &tool_params::Param, value: &mut Value) {
    if declares_a_path(param) {
        match value.as_array_mut() {
            Some(entries) => entries.iter_mut().for_each(strip_the_scheme),
            None => strip_the_scheme(value),
        }
    }
    match param.entry {
        [_, ..] => {
            for entry in entries_of(value) {
                let Some(fields) = entry.as_object_mut() else {
                    continue;
                };
                for inner in param.entry {
                    if let Some(held) = fields.get_mut(inner.name) {
                        worktree_relative(inner, held);
                    }
                }
            }
        }
        [] if value.is_array() || value.is_object() => wherever_a_key_names_a_path(value),
        [] => (),
    }
}

/// The entries of a list parameter, or the single object one that is not a list.
fn entries_of(value: &mut Value) -> &mut [Value] {
    match value {
        Value::Array(entries) => entries.as_mut_slice(),
        other => std::slice::from_mut(other),
    }
}

fn strip_the_scheme(value: &mut Value) {
    if let Some(path) = value.as_str().and_then(|path| path.strip_prefix("res://")) {
        *value = Value::String(path.to_owned());
    }
}

/// The same rewrite through a shape the table does not describe, keyed on the names it does.
fn wherever_a_key_names_a_path(value: &mut Value) {
    match value {
        Value::Array(entries) => entries.iter_mut().for_each(wherever_a_key_names_a_path),
        Value::Object(fields) => {
            for (key, held) in fields.iter_mut() {
                if key == A_NESTED_KEY_THAT_NAMES_A_FILE {
                    strip_the_scheme(held);
                }
                wherever_a_key_names_a_path(held);
            }
        }
        _ => (),
    }
}

/// The worktree-relative paths one call names, read off the operation's own row.
///
/// Only the parameters that carry a path as a string: a list of files and a nested `path` are the
/// answer to a different question, and the two callers here — the outside-worktree rejection and
/// the vanished-record drop — each act on one file at a time.
pub(crate) fn paths_named(operation: &Operation, params: &Value) -> Vec<String> {
    let Some(object) = params.as_object() else {
        return Vec::new();
    };
    operation
        .params
        .iter()
        .filter(|param| declares_a_path(param))
        .filter_map(|param| object.get(param.name).and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

/// Refuses a call carrying a path that climbs out of the project, before it reaches the addon.
///
/// The editor names files `res://…`, and `res://../` is a real path: Godot resolves it out of the
/// project and follows it. Measured against the pinned 4.7.2 editor — `Image.save_png` wrote
/// `res://../escaped.png` and `ResourceSaver.save` wrote `res://../escaped.tres`, both one
/// directory above the project, both answering OK.
///
/// The file and script tools have their own confinement and this is not it. Everything routed by
/// [`crate::tool_params::Answers::Addon`] is forwarded to the addon verbatim, so the writers that
/// live there — `resource.create_texture`, `create_shape`, `create_tileset` — had no gate on the
/// way at all, under a catalogue that describes their domain as one where "nothing outside the
/// task worktree can be named at all".
///
/// A `..` inside a *path* is what is refused, not a `..` inside a value: a Label's `text` may say
/// anything, and a `godot_runtime` node path is `/root/Main/..` on purpose. So a string counts as
/// a path only when it carries the scheme, or when the operation declared the parameter holding it
/// as one.
pub(crate) fn a_path_that_climbs_out(
    operation: &Operation,
    params: &Value,
) -> Result<(), ToolFailure> {
    fn climbing(named: bool, value: &Value) -> Option<&str> {
        match value {
            Value::String(text) => climbs(named, text).then_some(text.as_str()),
            Value::Array(items) => items.iter().find_map(|item| climbing(named, item)),
            Value::Object(fields) => fields
                .iter()
                .find_map(|(key, held)| climbing(key == A_NESTED_KEY_THAT_NAMES_A_FILE, held)),
            _ => None,
        }
    }
    let declared = |key: &str| {
        operation
            .params
            .iter()
            .any(|param| param.name == key && declares_a_path(param))
    };
    let found = match params.as_object() {
        Some(fields) => fields
            .iter()
            .find_map(|(key, held)| climbing(declared(key), held)),
        None => climbing(false, params),
    };
    match found {
        None => Ok(()),
        Some(text) => Err(ToolFailure::new(
            "outside_workspace",
            format!(
                "{text} climbs out of the project. Every path here names a file inside the task \
                 worktree, spelled the way the project spells it — assets/tiles.png, or \
                 res://assets/tiles.png — and a `..` segment is refused wherever it appears."
            ),
        )),
    }
}

/// Whether a declared parameter carries a file the worktree holds, or a directory inside it.
///
/// The operation's own row says so, through [`tool_params::Kind::Path`]. It was nine parameter
/// names listed here, and a name decided three things it could not know: an operation whose path
/// parameter was called anything else went through the confinement gate unexamined, and
/// `godot_runtime`'s `path` — a node in the running game, where `..` is the parent node — was
/// refused for climbing out of a project it never named.
pub(crate) fn declares_a_path(param: &tool_params::Param) -> bool {
    match param.kind {
        tool_params::Kind::Path => true,
        tool_params::Kind::ListOf(inner) => *inner == tool_params::Kind::Path,
        _ => false,
    }
}

/// The one key that names a file inside a shape the catalogue does not describe.
///
/// A tagged `Resource` arrives as `{"type": "Resource", "value": {"path": "res://…"}}`, and what a
/// tagged value carries is the protocol's rather than a row of `params.json`. Everything else that
/// holds a path is a declared parameter, and a string carrying the scheme is a path wherever it
/// sits without any key saying so.
const A_NESTED_KEY_THAT_NAMES_A_FILE: &str = "path";

/// Whether a string is a path, and climbs. `named` is what the position it sits in already said.
fn climbs(named: bool, text: &str) -> bool {
    let (path, schemed) = match text
        .strip_prefix("res://")
        .or_else(|| text.strip_prefix("user://"))
    {
        Some(rest) => (rest, true),
        None => (text, false),
    };
    if !schemed && !named {
        return false;
    }
    path.split('/').any(|segment| segment == "..") || (!schemed && path == "..")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_tools::CATALOG;
    use serde_json::json;

    /// Every operation that names a path takes it either way, and takes it at the router.
    ///
    /// The catalog mixes two path conventions because Godot does: a scene is `res://main.tscn` and
    /// a script is `scripts/main.gd`. A model reaches for the one it just used, so `godot_script
    /// open` was told a file it had written a moment earlier did not exist.
    ///
    /// A table test over the whole catalogue, because the failure it replaces was never a path that
    /// came out wrong. The rewrite worked; it was three arms that called it and a fourth that did
    /// not, and the test that stood here called the rewrite as a pure function and asserted nothing
    /// about which arms applied it. `resource_domain` was the arm that did not, and nothing failed:
    /// `files::validate_relative` strips the scheme too, so the delete reached the right file and
    /// only the read ledger — keyed on the string the caller wrote — could tell. So the assertion
    /// is the table: every operation that declares a path, whichever domain adds it next.
    #[test]
    fn every_operation_that_names_a_path_takes_it_either_way() {
        /// The parameter as the router hands it to the arm, resolved off the catalogue's own row.
        fn normalised(tool: &str, op: &str, params: Value) -> Value {
            let operation = crate::tool_params::operation_of(tool, op)
                .unwrap_or_else(|| panic!("{tool}.{op} is a catalogue operation"));
            let mut params = params;
            as_the_worktree_names_them(operation, &mut params);
            params
        }

        let mut checked = 0;
        for domain in CATALOG {
            for operation in domain.operations {
                let worktree = operation.route() == crate::tool_params::Answers::Rust;
                let expected = |named: &str| {
                    if worktree {
                        format!("levels/{named}")
                    } else {
                        format!("res://levels/{named}")
                    }
                };
                for param in operation.params {
                    if matches!(param.kind, crate::tool_params::Kind::ListOf(inner)
                        if *inner == crate::tool_params::Kind::Path)
                    {
                        let answered = normalised(
                            domain.name,
                            operation.op,
                            json!({param.name: ["res://levels/level.tscn"]}),
                        );
                        assert_eq!(
                            answered[param.name][0],
                            json!(expected("level.tscn")),
                            "{} {} `{}[]`",
                            domain.name,
                            operation.op,
                            param.name
                        );
                        checked += 1;
                    }
                    if matches!(param.kind, crate::tool_params::Kind::Path) {
                        let answered = normalised(
                            domain.name,
                            operation.op,
                            json!({param.name: "res://levels/level.tscn"}),
                        );
                        assert_eq!(
                            answered[param.name],
                            json!(expected("level.tscn")),
                            "{} {} `{}`",
                            domain.name,
                            operation.op,
                            param.name
                        );
                        let untouched = normalised(
                            domain.name,
                            operation.op,
                            json!({param.name: "levels/level.tscn"}),
                        );
                        assert_eq!(
                            untouched[param.name], "levels/level.tscn",
                            "{} {} `{}`",
                            domain.name, operation.op, param.name
                        );
                        checked += 1;
                    }
                    for inner in param.entry {
                        if !declares_a_path(inner) {
                            continue;
                        }
                        let answered = normalised(
                            domain.name,
                            operation.op,
                            json!({param.name: [{inner.name: "res://levels/level.tscn"}]}),
                        );
                        assert_eq!(
                            answered[param.name][0][inner.name],
                            json!(expected("level.tscn")),
                            "{} {} `{}[].{}`",
                            domain.name,
                            operation.op,
                            param.name,
                            inner.name
                        );
                        checked += 1;
                    }
                }
            }
        }
        assert!(
            checked > 30,
            "the catalogue declares more paths than this walked: {checked}"
        );

        let batched = normalised(
            "godot_script",
            "open",
            json!({"paths": ["res://scripts/a.gd", "scripts/b.gd"]}),
        );
        assert_eq!(batched["paths"][0], "scripts/a.gd");
        assert_eq!(batched["paths"][1], "scripts/b.gd");

        let renamed = normalised(
            "godot_script",
            "apply_rename",
            json!({"files": [{"path": "res://scripts/a.gd", "updatedText": "extends Node\n"}]}),
        );
        assert_eq!(renamed["files"][0]["path"], "scripts/a.gd");
        assert_eq!(renamed["files"][0]["updatedText"], "extends Node\n");

        assert_eq!(
            normalised("godot_resource", "list", json!({"under": "res://assets"}))["under"],
            "assets"
        );

        assert_eq!(
            normalised(
                "godot_script",
                "open",
                json!({"paths": ["res://../secrets.gd"]})
            )["paths"][0],
            "../secrets.gd"
        );
        // Each case names the operation it is written against, because the row is what decides:
        // the same `path` is a file under `godot_resource` and a node under `godot_runtime`.
        let row = |tool: &str, op: &str| {
            crate::tool_params::operation_of(tool, op)
                .unwrap_or_else(|| panic!("{tool}.{op} is a catalogue operation"))
        };
        for (tool, op, climbing) in [
            (
                "godot_resource",
                "create_texture",
                json!({"path": "res://../escaped.png"}),
            ),
            (
                "godot_resource",
                "create_texture",
                json!({"path": "../escaped.png"}),
            ),
            (
                "godot_resource",
                "create_texture",
                json!({"path": "assets/../../escaped.png"}),
            ),
            (
                "godot_resource",
                "create_texture",
                json!({"path": "user://../escaped.png"}),
            ),
            (
                "godot_resource",
                "create_tileset",
                json!({"texture": "res://a.png", "tiles": ["res://../x.png"]}),
            ),
            (
                "godot_node",
                "set_properties",
                json!({"properties": [{"value": {"type": "Resource", "value": {"path": "res://../x.tres"}}}]}),
            ),
            (
                "godot_node",
                "set_properties",
                json!({"properties": [{"value": {"type": "String", "value": "res://../secrets"}}]}),
            ),
        ] {
            let refused =
                a_path_that_climbs_out(row(tool, op), &climbing).expect_err("a climbing path");
            assert_eq!(refused.code, "outside_workspace", "{tool} {op} {climbing}");
        }
        for (tool, op, ordinary) in [
            (
                "godot_resource",
                "create_texture",
                json!({"path": "res://assets/tiles.png"}),
            ),
            (
                "godot_project",
                "set_setting",
                json!({"value": {"type": "String", "value": "Loading.."}}),
            ),
            (
                "godot_node",
                "set_properties",
                json!({"properties": [{"property": "text", "value": {"type": "String", "value": "see ../docs/readme"}}]}),
            ),
            ("godot_node", "rename", json!({"name": "a..b"})),
            (
                "godot_project",
                "search_settings",
                json!({"query": "physics/2d/default_gravity"}),
            ),
            // A node path is not a file path, and `..` is how it names a parent node. The nine
            // key names this gate used to read refused every one of these.
            (
                "godot_runtime",
                "set_property",
                json!({"path": "/root/Main/../Other", "property": "text", "value": {"type": "String", "value": "hi"}}),
            ),
            (
                "godot_runtime",
                "inspect_node",
                json!({"path": "/root/Main/../Other"}),
            ),
        ] {
            assert!(
                a_path_that_climbs_out(row(tool, op), &ordinary).is_ok(),
                "{tool} {op} {ordinary}"
            );
        }

        let directory = tempfile::TempDir::new().expect("temporary directory");
        let workspace = crate::files::Workspace::open(directory.path()).expect("open workspace");
        assert!(
            workspace.resolve("../secrets.gd").is_err(),
            "a path that climbs out of the worktree must still be refused"
        );
    }

    /// One directory, however it is spelled, and no directory means the whole worktree.
    ///
    /// The rule both `list` operations narrow by. A live turn asked `godot_resource list` for one
    /// folder with the only key it could think of — `{"op": "list", "path": "assets"}` — was
    /// refused because there was no such parameter, and fell back to `bash find`.
    #[test]
    fn a_listing_narrowed_to_a_directory_holds_only_what_is_under_it() {
        for spelling in ["assets", "res://assets", "/assets/", "res://assets/"] {
            let under = super::named_directory(spelling);
            assert!(
                super::is_under("assets/tiles.png", under.as_deref()),
                "{spelling}"
            );
            assert!(
                super::is_under("assets/Effects/hit.png", under.as_deref()),
                "a directory holds what is under it, at any depth: {spelling}"
            );
            assert!(
                !super::is_under("scripts/main.gd", under.as_deref()),
                "{spelling}"
            );
            assert!(
                !super::is_under("assetsold/tiles.png", under.as_deref()),
                "{spelling}"
            );
            assert!(!super::is_under("assets", under.as_deref()), "{spelling}");
        }
        assert!(
            super::is_under("anything/at/all.png", None),
            "no directory named is every file"
        );
    }

    /// The project root, however it is spelled, narrows nothing.
    ///
    /// `res://` is the spelling a model reaching for "the whole project" writes, and it is one
    /// `named_directory` deliberately accepts — it took the scheme off and was left with nothing,
    /// and nothing matched nothing. `godot_resource list` and `godot_script list` both answered
    /// `{"files": []}` about a worktree full of files, which reads as an empty project rather than
    /// as a listing that narrowed itself away.
    #[test]
    fn the_project_root_is_not_a_directory_to_narrow_by() {
        for spelling in ["res://", "/", "//", ".", "res:///", "  "] {
            assert_eq!(super::named_directory(spelling), None, "{spelling}");
        }
        for spelling in ["assets", "res://assets"] {
            assert_eq!(
                super::named_directory(spelling),
                Some("assets".to_owned()),
                "{spelling}"
            );
        }
        let root = super::named_directory("res://");
        assert!(
            super::is_under("scripts/main.gd", root.as_deref()),
            "the root holds every file the worktree holds"
        );
    }
}
