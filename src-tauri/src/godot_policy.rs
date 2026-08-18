//! The Godot rules Gofer enforces, and the addon calls that enforce them.
//!
//! Two rules, both verified against Godot 4.7.1 rather than assumed:
//!
//! * **Strict typing.** `debug/gdscript/warnings/*` warnings are tri-state — 0 Ignore, 1 Warn,
//!   2 Error — and five of them are what "no dynamic GDScript" means. `untyped_declaration` catches
//!   a `var` with no type; the four `unsafe_*` ones catch the Variant-typed access that stays legal
//!   even when every declaration is typed. All five ship as Ignore. Godot excludes `res://addons`
//!   from warnings by default, via `debug/gdscript/warnings/directory_rules`, so Gofer's own addon
//!   is not caught by a rule Gofer turned on.
//!
//! * **Embedded game window.** `run/window_placement/game_embed_mode` is an *editor* setting, so it
//!   is machine-wide and outside Git, unlike the five above. It reads -1 Disabled, 0 Use Per-Project
//!   Configuration, 1 Embed Game, 2 Make Game Workspace Floating. 1 is the only one that keeps the
//!   game inside the editor; 2 embeds it and then floats the whole workspace back out. On Linux
//!   the setting is only half of the rule: Godot embeds through a compositor it hosts itself, it
//!   ships exactly one — the Wayland embedder — and it starts on X11 by default even inside a
//!   Wayland session. The other half is the display driver the editor is launched with, in
//!   [`crate::godot_session`], because a launch argument is the only place it can be decided.
//!
//! Both are applied when a session goes ready, and only then. That is not a simplification: Godot
//! reads `game_embed_mode` once, at `NOTIFICATION_READY` of its game view, so changing it later
//! moves nothing until the editor is started again. Warnings are re-read whenever a script is
//! re-parsed, which a fresh session does anyway.
//!
//! The seam is `policy_calls`: a pure function from the two booleans to the addon requests. It is
//! what the tests drive, because the alternative is asserting against a live editor for a decision
//! that has nothing to do with one.
//!
//! Applying a rule is only half of enforcing it. An agent that meets a parse error it cannot fix
//! reaches for the setting that produced it — a live run went `search_settings`, "the real solution
//! is that Godot treats warnings as errors", `set_setting` — and every one of those calls was
//! auto-allowed, so the rule the user ticked was gone until the next session start, with nothing in
//! the UI saying so. `enforcement_refusal` is the other half: the calls that would undo an enforced
//! rule are refused at the AI tool router, in four short lines that name the fix instead of
//! arguing for the rule.

use crate::settings::GodotSettings;
use serde_json::{Value, json};

/// The five GDScript warnings that together mean "statically typed, no Variant access".
///
/// Held in one list because they are turned on and off together: four of them without the first
/// still let an untyped `var` through, and the first without the other four still lets
/// `node.speed = 1` through on a `Node`.
pub(crate) const STRICT_TYPING_WARNINGS: [&str; 5] = [
    "debug/gdscript/warnings/untyped_declaration",
    "debug/gdscript/warnings/unsafe_property_access",
    "debug/gdscript/warnings/unsafe_method_access",
    "debug/gdscript/warnings/unsafe_cast",
    "debug/gdscript/warnings/unsafe_call_argument",
];

/// The prefix every GDScript warning setting shares, and what the refusal is keyed on.
///
/// Wider than [`STRICT_TYPING_WARNINGS`] because three of its neighbours switch all five off
/// without naming any of them. Verified against 4.7.1 rather than assumed: with
/// `untyped_declaration` at 2, `var x = 1` is a parse error and the script does not load; with
/// `debug/gdscript/warnings/enable` set to `false`, or with `directory_rules` holding
/// `{"res://": 0}`, the setting stays at 2 and the same script loads and runs.
pub(crate) const WARNING_SETTING_PREFIX: &str = "debug/gdscript/warnings/";

/// The annotation family that turns a warning off from inside the source file.
///
/// `@warning_ignore`, `@warning_ignore_start` and `@warning_ignore_restore` all begin with this,
/// and all three defeat a warning that is an error — also verified against 4.7.1, because it is the
/// first thing the live run proposed. A `#` comment that merely mentions one does nothing, so a
/// comment is not what this looks at.
const WARNING_IGNORE_ANNOTATION: &str = "@warning_ignore";

