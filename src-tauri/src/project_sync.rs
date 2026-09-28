//! Tells the editor and the language server what changed on disk.
//!
//! Both hold a view of the project that a write outside them leaves stale. The editor's filesystem
//! registers a `class_name` only when a rescan names its file: measured on the pinned 4.7.2,
//! neither `didSave`, reopening the script that uses it, nor a whole-project rescan does. It
//! imports nothing it was not told about. The language server keeps every open script's
//! diagnostics until it parses it again. The script editor, the agent's writes and a
//! move or a delete all say what happened here, and this decides what each of the two is told.

use crate::godot_rpc::CallRequest;
use serde_json::json;

/// What happened on disk.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Change<'a> {
    /// These files were written.
    Written(&'a [String]),
    /// A file moved or went. Either end can be a directory, so the whole project is walked.
    Moved,
    /// An addon command answered, and it may have written something a script can name.
    Answered(&'a str),
}

/// The two views the disk is told about.
pub(crate) trait Ports {
    /// `resource.rescan` of these files, or of the whole project when none are named.
    fn rescan(&self, paths: &[String]);
    fn reparse_open_scripts(&self);
}

/// Best effort: the write has already happened, and a caller told it failed would write again.
pub(crate) fn changed(change: Change) {
    tell(&Live, change);
}

/// [`changed`] for writes nobody waits on: the addon holds a rescan until a running import scan
/// settles, and a save from the script editor must not hold the user's Ctrl+S that long.
pub(crate) fn written_without_waiting(paths: Vec<String>) {
    std::thread::spawn(move || tell(&Live, Change::Written(&paths)));
}

fn tell(ports: &impl Ports, change: Change) {
    match change {
        Change::Written([]) => {}
        Change::Written(paths) => {
            ports.rescan(paths);
            // A script parsed before the rescan registered this one's `class_name` is still told
            // the type does not exist.
            if paths.iter().any(|path| path.ends_with(".gd")) {
                ports.reparse_open_scripts();
            }
        }
        Change::Moved => {
            ports.rescan(&[]);
            ports.reparse_open_scripts();
        }
        Change::Answered(command) if REPARSING_COMMANDS.contains(&command) => {
            ports.reparse_open_scripts();
        }
        Change::Answered(_) => {}
    }
}

/// The bound editor's addon and the language-server connection already open for it.
struct Live;

impl Ports for Live {
    fn rescan(&self, paths: &[String]) {
        if crate::godot_session_api::require_session_task_here().is_err() {
            return;
        }
        let Some(rpc) = crate::godot_session::rpc_session() else {
            return;
        };
        let params = if paths.is_empty() {
            json!({})
        } else {
            json!({"paths": paths})
        };
        let _ = rpc.call(CallRequest::new("resource.rescan", params));
    }

    fn reparse_open_scripts(&self) {
        crate::script::reparse_open_documents();
    }
}

// GENERATED-BEGIN reparsing-commands sha256:b2cf12713c471c1a
pub(crate) const REPARSING_COMMANDS: [&str; 9] = [
    "project.set_autoload",
    "project.remove_autoload",
    "scene.create",
    "scene.save",
    "scene.save_as",
    "resource.rescan",
    "resource.create_tileset",
    "resource.create_texture",
    "resource.create_shape",
];
// GENERATED-END reparsing-commands

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// What each view was told, in order.
    #[derive(Default)]
    struct Told(RefCell<Vec<String>>);

    impl Ports for Told {
        fn rescan(&self, paths: &[String]) {
            self.0.borrow_mut().push(format!("rescan {paths:?}"));
        }

        fn reparse_open_scripts(&self) {
            self.0.borrow_mut().push("reparse".to_owned());
        }
    }

    fn told(change: Change) -> Vec<String> {
        let ports = Told::default();
        tell(&ports, change);
        ports.0.into_inner()
    }

    #[test]
    fn every_file_written_is_named_to_the_editor() {
        let written = [
            "shaders/glow.gdshader".to_owned(),
            "assets/coin.png".to_owned(),
        ];
        assert_eq!(
            told(Change::Written(&written)),
            [r#"rescan ["shaders/glow.gdshader", "assets/coin.png"]"#]
        );
        assert!(told(Change::Written(&[])).is_empty());
    }

    /// A script is named like any other file: `didSave` alone never registers its `class_name`.
    /// And holder.gd, parsed before coin.gd's `class_name Coin` was registered, keeps saying
    /// `Could not find type "Coin"` until it is parsed again.
    #[test]
    fn a_written_script_reparses_the_open_scripts_once_the_rescan_registered_it() {
        let written = [
            "scripts/coin.gd".to_owned(),
            "shaders/glow.gdshader".to_owned(),
        ];
        assert_eq!(
            told(Change::Written(&written)),
            [
                r#"rescan ["scripts/coin.gd", "shaders/glow.gdshader"]"#,
                "reparse"
            ]
        );
    }

    /// An imported asset outlives its file until the editor walks the project, and a script that
    /// named it holds a stale verdict until it is parsed again.
    #[test]
    fn a_move_or_a_delete_rescans_the_project_and_reparses_the_open_scripts() {
        assert_eq!(told(Change::Moved), ["rescan []", "reparse"]);
    }

    #[test]
    fn only_a_command_that_writes_what_a_script_names_reparses() {
        for command in [
            "scene.save",
            "project.set_autoload",
            "resource.create_texture",
        ] {
            assert_eq!(told(Change::Answered(command)), ["reparse"], "{command}");
        }
        for command in ["node.set_property", "scene.get_tree", "runtime.run"] {
            assert!(told(Change::Answered(command)).is_empty(), "{command}");
        }
    }
}
