//! The Godot rules Gofer enforces, and the addon calls that enforce them.
//!
//! Two rules, both verified against Godot 4.7.2 rather than assumed:
//!
//! * **Strict typing.** `debug/gdscript/warnings/*` warnings are tri-state — 0 Ignore, 1 Warn,
//!   2 Error. The rule sets all 49 that Godot 4.7.2 has, as the `godot-code-style` skill does, so
//!   a script Gofer writes and a script that style writes are held to the same compiler. Godot excludes `res://addons`
//!   from warnings by default, via `debug/gdscript/warnings/directory_rules`, so Gofer's own addon
//!   is not caught by a rule Gofer turned on.
//!
//! * **Embedded game window.** `run/window_placement/game_embed_mode` is an *editor* setting, so it
//!   is machine-wide and outside Git, unlike the warnings above. It reads -1 Disabled, 0 Use Per-Project
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
use crate::tool_params::Writes;
use serde_json::{Value, json};

/// One GDScript warning the rule raises to Error, and the level Godot ships it at.
pub(crate) struct EnforcedWarning {
    pub(crate) setting: &'static str,
    /// What turning the rule off leaves behind. Measured on 4.7.2 they ship at all three levels,
    /// so a reset is checked against this rather than against 0.
    #[cfg_attr(
        not(all(test, feature = "godot-acceptance")),
        expect(
            dead_code,
            reason = "only the acceptance suite reads a reset back from the engine"
        )
    )]
    pub(crate) shipped_level: i64,
}

const fn warning(setting: &'static str, shipped_level: i64) -> EnforcedWarning {
    EnforcedWarning {
        setting,
        shipped_level,
    }
}

/// Every GDScript warning Godot 4.7.2 has, in the order it lists them, turned on and off
/// together. `godot-code-style` sets the same 49.
pub(crate) const ENFORCED_WARNINGS: [EnforcedWarning; 49] = [
    warning("debug/gdscript/warnings/unassigned_variable", 1),
    warning("debug/gdscript/warnings/unassigned_variable_op_assign", 1),
    warning("debug/gdscript/warnings/unused_variable", 1),
    warning("debug/gdscript/warnings/unused_local_constant", 1),
    warning("debug/gdscript/warnings/unused_private_class_variable", 1),
    warning("debug/gdscript/warnings/unused_parameter", 1),
    warning("debug/gdscript/warnings/unused_signal", 1),
    warning("debug/gdscript/warnings/shadowed_variable", 1),
    warning("debug/gdscript/warnings/shadowed_variable_base_class", 1),
    warning("debug/gdscript/warnings/shadowed_global_identifier", 1),
    warning("debug/gdscript/warnings/unreachable_code", 1),
    warning("debug/gdscript/warnings/unreachable_pattern", 1),
    warning("debug/gdscript/warnings/standalone_expression", 1),
    warning("debug/gdscript/warnings/standalone_ternary", 1),
    warning("debug/gdscript/warnings/incompatible_ternary", 1),
    warning("debug/gdscript/warnings/untyped_declaration", 0),
    warning("debug/gdscript/warnings/inferred_declaration", 0),
    warning("debug/gdscript/warnings/unsafe_property_access", 0),
    warning("debug/gdscript/warnings/unsafe_method_access", 0),
    warning("debug/gdscript/warnings/unsafe_cast", 0),
    warning("debug/gdscript/warnings/unsafe_call_argument", 0),
    warning("debug/gdscript/warnings/unsafe_void_return", 1),
    warning("debug/gdscript/warnings/return_value_discarded", 0),
    warning("debug/gdscript/warnings/static_called_on_instance", 1),
    warning("debug/gdscript/warnings/missing_tool", 1),
    warning("debug/gdscript/warnings/redundant_static_unload", 1),
    warning("debug/gdscript/warnings/redundant_await", 1),
    warning("debug/gdscript/warnings/missing_await", 0),
    warning("debug/gdscript/warnings/assert_always_true", 1),
    warning("debug/gdscript/warnings/assert_always_false", 1),
    warning("debug/gdscript/warnings/integer_division", 1),
    warning("debug/gdscript/warnings/narrowing_conversion", 1),
    warning("debug/gdscript/warnings/int_as_enum_without_cast", 1),
    warning("debug/gdscript/warnings/int_as_enum_without_match", 1),
    warning("debug/gdscript/warnings/enum_variable_without_default", 1),
    warning("debug/gdscript/warnings/empty_file", 1),
    warning("debug/gdscript/warnings/deprecated_keyword", 1),
    warning("debug/gdscript/warnings/confusable_identifier", 1),
    warning("debug/gdscript/warnings/confusable_local_declaration", 1),
    warning("debug/gdscript/warnings/confusable_local_usage", 1),
    warning("debug/gdscript/warnings/confusable_capture_reassignment", 1),
    warning(
        "debug/gdscript/warnings/confusable_temporary_modification",
        1,
    ),
    warning("debug/gdscript/warnings/inference_on_variant", 2),
    warning("debug/gdscript/warnings/native_method_override", 2),
    warning(
        "debug/gdscript/warnings/get_node_default_without_onready",
        2,
    ),
    warning("debug/gdscript/warnings/onready_with_export", 2),
    warning("debug/gdscript/warnings/property_used_as_function", 1),
    warning("debug/gdscript/warnings/constant_used_as_function", 1),
    warning("debug/gdscript/warnings/function_used_as_property", 1),
];