/// Godot's warning level for "refuse to parse the script".
const WARNING_IS_AN_ERROR: i64 = 2;

/// The editor setting that decides where a launched game's window goes.
pub(crate) const GAME_EMBED_MODE: &str = "run/window_placement/game_embed_mode";

/// `game_embed_mode` 1, "Embed Game": the game is drawn inside the editor and cannot be torn out.
const EMBED_GAME: i64 = 1;

/// `game_embed_mode` 0, "Use Per-Project Configuration": Godot's own default, and what turning the
/// rule off restores. There is no `editor.reset_setting`, so the default is written rather than
/// reverted — which is the same thing here, because 0 is what a machine that never chose reads.
const EMBED_PER_PROJECT: i64 = 0;

/// One addon request, named the way `plugin.gd` names it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PolicyCall {
    pub(crate) command: &'static str,
    pub(crate) params: Value,
}

/// Every addon call that puts a live editor in the state these settings describe.
///
/// Turning a rule off is a write too, not an absence of one. A rule that only ever wrote when it
/// was on could never be undone: unticking the box would leave the project erroring on untyped code
/// with nothing in Gofer's UI still claiming to ask for it.
pub(crate) fn policy_calls(settings: &GodotSettings) -> Vec<PolicyCall> {
    let mut calls = Vec::with_capacity(STRICT_TYPING_WARNINGS.len() + 1);
    for warning in STRICT_TYPING_WARNINGS {
        calls.push(if settings.strict_typing {
            PolicyCall {
                command: "project.set_setting",
                params: json!({
                    "name": warning,
                    "value": {"type": "int", "value": WARNING_IS_AN_ERROR},
                }),
            }
        } else {
            // Reset rather than a write of 0: it is what puts the key back to the engine's own
            // default, which is what `project.godot` then stops mentioning at all.
            PolicyCall {
                command: "project.reset_setting",
                params: json!({ "name": warning }),
            }
        });
    }
    calls.push(PolicyCall {
        command: "editor.set_setting",
        params: json!({
            "name": GAME_EMBED_MODE,
            "value": {
                "type": "int",
                "value": if settings.embed_game_window { EMBED_GAME } else { EMBED_PER_PROJECT },
            },
        }),
    });
    calls
}

/// Why an enforced rule refuses this tool call, or `None` when the call is the agent's to make.
///
/// Three doors, because the live run walked toward all three. Writing or resetting anything under
/// `debug/gdscript/warnings/` is the direct one. Writing `game_embed_mode` is the same move against
/// the other rule — approval-gated already, but an approval is a question, and a rule the user
/// already answered is not a question worth asking again. `@warning_ignore` in a saved script is
/// the same undoing done per file, and the first one a model proposes.
///
/// The wording is imperative and short, in the register `pi-task`'s gate prompts settled on after
/// its own A/B runs: state the refusal, state the ban in one `Do NOT` line, name the fix, stop.
/// Prose explaining why the user chose the rule is text a weak model skims. What it needs is the
/// next action — and, because a wrong Godot 4 name is the other half of an unfixable parse error,
/// the reminder to look the type up in the docs rather than half-remember it.
pub(crate) fn enforcement_refusal(
    settings: &GodotSettings,
    tool: &str,
    op: &str,
    params: &Value,
) -> Option<String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match (tool, op) {
        ("godot_project", "set_setting" | "reset_setting")
            if settings.strict_typing && name.starts_with(WARNING_SETTING_PREFIX) =>
        {
            Some(format!(
                "REFUSED: `{name}`. Strict GDScript typing is enforced.\n\
                 Do NOT weaken, disable or scope out a warning to make a parse error go away. \
                 Every `{WARNING_SETTING_PREFIX}` write is refused, `enable` and \
                 `directory_rules` included.\n\
                 Fix the code: declare the type, or cast the access to the type you expect. Look \
                 the type up with godot_docs_search — do not guess it.\n\
                 Only the user can turn this rule off."
            ))
        }
        ("godot_project", "set_editor_setting")
            if settings.embed_game_window && name == GAME_EMBED_MODE =>
        {
            Some(format!(
                "REFUSED: `{name}`. An embedded game window is enforced, and the game runs inside \
                 the editor.\n\
                 Only the user can turn this rule off."
            ))
        }
        ("godot_script", "save" | "edit") if settings.strict_typing => {
            // A save carries the whole file, so the whole file is what it proposes. An edit carries
            // only the text it introduces, and only that text is its to answer for: refusing an
            // edit for an annotation already in the file would refuse every edit of that file
            // forever, over a line this call did not write.
            let proposed = params
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| introduced_text(params));
            suppressed_warning(&proposed).map(|warning| {
                format!(
                    "REFUSED: this script suppresses `{warning}` with a \
                     {WARNING_IGNORE_ANNOTATION} annotation. Strict GDScript typing is \
                     enforced.\n\
                     Do NOT annotate around the rule. The annotation hides the code from the \
                     warning, it does not fix it.\n\
                     Fix the code: declare the type, or cast the access to the type you expect, \
                     then write it again. Look the type up with godot_docs_search — do not guess \
                     it.\n\
                     Only the user can turn this rule off."
                )
            })
        }
        _ => None,
    }
}

/// Every `newText` an edit proposes, joined into one body to read for annotations. Nothing else in
/// the call is text this caller wrote: `oldText` is quoted from the file, and the file's other
/// lines are not on offer here at all.
fn introduced_text(params: &Value) -> String {
    params
        .get("files")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|file| file.get("edits").and_then(Value::as_array))
                .flatten()
                .filter_map(|edit| edit.get("newText").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// The first enforced warning a source file suppresses by annotation, by its short name.
///
/// Read per line and only ahead of the first `#`, because an annotation inside a comment is inert
/// and refusing one would be a refusal the compiler disagrees with.
fn suppressed_warning(text: &str) -> Option<&'static str> {
    text.lines()
        .map(|line| line.split('#').next().unwrap_or_default())
        .filter(|code| code.contains(WARNING_IGNORE_ANNOTATION))
        .find_map(|code| {
            STRICT_TYPING_WARNINGS
                .iter()
                .filter_map(|warning| warning.strip_prefix(WARNING_SETTING_PREFIX))
                .find(|short| code.contains(short))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enforcing() -> GodotSettings {
        GodotSettings {
            strict_typing: true,
            embed_game_window: true,
        }
    }

    fn relaxed() -> GodotSettings {
        GodotSettings {
            strict_typing: false,
            embed_game_window: false,
        }
    }

    #[test]
    fn strict_typing_errors_on_every_one_of_the_five_warnings() {
        let calls = policy_calls(&enforcing());
        for warning in STRICT_TYPING_WARNINGS {
            let call = calls
                .iter()
                .find(|call| call.params["name"] == warning)
                .unwrap_or_else(|| panic!("{warning} is written"));
            assert_eq!(call.command, "project.set_setting");
            assert_eq!(call.params["value"], json!({"type": "int", "value": 2}));
        }
    }

    /// The declared type is what `plugin.gd` fits the value to, and an untagged number is refused
    /// outright. A warning written as a bool or a bare 2 is a call the editor never performs.
    #[test]
    fn every_written_value_carries_its_type() {
        for settings in [enforcing(), relaxed()] {
            for call in policy_calls(&settings) {
                if call.command == "project.reset_setting" {
                    assert!(call.params.get("value").is_none());
                    continue;
                }
                assert_eq!(call.params["value"]["type"], "int");
                assert!(call.params["value"]["value"].is_i64());
            }
        }
    }

    #[test]
    fn embedding_asks_for_embed_game_rather_than_the_floating_workspace() {
        let calls = policy_calls(&enforcing());
        let embed = calls
            .iter()
            .find(|call| call.params["name"] == GAME_EMBED_MODE)
            .expect("the embed mode is written");
        assert_eq!(embed.command, "editor.set_setting");
        // 2 also embeds, and then floats the workspace out of the editor. Only 1 keeps it inside.
        assert_eq!(embed.params["value"]["value"], json!(1));
    }

    /// Turning a rule off has to undo it. This is the assertion that fails if someone ever
    /// "optimises" the off case into writing nothing.
    #[test]
    fn turning_the_rules_off_undoes_them() {
        let calls = policy_calls(&relaxed());
        for warning in STRICT_TYPING_WARNINGS {
            let call = calls
                .iter()
                .find(|call| call.params["name"] == warning)
                .unwrap_or_else(|| panic!("{warning} is reset"));
            assert_eq!(call.command, "project.reset_setting");
        }
        let embed = calls
            .iter()
            .find(|call| call.params["name"] == GAME_EMBED_MODE)
            .expect("the embed mode is written");
        assert_eq!(embed.params["value"]["value"], json!(0));
    }

    /// Both states write the same number of calls to the same names. A rule that wrote fewer calls
    /// when off would leave whichever setting it dropped holding the previous session's answer.
    #[test]
    fn both_states_touch_the_same_settings() {
        let named = |settings| {
            policy_calls(&settings)
                .into_iter()
                .map(|call| call.params["name"].as_str().unwrap_or_default().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(named(enforcing()), named(relaxed()));
        assert_eq!(named(enforcing()).len(), STRICT_TYPING_WARNINGS.len() + 1);
    }

    fn project_call(op: &str, name: &str) -> (&'static str, String, Value) {
        ("godot_project", op.to_owned(), json!({"name": name}))
    }

    fn refusal(settings: &GodotSettings, call: &(&'static str, String, Value)) -> Option<String> {
        enforcement_refusal(settings, call.0, &call.1, &call.2)
    }

    /// The direct move, and the one a live run made: meet the parse error, find the warning, write
    /// it back down to 0.
    #[test]
    fn the_five_warnings_cannot_be_written_or_reset_while_the_rule_is_on() {
        for warning in STRICT_TYPING_WARNINGS {
            for op in ["set_setting", "reset_setting"] {
                let call = project_call(op, warning);
                let message = refusal(&enforcing(), &call).expect("the warning is enforced");
                assert!(message.contains(warning), "the refusal names the setting");
                assert!(message.contains("Only the user can turn this rule off"));
                assert_eq!(refusal(&relaxed(), &call), None);
            }
        }
    }

    /// Neither of these is one of the five, and either one switches all five off. Both were run
    /// against Godot 4.7.1 with `untyped_declaration` at 2: `var x = 1` errors, and with either of
    /// these written the same script loads.
    #[test]
    fn the_settings_that_switch_the_five_off_without_naming_them_are_refused_too() {
        for name in [
            "debug/gdscript/warnings/enable",
            "debug/gdscript/warnings/directory_rules",
        ] {
            assert!(refusal(&enforcing(), &project_call("set_setting", name)).is_some());
        }
    }

    /// The refusal is keyed on the rule, not on the domain. Everything else in `godot_project` is
    /// the agent's, including the settings that have nothing to do with either rule.
    #[test]
    fn settings_outside_the_rules_are_still_the_agents_to_write() {
        for name in [
            "display/window/size/viewport_width",
            "debug/gdscript/completion/autocomplete_setters_and_getters",
            "application/run/main_scene",
        ] {
            assert_eq!(
                refusal(&enforcing(), &project_call("set_setting", name)),
                None
            );
        }
        assert_eq!(
            refusal(
                &enforcing(),
                &project_call("get_setting", STRICT_TYPING_WARNINGS[0])
            ),
            None,
            "reading a setting is not undoing it"
        );
    }

    /// `game_embed_mode` already stops for an approval. The rule refuses it before the prompt is
    /// raised, because asking the user to approve undoing their own answer is a worse dialog than
    /// no dialog.
    #[test]
    fn the_embed_rule_is_refused_before_it_can_become_a_prompt() {
        let call = (
            "godot_project",
            "set_editor_setting".to_owned(),
            json!({"name": GAME_EMBED_MODE}),
        );
        assert!(refusal(&enforcing(), &call).is_some());
        assert_eq!(refusal(&relaxed(), &call), None);
        // The rules are independent: strict typing on does not lock an unrelated editor setting.
        let unrelated = (
            "godot_project",
            "set_editor_setting".to_owned(),
            json!({"name": "interface/editor/single_window_mode"}),
        );
        assert_eq!(refusal(&enforcing(), &unrelated), None);
    }

    /// The other door, and the first one a model proposes: leave the setting alone and annotate the
    /// script instead. All three spellings were run against 4.7.1, and all three make an errored
    /// warning stop erroring.
    #[test]
    fn a_script_that_annotates_its_way_out_of_the_rule_is_not_saved() {
        for annotation in [
            "@warning_ignore(\"unsafe_method_access\")",
            "@warning_ignore_start(\"untyped_declaration\")",
            "@warning_ignore_restore(\"unsafe_cast\")",
        ] {
            let call = (
                "godot_script",
                "save".to_owned(),
                json!({"path": "res://player.gd", "text": format!("extends Node\n{annotation}\nvar x = 1\n")}),
            );
            let message = refusal(&enforcing(), &call).expect("the annotation is refused");
            assert!(
                message.contains("godot_docs_search"),
                "the fix names the docs to verify against"
            );
            assert_eq!(refusal(&relaxed(), &call), None);
        }
    }

    /// An edit answers for the text it introduces and for nothing else.
    ///
    /// Reading the whole file here would be the wrong rule twice over: the file is not in the call,
    /// and a file that already carries an annotation — written by the user, or by a session with
    /// this rule off — would have every edit of it refused from then on, over a line the call did
    /// not write. The `oldText` side is quoted from the file, so it is not this caller's text
    /// either.
    #[test]
    fn an_edit_answers_for_its_new_text_and_not_for_the_file() {
        let refusal_for = |edits: Value| {
            refusal(
                &enforcing(),
                &(
                    "godot_script",
                    "edit".to_owned(),
                    json!({"files": [{"path": "res://player.gd", "edits": edits}]}),
                ),
            )
        };
        let introduced = refusal_for(json!([
            {"oldText": "var x = 1", "newText": "var x = 1"},
            {"oldText": "func a():", "newText": "@warning_ignore(\"untyped_declaration\")\nfunc a():"},
        ]))
        .expect("the annotation this edit writes is refused");
        assert!(
            introduced.contains("godot_docs_search"),
            "the fix names the docs to verify against"
        );
        // The same annotation, already in the file and merely quoted back as the anchor.
        assert_eq!(
            refusal_for(json!([
                {"oldText": "@warning_ignore(\"untyped_declaration\")\nvar x = 1", "newText": "var x: int = 1"},
            ])),
            None,
            "an edit that removes an annotation is exactly the fix the rule asks for"
        );
    }

    /// Two false refusals worth not making. A warning outside the five is Godot's own to silence,
    /// and an annotation inside a comment is inert — the compiler ignores it, so refusing it would
    /// be a refusal the compiler disagrees with.
    #[test]
    fn an_unenforced_warning_and_a_commented_annotation_are_saved() {
        let saved = |text: &str| {
            refusal(
                &enforcing(),
                &(
                    "godot_script",
                    "save".to_owned(),
                    json!({"path": "res://player.gd", "text": text}),
                ),
            )
        };
        assert_eq!(
            saved("@warning_ignore(\"unused_variable\")\nvar x: int = 1\n"),
            None
        );
        assert_eq!(
            saved("# @warning_ignore(\"unsafe_cast\") would be cheating\nvar x: int = 1\n"),
            None
        );
        assert_eq!(
            saved("var speed: float = 1.0 # @warning_ignore(\"unsafe_cast\")\n"),
            None
        );
        assert!(saved("@warning_ignore(\"unsafe_cast\") # needed\nvar x = 1\n").is_some());
    }

    /// A project setting and an editor setting are not the same store: one lands in `project.godot`
    /// and is committed, the other is machine-wide and is not. Sending either through the other's
    /// command writes a setting nothing reads.
    #[test]
    fn project_rules_and_the_editor_rule_use_their_own_commands() {
        for call in policy_calls(&enforcing()) {
            let name = call.params["name"].as_str().expect("a name");
            if name == GAME_EMBED_MODE {
                assert_eq!(call.command, "editor.set_setting");
            } else {
                assert!(name.starts_with("debug/gdscript/warnings/"));
                assert_eq!(call.command, "project.set_setting");
            }
        }
    }
}