/// The prefix every GDScript warning setting shares, and what the refusal is keyed on.
///
/// Wider than [`ENFORCED_WARNINGS`] because three of its neighbours switch them all off without
/// naming any of them. Verified against 4.7.2 rather than assumed: with
/// `untyped_declaration` at 2, `var x = 1` is a parse error and the script does not load; with
/// `debug/gdscript/warnings/enable` set to `false`, or with `directory_rules` holding
/// `{"res://": 0}`, the setting stays at 2 and the same script loads and runs.
pub(crate) const WARNING_SETTING_PREFIX: &str = "debug/gdscript/warnings/";

/// The annotation family that turns a warning off from inside the source file.
///
/// `@warning_ignore`, `@warning_ignore_start` and `@warning_ignore_restore` all begin with this,
/// and all three defeat a warning that is an error — also verified against 4.7.2, because it is the
/// first thing the live run proposed. A `#` comment that merely mentions one does nothing, so a
/// comment is not what this looks at.
const WARNING_IGNORE_ANNOTATION: &str = "@warning_ignore";
const WARNING_IGNORE_START: &str = "@warning_ignore_start(";
const WARNING_IGNORE_LINE: &str = "@warning_ignore(";

/// gdUnit4's naming for a test suite, and the only file a suppression is allowed in.
const TEST_SUITE_SUFFIX: &str = "_test.gd";

/// What a gdUnit4 suite may relax for the whole file. Its fluent asserts return values nobody
/// keeps, and its `await`s are on calls declared as plain returns. Measured on 4.7.2: no suite
/// loads without them, and none needs anything else file-wide.
const TEST_SUITE_FILE_WIDE: [&str; 2] = ["return_value_discarded", "redundant_await"];

/// What a suite may relax on one line: a fuzzer parameter, which gdUnit4 re-reads from source and
/// cannot build when typed, and a `verify` whose argument matcher is not the parameter's type.
const TEST_SUITE_ONE_LINE: [&str; 4] = [
    "return_value_discarded",
    "redundant_await",
    "inferred_declaration",
    "unsafe_method_access",
];

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
    let mut calls = Vec::with_capacity(ENFORCED_WARNINGS.len() + 1);
    for warning in &ENFORCED_WARNINGS {
        calls.push(if settings.strict_typing {
            PolicyCall {
                command: "project.set_setting",
                params: json!({
                    "name": warning.setting,
                    "value": {"type": "int", "value": WARNING_IS_AN_ERROR},
                }),
            }
        } else {
            PolicyCall {
                command: "project.reset_setting",
                params: json!({ "name": warning.setting }),
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
/// Keyed on what the operation writes rather than on its name: [`Writes`] is carried by the row
/// that declares the operation, so an operation renamed there cannot quietly stop being enforced,
/// and this reads the rule rather than a fifth match on `(tool, op)`.
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
    writes: Option<Writes>,
    params: &Value,
) -> Option<String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match writes? {
        Writes::ProjectSetting
            if settings.strict_typing && name.starts_with(WARNING_SETTING_PREFIX) =>
        {
            Some(format!(
                "REFUSED: `{name}`. Strict GDScript typing is enforced.\n\
                 Do NOT weaken, disable or scope out a warning to make a parse error go away. \
                 Every `{WARNING_SETTING_PREFIX}` write is refused, `enable` and \
                 `directory_rules` included.\n\
                 Fix the code: declare the type, and read a Variant into a typed local — an `as` \
                 cast of one is an error too. Look the type up with docs_search.search — do not \
                 guess it.\n\
                 Only the user can turn this rule off."
            ))
        }
        Writes::EditorSetting if settings.embed_game_window && name == GAME_EMBED_MODE => {
            Some(format!(
                "REFUSED: `{name}`. An embedded game window is enforced, and the game runs inside \
                 the editor.\n\
                 Only the user can turn this rule off."
            ))
        }
        Writes::ScriptText if settings.strict_typing => proposed_files(params)
            .iter()
            .find_map(|(path, text)| suppressed_warning(path, text))
            .map(|warning| {
                format!(
                    "REFUSED: this script suppresses `{warning}` with a \
                     {WARNING_IGNORE_ANNOTATION} annotation. Strict GDScript typing is \
                     enforced.\n\
                     Do NOT annotate around the rule. The annotation hides the code from the \
                     warning, it does not fix it.\n\
                     Fix the code: declare the type, and read a Variant into a typed local — an \
                     `as` cast of one is an error too — then write it again. Look the type up with \
                     docs_search.search — do not guess it.\n\
                     Only the user can turn this rule off."
                )
            }),
        _ => None,
    }
}

/// Every file a call puts on disk, as its path and the text this caller wrote into it.
///
/// `save` and `apply_rename` carry the whole file — `text`, and `updatedText` per entry — so the
/// whole file is what is read, including an annotation the rename did not introduce, for the same
/// reason a `save` of that file is refused over one. An `edit` carries only its `newText`: `oldText`
/// is quoted from the file, and the file's other lines are not on offer here at all.
fn proposed_files(params: &Value) -> Vec<(String, String)> {
    let path_of = |value: &Value| {
        value
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    if let Some(text) = params.get("text").and_then(Value::as_str) {
        return vec![(path_of(params), text.to_owned())];
    }
    let files = params
        .get("files")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    files
        .iter()
        .map(|file| {
            let text = match file.get("updatedText").and_then(Value::as_str) {
                Some(whole) => whole.to_owned(),
                None => file
                    .get("edits")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|edit| edit.get("newText").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n"),
            };
            (path_of(file), text)
        })
        .collect()
}

/// The first warning a file suppresses that it may not, or the annotation itself when it names
/// none.
///
/// Read per line and only ahead of the first `#`, because an annotation inside a comment is inert
/// and refusing one would be a refusal the compiler disagrees with.
fn suppressed_warning(path: &str, text: &str) -> Option<String> {
    let test_suite = path.ends_with(TEST_SUITE_SUFFIX);
    text.lines()
        .map(|line| line.split('#').next().unwrap_or_default())
        .filter_map(|code| {
            code.find(WARNING_IGNORE_ANNOTATION)
                .map(|at| code[at..].trim_end())
        })
        .find_map(|annotation| {
            let allowed: &[&str] = if !test_suite {
                &[]
            } else if annotation.starts_with(WARNING_IGNORE_START) {
                &TEST_SUITE_FILE_WIDE
            } else if annotation.starts_with(WARNING_IGNORE_LINE) {
                &TEST_SUITE_ONE_LINE
            } else {
                &[]
            };
            let named: Vec<&str> = annotation
                .split_once('(')
                .and_then(|(_, rest)| rest.split_once(')'))
                .map(|(names, _)| {
                    names
                        .split(',')
                        .map(|name| name.trim().trim_matches('"'))
                        .collect()
                })
                .unwrap_or_default();
            if named.is_empty() {
                return Some(annotation.to_owned());
            }
            named
                .into_iter()
                .find(|name| !allowed.contains(name))
                .map(str::to_owned)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enforcing() -> GodotSettings {
        GodotSettings {
            strict_typing: true,
            embed_game_window: true,
            headless: false,
        }
    }

    fn relaxed() -> GodotSettings {
        GodotSettings {
            strict_typing: false,
            embed_game_window: false,
            headless: false,
        }
    }

    #[test]
    fn strict_typing_errors_on_every_enforced_warning() {
        let calls = policy_calls(&enforcing());
        for warning in ENFORCED_WARNINGS.map(|warning| warning.setting) {
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
        assert_eq!(embed.params["value"]["value"], json!(1));
    }

    /// Turning a rule off has to undo it. This is the assertion that fails if someone ever
    /// "optimises" the off case into writing nothing.
    #[test]
    fn turning_the_rules_off_undoes_them() {
        let calls = policy_calls(&relaxed());
        for warning in ENFORCED_WARNINGS.map(|warning| warning.setting) {
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
        assert_eq!(named(enforcing()).len(), ENFORCED_WARNINGS.len() + 1);
    }

    fn project_call(op: &str, name: &str) -> (&'static str, String, Value) {
        ("godot_project", op.to_owned(), json!({"name": name}))
    }

    /// One call, put through the same two steps the router takes: the operation is resolved by
    /// name, and what it writes is read off the row rather than restated here. A tag that fell off
    /// an operation in `params.json` fails these tests rather than silently unenforcing the rule.
    fn refusal(settings: &GodotSettings, call: &(&'static str, String, Value)) -> Option<String> {
        let operation = crate::tool_params::operation_of(call.0, &call.1)
            .unwrap_or_else(|| panic!("{} {} is a catalogue operation", call.0, call.1));
        enforcement_refusal(settings, operation.writes(), &call.2)
    }

    /// The direct move, and the one a live run made: meet the parse error, find the warning, write
    /// it back down to 0.
    #[test]
    fn an_enforced_warning_cannot_be_written_or_reset_while_the_rule_is_on() {
        for warning in ENFORCED_WARNINGS.map(|warning| warning.setting) {
            for op in ["set_setting", "reset_setting"] {
                let call = project_call(op, warning);
                let message = refusal(&enforcing(), &call).expect("the warning is enforced");
                assert!(message.contains(warning), "the refusal names the setting");
                assert!(message.contains("Only the user can turn this rule off"));
                assert_eq!(refusal(&relaxed(), &call), None);
            }
        }
    }

    /// Neither of these is an enforced warning, and either one switches them all off. Both were run
    /// against Godot 4.7.2 with `untyped_declaration` at 2: `var x = 1` errors, and with either of
    /// these written the same script loads.
    #[test]
    fn the_settings_that_switch_the_rule_off_without_naming_a_warning_are_refused_too() {
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
                &project_call("get_setting", ENFORCED_WARNINGS[0].setting)
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
        let unrelated = (
            "godot_project",
            "set_editor_setting".to_owned(),
            json!({"name": "interface/editor/single_window_mode"}),
        );
        assert_eq!(refusal(&enforcing(), &unrelated), None);
    }

    /// The other door, and the first one a model proposes: leave the setting alone and annotate the
    /// script instead. All three spellings were run against 4.7.2, and all three make an errored
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
                message.contains("docs_search.search"),
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
            introduced.contains("docs_search.search"),
            "the fix names the docs to verify against"
        );
        assert_eq!(
            refusal_for(json!([
                {"oldText": "@warning_ignore(\"untyped_declaration\")\nvar x = 1", "newText": "var x: int = 1"},
            ])),
            None,
            "an edit that removes an annotation is exactly the fix the rule asks for"
        );
    }

    /// The third door, and the one nothing was watching: hand-build a rename plan.
    ///
    /// `apply_rename` writes a whole file per entry, exactly the way `save` does, and for a while it
    /// carried no `writes` tag at all — so an agent refused on `save` could read the file back, put
    /// its text in a one-entry plan and land the same annotation on disk with the rule on. The
    /// whole file is what it proposes, so the whole file is what is read.
    #[test]
    fn a_rename_plan_cannot_write_what_a_save_would_be_refused_for() {
        let plan = |updated: &str| {
            refusal(
                &enforcing(),
                &(
                    "godot_script",
                    "apply_rename".to_owned(),
                    json!({"files": [{
                        "path": "res://player.gd",
                        "originalText": "var x = 1\n",
                        "originalHash": "whatever",
                        "updatedText": updated,
                    }]}),
                ),
            )
        };
        let message = plan("@warning_ignore(\"unsafe_cast\")\nvar x = 1\n")
            .expect("a plan carrying the annotation is refused");
        assert!(message.contains("docs_search.search"));
        assert_eq!(
            plan("var x: int = 1\n"),
            None,
            "an ordinary rename is still an ordinary rename"
        );
    }

    fn saved_at(path: &str, text: &str) -> Option<String> {
        refusal(
            &enforcing(),
            &(
                "godot_script",
                "save".to_owned(),
                json!({"path": path, "text": text}),
            ),
        )
    }

    /// The style suppresses nothing, so even a warning outside the enforced list is refused, and
    /// an annotation that names no warning at all names itself.
    #[test]
    fn game_code_suppresses_no_warning_at_all() {
        let refused = |text: &str, warning: &str| {
            saved_at("res://player.gd", text)
                .is_some_and(|message| message.contains(&format!("`{warning}`")))
        };
        assert!(refused(
            "@warning_ignore(\"unreachable_code\")\nvar x: int = 1\n",
            "unreachable_code"
        ));
        assert!(
            refused(
                "@warning_ignore_start(\"return_value_discarded\")\n",
                "return_value_discarded"
            ),
            "what a test suite may relax, game code may not"
        );
        assert!(saved_at("res://player.gd", "@warning_ignore_start\nvar x: int = 1\n").is_some());
    }

    /// A gdUnit4 suite gets exactly what it cannot load without, and nothing more: two warnings
    /// file-wide, two more on one line.
    #[test]
    fn a_test_suite_may_relax_only_what_gdunit4_needs() {
        let suite = |text: &str| saved_at("res://test/player_test.gd", text);
        assert_eq!(
            suite(
                "extends GdUnitTestSuite\n\
                 @warning_ignore_start(\"return_value_discarded\")\n\
                 @warning_ignore_start(\"redundant_await\")\n\
                 @warning_ignore(\"inferred_declaration\")\n\
                 func test_x(fuzzer := Fuzzers.rand_str(1, 12)) -> void:\n\
                 \t@warning_ignore(\"unsafe_method_access\")\n\
                 \tverify(weapon, 2).fire(any_vector2())\n"
            ),
            None
        );
        for (annotation, refused) in [
            (
                "@warning_ignore_start(\"unsafe_method_access\")",
                "unsafe_method_access",
            ),
            (
                "@warning_ignore_start(\"inferred_declaration\")",
                "inferred_declaration",
            ),
            (
                "@warning_ignore(\"unsafe_property_access\")",
                "unsafe_property_access",
            ),
            (
                "@warning_ignore(\"redundant_await\", \"unsafe_cast\")",
                "unsafe_cast",
            ),
            (
                "@warning_ignore_restore(\"redundant_await\")",
                "redundant_await",
            ),
        ] {
            assert!(
                suite(annotation).is_some_and(|message| message.contains(&format!("`{refused}`"))),
                "{annotation}"
            );
        }
    }

    /// An edit is judged by the path of the file it lands in, so one call cannot carry a test
    /// suite's allowance into a game script.
    #[test]
    fn an_edit_carries_the_allowance_of_its_own_file_only() {
        let edit = json!({"files": [
            {"path": "res://test/player_test.gd", "edits": [
                {"oldText": "extends GdUnitTestSuite", "newText": "extends GdUnitTestSuite\n@warning_ignore_start(\"redundant_await\")"}
            ]},
            {"path": "res://player.gd", "edits": [
                {"oldText": "func a():", "newText": "@warning_ignore(\"redundant_await\")\nfunc a():"}
            ]},
        ]});
        let call = ("godot_script", "edit".to_owned(), edit);
        assert!(refusal(&enforcing(), &call).is_some());
    }

    /// An annotation inside a comment is inert — the compiler ignores it, so refusing it would be a
    /// refusal the compiler disagrees with.
    #[test]
    fn a_commented_annotation_is_saved() {
        let saved = |text: &str| saved_at("res://player.gd", text);
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
