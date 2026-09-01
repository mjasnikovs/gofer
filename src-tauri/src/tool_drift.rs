//! What the catalogue says an operation takes, checked against what actually reads it.
//!
//! Nine drift checks over four surfaces: the addon's GDScript handlers, the Rust handlers behind
//! the desktop operations, the prose summaries the model is shown, and the parameter tables in
//! `params.json`. A name in one and not another is an operation the app advertises and cannot
//! perform, or a parameter a model is told to pass and nothing reads.
//!
//! Its own module because it is not the router. It sat inside `ai_tools.rs` — a quarter of that
//! file — so reading the router meant reading a thousand lines of source-text parser first, and the
//! parsers themselves had no tests: every one of them can go blind on a rename or a reformat, and a
//! blind parser makes its check pass on an empty set rather than fail. `fixtures` below is what
//! stops that, and every check that still reads a surface asserts it found something before
//! comparing.
//!
//! Only one of the four surfaces is still *read*. The Rust half was recovered by parsing this
//! crate's own source — find `struct X {`, read to the first `\n}`, split each line on its first
//! `:`, and for the router's own arms find `"list" =>` and stop at the next line beginning with
//! exactly eight spaces and a quote. That made a test a constraint on how the router could be
//! written, and it went blind in every way a parser can: a field whose type wrapped onto a second
//! line was dropped in silence, and an arm that moved a column parsed to nothing at all. Each Rust
//! request now declares its own fields beside itself, so this file compares two tables. What is
//! still parsed is GDScript, which really is another language across a socket, and the English of
//! the summaries, which is prose and has no other form.

#![cfg(test)]

use crate::ai_tools::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// The parsers, against snippets written here rather than against the app.
///
/// The checks below that still read a surface read GDScript or English with a hand-rolled parser,
/// and a parser that stops recognising its surface does not fail — it answers with nothing, and a
/// comparison against nothing passes. These are the tests that say what each parser is supposed to
/// find, so a rename or a reformat breaks something loud.
mod fixtures {
    use super::*;

    #[test]
    fn gdscript_is_split_into_function_bodies() {
        let source = "extends Node\n\nfunc _ready() -> void:\n\tprint(1)\n\nstatic func decode(x):\n\treturn x\n";
        let functions = gd_functions(source);
        assert_eq!(functions.len(), 2, "{functions:?}");
        assert!(functions["_ready"].contains("print(1)"));
        assert!(functions["decode"].contains("return x"));
    }

    #[test]
    fn a_handler_is_read_through_the_helpers_it_hands_its_parameters_to() {
        let mut functions = HashMap::new();
        functions.insert("_do_thing", "\tvar a = params.get(\"path\")\n\tif params.has(\"lines\"):\n\t\tpass\n\treturn _coords(params, \"tiles\")\n".to_owned());
        functions.insert("_coords", "\treturn params[\"origin\"]\n".to_owned());

        let read = params_a_handler_reads("_do_thing", &functions, &mut BTreeSet::new());
        assert_eq!(
            read,
            ["lines", "origin", "path", "tiles"]
                .into_iter()
                .map(str::to_owned)
                .collect::<BTreeSet<_>>(),
            "all three spellings, plus the key named at the call site and the one the helper reads"
        );
    }

    /// A helper name in an argument list is not a helper call. `_config_error("invalid_params", …)`
    /// carries the word and hands over nothing.
    #[test]
    fn a_call_that_merely_mentions_parameters_is_not_one_that_reads_them() {
        assert!(hands_on_the_parameters("params, \"tiles\""));
        assert!(!hands_on_the_parameters("\"invalid_params\", \"no path\""));
    }

    #[test]
    fn a_gdscript_dispatch_table_is_read_as_command_to_handler() {
        let body = "\tmatch command:\n\t\t\"scene.save\":\n\t\t\treturn _scene_save(params)\n\t\t\"project.get_setting\":\n\t\t\treturn ProjectConfig.get_setting(params)\n";
        assert_eq!(
            dispatch_pairs(body, "return "),
            vec![
                ("scene.save".to_owned(), "_scene_save".to_owned()),
                ("project.get_setting".to_owned(), "get_setting".to_owned())
            ],
            "a handler in another addon script is read by the name that script defines it under"
        );
    }

    /// The English one: the first `{…}` shape a summary writes out, read as a list of names.
    #[test]
    fn a_summary_is_read_as_the_parameter_names_it_writes_out() {
        let summary = "Runs the project. Takes {playArgs?, breakpoints?} and answers with {runId}.";
        assert_eq!(
            documented_parameters(summary),
            vec!["playArgs".to_owned(), "breakpoints".to_owned()],
            "the first block is the parameters; anything after it is the answer"
        );
    }

    /// A parameter may carry a shape of its own, and that names one parameter rather than three.
    #[test]
    fn a_nested_shape_in_a_summary_is_one_parameter() {
        assert_eq!(
            documented_parameters("Takes {playArgs?, breakpoints?: [{path, lines}]}."),
            vec!["playArgs".to_owned(), "breakpoints".to_owned()]
        );
    }
}

/// Every brace group in a summary written in bare identifiers — `{parent, type, name}` rather
/// than a quoted JSON example.
///
/// A JSON example teaches; a bare group restates a contract. The two are told apart by the quotes,
/// because that is exactly what distinguishes "here is a call you could make" from "here is the
/// shape of this parameter".
fn shapes_written_out(summary: &str) -> Vec<BTreeSet<String>> {
    let mut groups = Vec::new();
    let mut depth = 0usize;
    let mut group = String::new();
    for character in summary.chars() {
        match character {
            '{' => {
                depth += 1;
                if depth == 1 {
                    group.clear();
                }
            }
            '}' if depth > 0 => {
                depth -= 1;
                if depth == 0 && !group.contains('"') {
                    groups.push(
                        group
                            .split(',')
                            .map(|token| {
                                token
                                    .split(':')
                                    .next()
                                    .unwrap_or_default()
                                    .trim()
                                    .trim_end_matches('?')
                                    .to_owned()
                            })
                            .filter(|token| {
                                !token.is_empty()
                                    && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                            })
                            .collect(),
                    );
                }
            }
            _ if depth > 0 => group.push(character),
            _ => {}
        }
    }
    groups
}

/// The field names of every declared parameter's `entry`, one set per parameter that has one.
fn declared_entry_shapes(params: &[crate::tool_params::Param]) -> Vec<BTreeSet<String>> {
    let mut shapes = Vec::new();
    for param in params {
        if param.entry.is_empty() {
            continue;
        }
        shapes.push(
            param
                .entry
                .iter()
                .map(|field| field.name.to_owned())
                .collect(),
        );
        shapes.extend(declared_entry_shapes(param.entry));
    }
    shapes
}

#[test]
fn no_summary_restates_a_shape_the_signature_already_carries() {
    let mut restated = Vec::new();
    let mut checked = 0;
    for domain in CATALOG {
        for operation in domain.operations {
            let Some(params) = crate::tool_params::params_of(domain.name, operation.op) else {
                continue;
            };
            checked += 1;
            let declared: Vec<BTreeSet<String>> = declared_entry_shapes(params);
            let top: BTreeSet<String> = params.iter().map(|p| p.name.to_owned()).collect();
            for group in shapes_written_out(operation.summary) {
                if group.len() < 2 {
                    continue;
                }
                let names_an_entry = declared
                    .iter()
                    .any(|shape| group.iter().filter(|name| shape.contains(*name)).count() >= 2);
                let names_the_parameters = group.iter().all(|name| top.contains(name));
                if names_an_entry || names_the_parameters {
                    restated.push(format!(
                        "{} {} writes out {{{}}}, which its signature already says: {}",
                        domain.name,
                        operation.op,
                        group.iter().cloned().collect::<Vec<_>>().join(", "),
                        crate::tool_params::signature(params)
                    ));
                }
            }
        }
    }
    assert!(
        restated.is_empty(),
        "prose richer than the contract, in a place nothing enforces:\n{}",
        restated.join("\n")
    );
    assert!(
        checked > 50,
        "only {checked} operations declare parameters, so this test proves little"
    );
}

/// The addon halves this file's catalog claims to describe: the editor plugin, and the helper
/// that rides inside the running game.
const EDITOR_ADDON: &str = include_str!("../addon/plugin.gd");
/// The editor half's other file: what the commands decide before they touch the editor.
///
/// Split out of `plugin.gd` so it can be loaded without an editor, which is what puts every
/// parameter refusal in the one-second headless suite instead of the fifty-second one. To these
/// drift checks the two are one source, because to a command they are.
const PARAMS_ADDON: &str = include_str!("../addon/params.gd");
/// The editor half's third file: everything the `project.*` commands decide, which is also
/// nothing an editor has to be open for.
const PROJECT_ADDON: &str = include_str!("../addon/project_config.gd");
/// The editor half's fourth file: what a call to the running game is told when it runs out of
/// time, which is arithmetic over a queue and not something an editor answers.
const RUNTIME_QUEUE_ADDON: &str = include_str!("../addon/runtime_queue.gd");
const RUNTIME_ADDON: &str = include_str!("../addon/runtime.gd");

/// Every function of the editor half, whichever of its four files it lives in.
fn editor_functions() -> HashMap<&'static str, String> {
    let mut functions = gd_functions(EDITOR_ADDON);
    functions.extend(gd_functions(PARAMS_ADDON));
    functions.extend(gd_functions(PROJECT_ADDON));
    functions.extend(gd_functions(RUNTIME_QUEUE_ADDON));
    functions
}

/// The one parameter a summary may leave out. `scene` is an optional guard the *renderer*
/// passes — the scene path a panel believes is open, so a stale tab cannot edit the scene that
/// replaced it. The model has no stale view to guard, and naming it would invite it to send
/// one and be refused with `wrong_scene`.
const NOT_THE_MODEL_S_TO_PASS: [&str; 1] = ["scene"];

/// The two parameters a summary names that no handler reads. `rpc` lifts both out of the body
/// and onto the envelope, so the addon sees them beside the command rather than inside it.
const LIFTED_ONTO_THE_ENVELOPE: [&str; 2] = ["expectedRevision", "timeoutMs"];

/// Splits GDScript into its function bodies, keyed by name.
fn gd_functions(source: &str) -> HashMap<&str, String> {
    let mut functions: HashMap<&str, String> = HashMap::new();
    let mut current: Option<&str> = None;
    let mut body = String::new();
    for line in source.lines() {
        if let Some(rest) = line
            .strip_prefix("func ")
            .or_else(|| line.strip_prefix("static func "))
        {
            if let Some(name) = current.take() {
                functions.insert(name, std::mem::take(&mut body));
            }
            current = rest.split('(').next();
        } else if current.is_some() {
            body.push_str(line);
            body.push('\n');
        }
    }
    if let Some(name) = current {
        functions.insert(name, body);
    }
    functions
}

/// Every string that follows `needle` up to its closing quote. `needle` ends with the opening
/// one, so this reads `params.get("` and answers with the key.
fn quoted_after<'a>(body: &'a str, needle: &str) -> Vec<&'a str> {
    body.match_indices(needle)
        .filter_map(|(at, _)| body[at + needle.len()..].split('"').next())
        .collect()
}

/// Whether an argument list names `params` itself rather than merely containing the word — so
/// `_config_error("invalid_params", …)` is not mistaken for a call that reads parameters.
fn hands_on_the_parameters(arguments: &str) -> bool {
    arguments
        .split(|character: char| !(character.is_alphanumeric() || character == '_'))
        .any(|token| token == "params")
}

/// The helper calls a body passes its parameters to, with their argument text. Callee first,
/// so a key the helper reads is found by following it.
///
/// A call is followed when it names a function of the addon. Matching on the leading underscore
/// and the `Params.` prefix alone missed the calls `params.gd` makes to its own siblings, which
/// are written unqualified — so a decision moved out of a handler into a plan function took its
/// parameters out of this scan with it.
fn calls_taking_params<'a>(
    body: &'a str,
    functions: &HashMap<&str, String>,
) -> Vec<(&'a str, &'a str)> {
    let mut found = Vec::new();
    for (at, _) in body.match_indices('(') {
        let before = &body[..at];
        let start = before
            .rfind(|character: char| !(character.is_alphanumeric() || character == '_'))
            .map_or(0, |index| index + 1);
        let name = &before[start..];
        let Some(length) = body[at..].find(')') else {
            continue;
        };
        let arguments = &body[at + 1..at + length];
        let is_helper = name.starts_with('_')
            || before[..start].ends_with("Params.")
            || functions.contains_key(name);
        if is_helper && hands_on_the_parameters(arguments) {
            found.push((name, arguments));
        }
    }
    found
}

/// Whether a literal argument could be a parameter name — `"tiles"` can, the command names and
/// prose that share those argument lists cannot.
fn could_be_a_parameter_name(literal: &str) -> bool {
    !literal.is_empty()
        && literal.starts_with(|character: char| character.is_ascii_lowercase())
        && literal
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}

/// Every parameter one addon handler reads, following the helpers it hands them to.
fn params_a_handler_reads(
    handler: &str,
    functions: &HashMap<&str, String>,
    seen: &mut BTreeSet<String>,
) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    if !seen.insert(handler.to_owned()) {
        return keys;
    }
    let Some(body) = functions.get(handler) else {
        return keys;
    };
    for needle in ["params.get(\"", "params.has(\"", "params[\""] {
        keys.extend(quoted_after(body, needle).into_iter().map(str::to_owned));
    }
    for (callee, arguments) in calls_taking_params(body, functions) {
        keys.extend(
            quoted_after(arguments, "\"")
                .into_iter()
                .filter(|literal| could_be_a_parameter_name(literal))
                .map(str::to_owned),
        );
        keys.extend(params_a_handler_reads(callee, functions, seen));
    }
    keys
}

/// The `"command":` / `return _handler(params)` pairs of a GDScript match, in source order.
fn dispatch_pairs(body: &str, answers_with: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let mut command: Option<&str> = None;
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(named) = trimmed
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix("\":"))
        {
            command = Some(named);
        } else if let (Some(named), Some(rest)) =
            (command, trimmed.strip_prefix(answers_with).map(str::trim))
        {
            let called = rest
                .strip_prefix("await ")
                .unwrap_or(rest)
                .split('(')
                .next()
                .unwrap_or_default();
            // A handler outside the plugin class is reached through the preload constant of its
            // script, and `gd_functions` keys every function by its bare name.
            let (module, handler) = called.rsplit_once('.').unwrap_or(("", called));
            let through_a_module = module.starts_with(char::is_uppercase);
            if handler.starts_with('_') || through_a_module {
                pairs.push((named.to_owned(), handler.to_owned()));
                command = None;
            }
        }
    }
    pairs
}

/// The body under each `"prefix…":` label of a GDScript match, keyed by the label. A label ends
/// the previous arm, so an arm is everything between one label and the next.
fn match_arms(body: &str, prefix: &str) -> Vec<(String, String)> {
    let mut arms: Vec<(String, String)> = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(label) = trimmed
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix("\":"))
        {
            arms.push((label.to_owned(), String::new()));
        } else if let Some((_, collected)) = arms.last_mut() {
            collected.push_str(line);
            collected.push('\n');
        }
    }
    arms.retain(|(label, _)| label.starts_with(prefix));
    arms
}

/// What every addon command reads, both the editor's own and the ones forwarded to the game.
fn params_every_addon_command_reads() -> BTreeMap<String, BTreeSet<String>> {
    let editor = editor_functions();
    let runtime = gd_functions(RUNTIME_ADDON);
    let mut reads: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (command, handler) in dispatch_pairs(EDITOR_ADDON, "return ") {
        reads.insert(
            command,
            params_a_handler_reads(&handler, &editor, &mut BTreeSet::new()),
        );
    }
    let forwarding = editor
        .get("_handle_runtime_request")
        .cloned()
        .unwrap_or_default();
    let served: BTreeMap<String, String> = dispatch_pairs(RUNTIME_ADDON, "result = ")
        .into_iter()
        .collect();
    for (command, arm) in match_arms(&forwarding, "runtime.") {
        let mut keys: BTreeSet<String> = ["params.get(\"", "params.has(\"", "params[\""]
            .iter()
            .flat_map(|needle| quoted_after(&arm, needle))
            .map(str::to_owned)
            .collect();
        for forwarded in quoted_after(&arm, "_runtime_forward(id, \"") {
            if let Some(handler) = served.get(forwarded) {
                keys.extend(params_a_handler_reads(
                    handler,
                    &runtime,
                    &mut BTreeSet::new(),
                ));
            }
        }
        reads.insert(command, keys);
    }
    reads
}

/// The parameters a summary names, which is the first `{…}` it carries. Everything after that
/// is prose and examples — the value tags, the cell entries — and belongs to a parameter rather
/// than being one.
fn documented_parameters(summary: &str) -> Vec<String> {
    let Some(open) = summary.find('{') else {
        return Vec::new();
    };
    let mut depth = 0usize;
    let mut items: Vec<String> = Vec::new();
    let mut item = String::new();
    for character in summary[open..].chars() {
        match character {
            '{' | '[' => depth += 1,
            '}' | ']' => {
                depth -= 1;
                if depth == 0 {
                    items.push(std::mem::take(&mut item));
                    break;
                }
            }
            ',' if depth == 1 => items.push(std::mem::take(&mut item)),
            _ if depth == 1 => item.push(character),
            _ => {}
        }
    }
    items
        .iter()
        .filter_map(|item| {
            let name: String = item
                .trim()
                .chars()
                .take_while(|character| character.is_alphanumeric() || *character == '_')
                .collect();
            (!name.is_empty()).then_some(name)
        })
        .collect()
}

/// The addon command a catalog operation reaches, or `None` when it is answered in Rust.
///
/// One lookup, in the table the router itself routes from. This used to re-derive the prefix
/// arithmetic and both exception lists — a second copy of a mapping that was already data.
fn addon_command_behind(domain: &str, op: &str) -> Option<String> {
    match crate::tool_params::answers(domain, op)? {
        crate::tool_params::Answers::Addon(command) => Some(command.to_owned()),
        crate::tool_params::Answers::Rust => None,
    }
}

/// `path` names a file everywhere but one operation, and that one says so.
///
/// Counted over the whole catalogue: 29 operations declare a `path`, and in 28 of them it is a file
/// — a scene, a script, a resource. In `godot_runtime inspect_node` it is a **node**, and
/// `godot_node` calls that same thing `node`. So a model reading `path` has 28 reasons to write a
/// file and one operation where that is wrong.
///
/// It writes `node` there instead: **seven times across seven live runs**, every one refused with
/// `godot_runtime inspect_node has no \`node\` parameter`, every one corrected on the next call.
/// That is the most persistent unrepaired shape in the recorded corpus, and repairing it is a
/// guess — "one required parameter missing, one stray of the same kind" renames `colour` onto
/// `name` sooner or later. What is not a guess is saying, in the description the model reads before
/// it writes anything, that this one is the exception.
///
/// This test is what stops the exception growing a second member quietly. A new operation whose
/// `path` is a node either says so in its note or fails here.
#[test]
fn the_one_path_that_names_a_node_says_so() {
    let mut noted = Vec::new();
    let mut bare = Vec::new();
    for domain in CATALOG {
        for operation in domain.operations {
            let Some(params) = crate::tool_params::params_of(domain.name, operation.op) else {
                continue;
            };
            for param in params {
                if param.name != "path" {
                    continue;
                }
                let where_ = format!("{}.{}", domain.name, operation.op);
                if param.note.contains("`node`") {
                    noted.push(where_);
                } else {
                    bare.push(where_);
                }
            }
        }
    }
    assert_eq!(
        noted,
        vec!["godot_runtime.inspect_node".to_owned()],
        "`path` names a node in exactly one operation, and that one has to say so in the \
         description the model reads. Anything else here is a second exception nobody wrote down."
    );
    assert!(
        bare.len() > 20,
        "the other twenty-eight are files and say nothing, which is what makes the one worth \
         saying: {bare:?}"
    );
}

/// Every parameter the addon reads has to be named where the model reads about it, and every
/// parameter named there has to be one the addon reads.
///
/// The summaries are prose, and prose drifts. A live run spent turns on `Unknown key 'Return'`
/// and on `A value must be a tagged object with a type and a value`, both because a summary
/// left out what its handler required; a `limit?` was offered on two searches that cap
/// themselves and ignore it, and `runtime.inspect_node` was documented as `{path}` while a
/// request without `properties` answers with an empty property map. None of that is a fault in
/// the model — it is a fault in the sentence it was given. This reads both addon halves and
/// holds every sentence to its handler, so the next one cannot drift quietly.
///
/// Scope is the addon: what the operations answered in Rust take is checked by the request
/// types they deserialize into. That an operation has a handler at all is
/// `every_editor_operation_the_catalog_offers_has_an_addon_handler`.
#[test]
fn every_parameter_the_addon_reads_is_the_one_the_catalog_documents() {
    let reads = params_every_addon_command_reads();
    let mut undocumented = Vec::new();
    let mut unread = Vec::new();
    let mut checked = 0;
    for domain in CATALOG {
        for operation in domain.operations {
            let Some(command) = addon_command_behind(domain.name, operation.op) else {
                continue;
            };
            checked += 1;
            let read = reads.get(&command).unwrap_or_else(|| {
                panic!("{command} is routed to the addon but nothing here parsed its handler")
            });
            let documented = match crate::tool_params::params_of(domain.name, operation.op) {
                Some(params) => params
                    .iter()
                    .map(|param| param.name.to_owned())
                    .collect::<Vec<String>>(),
                None => documented_parameters(operation.summary),
            };
            for key in read {
                if !NOT_THE_MODEL_S_TO_PASS.contains(&key.as_str())
                    && !documented.iter().any(|named| named == key)
                {
                    undocumented.push(format!(
                        "{} {} reads `{key}` and its summary never names it",
                        domain.name, operation.op
                    ));
                }
            }
            for named in &documented {
                if !LIFTED_ONTO_THE_ENVELOPE.contains(&named.as_str()) && !read.contains(named) {
                    unread.push(format!(
                        "{} {} documents `{named}` and {command} never reads it",
                        domain.name, operation.op
                    ));
                }
            }
        }
    }
    assert!(
        undocumented.is_empty() && unread.is_empty(),
        "the catalog and the addon disagree:\n{}\n{}",
        undocumented.join("\n"),
        unread.join("\n")
    );
    assert!(
        checked > 50,
        "only {checked} addon operations were read, so this test proves little"
    );
}

/// `threadId` is on six debug operations and documented on none. GDScript runs one thread, the
/// adapter defaults to it, and a model told to pass a thread identifier would have to go and
/// find one before it could step.
const NOT_WORTH_THE_MODEL_S_ATTENTION: [&str; 1] = ["threadId"];

/// Both operations that take a key read it with the same vocabulary, and it is not empty.
///
/// Both decoders are `OS.find_keycode_from_string`, so a key the Input Map takes is a key the
/// running game takes. This used to compare two hand-written English sentences to each other,
/// through a parser that split them on the literal string "Accepted: ". There is one list now,
/// so what is left to check is that both operations point at it — and that the names it offers
/// and the names it says are refused do not overlap, because a list that did both would make
/// the acceptance suite assert two contradictory things about one key.
#[test]
fn both_operations_that_take_a_key_speak_the_same_vocabulary() {
    use crate::tool_params::{GODOT_KEY_NAME, GODOT_KEY_NAME_REFUSED, params_of};

    assert!(GODOT_KEY_NAME.contains(&"Enter") && GODOT_KEY_NAME_REFUSED.contains(&"Return"));
    for pair in [
        ("godot_project", "set_input_action"),
        ("godot_runtime", "input"),
    ] {
        let events = params_of(pair.0, pair.1)
            .unwrap_or_else(|| panic!("{}.{} declares its parameters", pair.0, pair.1))
            .iter()
            .find(|param| param.name == "events")
            .unwrap_or_else(|| panic!("{}.{} takes events", pair.0, pair.1));
        assert_eq!(
            events.vocabulary, GODOT_KEY_NAME,
            "{}.{} must read a key with the same vocabulary as the other",
            pair.0, pair.1
        );
    }
    for refused in GODOT_KEY_NAME_REFUSED {
        assert!(
            !GODOT_KEY_NAME.contains(refused),
            "{refused} is both offered and refused"
        );
    }
}

/// The fields the request behind one Rust-answered operation deserializes, and whether a call may
/// leave each one out.
///
/// Still a hand-written `(domain, op)` table, and deliberately so. ADR 0002 draws the line at
/// names: the catalogue generates which operations exist, and what shape each one carries is
/// written by hand next to the thing it describes. Which Rust type answers an operation is a
/// shape — it names a payload — so generating it out of `params.json` would be the fourth schema
/// that ADR refuses, and `params.json` cannot describe a Rust type any more than it can describe
/// a GDScript dictionary.
///
/// What changed is where the answer comes from. This used to hand back a *file* and an item name,
/// and the fields were recovered by parsing that file's source text. Each request now declares its
/// own fields beside itself — [`crate::script`], [`crate::debug`], [`crate::files`],
/// [`crate::gdformat`], [`crate::godot_session`] and [`crate::rag`] each next to their types — so
/// this is a lookup into a table rather than a parse of a file.
fn rust_request_behind(domain: &str, op: &str) -> Option<&'static [(&'static str, bool)]> {
    match (domain, op) {
        ("godot_session", "status" | "start" | "stop") => Some(&[]),
        ("godot_resource", "list") => Some(crate::files::LIST_PATHS_FIELDS),
        ("godot_resource", "move") => Some(crate::files::MOVE_PATH_FIELDS),
        ("godot_resource", "delete") => Some(crate::files::DELETE_PATH_FIELDS),
        ("godot_script", "list") => Some(crate::script::LIST_SCRIPTS_FIELDS),
        ("godot_script", "open" | "close") => Some(crate::script::OPEN_SCRIPT_FIELDS),
        ("godot_script", "update") => Some(crate::script::UPDATE_SCRIPT_FIELDS),
        ("godot_script", "save") => Some(crate::script::SAVE_SCRIPT_FIELDS),
        ("godot_script", "edit") => Some(crate::script::EDIT_SCRIPT_FIELDS),
        ("godot_script", "apply_rename") => Some(crate::script::APPLY_RENAME_FIELDS),
        ("godot_script", "format") => Some(crate::gdformat::FORMAT_REQUEST_FIELDS),
        ("godot_script", op) => crate::script::language_request_fields(op),
        ("godot_debug", op) => crate::debug::request_fields(op),
        ("godot_logs", "read") => Some(crate::godot_session::LOG_QUERY_FIELDS),
        ("godot_docs_search", "search" | "ask") => Some(crate::rag::DOCS_QUERY_FIELDS),
        _ => None,
    }
}

/// The same promise as the addon check, for the domains that never reach the editor.
///
/// `godot_session`, `godot_resource`, `godot_script`, `godot_debug`, `godot_logs` and
/// `godot_docs_search` are answered in Rust, so their parameters are the fields of a request type
/// rather than keys read out of a dictionary. A summary that names a field serde will not accept
/// is refused with `invalid_params` before anything runs, and one that leaves a field out is a
/// capability the model cannot reach — `runtime.inspect_node` was the second kind, and it answered
/// with an empty object for as long as nobody read the handler.
///
/// There is no floor under this one any more. A floor was what stood in for the parser that could
/// stop recognising its surface and compare nothing to nothing; every Rust-answered operation now
/// has to name a row here or the test panics on it, which is the same promise made exactly rather
/// than by counting.
#[test]
fn every_field_the_rust_handlers_deserialize_is_the_one_the_catalog_documents() {
    let mut disagreements = Vec::new();
    for domain in CATALOG {
        for operation in domain.operations {
            if operation.route() != crate::tool_params::Answers::Rust {
                continue;
            }
            let fields = rust_request_behind(domain.name, operation.op).unwrap_or_else(|| {
                panic!(
                    "{} {} is answered in Rust and nothing declares what it deserializes",
                    domain.name, operation.op
                )
            });
            let params =
                crate::tool_params::params_of(domain.name, operation.op).unwrap_or_else(|| {
                    panic!("{} {} declares its parameters", domain.name, operation.op)
                });
            let documented: Vec<&str> = params.iter().map(|param| param.name).collect();
            for (field, may_omit) in fields {
                if !NOT_WORTH_THE_MODEL_S_ATTENTION.contains(field) && !documented.contains(field) {
                    disagreements.push(format!(
                        "{} {} takes `{field}` and its summary never names it",
                        domain.name, operation.op
                    ));
                }
                let Some(declared) = params.iter().find(|param| param.name == *field) else {
                    continue;
                };
                if declared.required == *may_omit {
                    disagreements.push(format!(
                        "{} {} calls `{field}` {} and the request behind it treats it as {}",
                        domain.name,
                        operation.op,
                        if declared.required {
                            "required"
                        } else {
                            "optional"
                        },
                        if *may_omit { "optional" } else { "required" }
                    ));
                }
            }
            for named in &documented {
                if !fields.iter().any(|(field, _)| field == named) {
                    disagreements.push(format!(
                        "{} {} documents `{named}` and the request behind it has no such field",
                        domain.name, operation.op
                    ));
                }
            }
        }
    }
    assert!(
        disagreements.is_empty(),
        "the catalog and the request types disagree:\n{}",
        disagreements.join("\n")
    );
}

/// The keys of one GDScript `const NAME := {…}` dictionary, which is how the addon keeps the
/// vocabularies it accepts.
fn gd_dictionary_keys(source: &str, declaration: &str) -> BTreeSet<String> {
    let Some(body) = source
        .split_once(&format!("{declaration} := {{"))
        .and_then(|(_, rest)| rest.split_once("\n}"))
        .map(|(body, _)| body)
    else {
        panic!("{declaration} is a dictionary this test can read");
    };
    body.lines()
        .filter_map(|line| line.trim().strip_prefix('"'))
        .filter_map(|line| line.split('"').next())
        .map(str::to_owned)
        .collect()
}

/// The labels of the match inside one GDScript function — the kinds a decoder accepts, or the
/// tags the protocol decodes.
fn gd_match_labels(functions: &HashMap<&str, String>, name: &str) -> BTreeSet<String> {
    let body = functions
        .get(name)
        .unwrap_or_else(|| panic!("{name} is a function this test can read"));
    match_arms(body, "")
        .into_iter()
        .map(|(label, _)| label)
        .filter(|label| label != "_")
        .collect()
}

/// A vocabulary that is written down rather than read out of a file.
///
/// The Rust-answered ones are declared beside their own type — see
/// [`crate::godot_session::LOG_SEVERITY_NAMES`] — so all this does is put them in the same shape as
/// the six the addon's source still has to be parsed for.
fn declared_names(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

/// Every name a summary offers as a vocabulary has to be a name its handler accepts.
///
/// A parameter's *name* is now checked from both sides; what may go inside it is still prose.
/// The summaries spell out eleven vocabularies — the value tags, the event kinds, the mouse
/// buttons, the performance monitors, the collision shapes, the log severities and sources —
/// and every one of them is a table somewhere that can be read. A missing name is a capability
/// the model will never use because it was never told about it; the value tags had lost
/// `rect2i` that way.
///
/// One direction only. A name in the table has to be in the sentence; a word in the sentence is
/// prose and cannot be held to a table.
#[test]
fn every_name_a_vocabulary_holds_is_offered_by_the_summary_that_advertises_it() {
    let editor = editor_functions();
    let runtime = gd_functions(RUNTIME_ADDON);
    let protocol = gd_functions(include_str!("../addon/protocol.gd"));
    let vocabularies: [(&str, &str, &str, BTreeSet<String>); 8] = [
        (
            "godot_node",
            "set_property",
            "the tags Protocol.decode takes",
            gd_match_labels(&protocol, "decode"),
        ),
        (
            "godot_project",
            "set_input_action",
            "the event kinds the Input Map decoder takes",
            gd_match_labels(&editor, "decode_input_events"),
        ),
        (
            "godot_runtime",
            "input",
            "the event kinds the running game takes",
            gd_match_labels(&runtime, "_decode_runtime_events"),
        ),
        (
            "godot_runtime",
            "input",
            "the mouse buttons the running game names",
            gd_dictionary_keys(RUNTIME_ADDON, "const MOUSE_BUTTONS"),
        ),
        (
            "godot_runtime",
            "get_monitors",
            "the performance monitors",
            gd_dictionary_keys(RUNTIME_ADDON, "const MONITORS"),
        ),
        (
            "godot_resource",
            "create_shape",
            "the collision shapes",
            gd_dictionary_keys(EDITOR_ADDON, "const SHAPE_TYPES"),
        ),
        (
            "godot_logs",
            "read",
            "the log severities",
            declared_names(crate::godot_session::LOG_SEVERITY_NAMES),
        ),
        (
            "godot_logs",
            "read",
            "the log sources",
            declared_names(crate::godot_session::LOG_SOURCE_NAMES),
        ),
    ];
    let mut unoffered = Vec::new();
    for (tool, op, what, names) in vocabularies {
        assert!(
            names.len() > 1,
            "{what} came out empty, so this proves nothing"
        );
        let summary = summary_of(tool, op);
        let signature = crate::tool_params::params_of(tool, op)
            .map(crate::tool_params::signature)
            .unwrap_or_default();
        for name in names {
            if !summary.contains(&name) && !signature.contains(&name) {
                unoffered.push(format!("{tool} {op} never offers `{name}`, one of {what}"));
            }
        }
    }
    assert!(unoffered.is_empty(), "{}", unoffered.join("\n"));
}

/// A value the addon decodes has to be documented as the tagged object it decodes.
///
/// `Protocol.decode` takes `{type, value}` and refuses anything else with "A value must be a
/// tagged object with a type and a value". Two summaries offered a bare `value` and a live run
/// spent its calls being refused by that sentence — the tag is not a detail of the value, it is
/// the shape of the parameter, so a summary that names the parameter has to carry it.
#[test]
fn a_parameter_the_addon_decodes_is_documented_as_a_tagged_value() {
    let functions = editor_functions();
    let decoders: BTreeSet<String> = dispatch_pairs(EDITOR_ADDON, "return ")
        .into_iter()
        .filter(|(_, handler)| {
            let mut seen = BTreeSet::new();
            decodes_a_value(handler, &functions, &mut seen)
        })
        .map(|(command, _)| command)
        .collect();
    assert!(
        decoders.contains("project.set_setting") && decoders.contains("node.set_property"),
        "the decoders were not found at all, so this test proves nothing: {decoders:?}"
    );
    let mut silent = Vec::new();
    for domain in CATALOG {
        for operation in domain.operations {
            let Some(command) = addon_command_behind(domain.name, operation.op) else {
                continue;
            };
            if decoders.contains(&command) && !operation.summary.contains("tagged") {
                silent.push(format!(
                    "{} {} decodes a tagged value and its summary never says so",
                    domain.name, operation.op
                ));
            }
        }
    }
    assert!(silent.is_empty(), "{}", silent.join("\n"));
}

/// Whether a handler hands anything to the protocol decoder, following its helpers.
fn decodes_a_value(
    handler: &str,
    functions: &HashMap<&str, String>,
    seen: &mut BTreeSet<String>,
) -> bool {
    if !seen.insert(handler.to_owned()) {
        return false;
    }
    let Some(body) = functions.get(handler) else {
        return false;
    };
    if body.contains("Protocol.decode(") || body.contains("Protocol.decode_items(") {
        return true;
    }
    calls_taking_params(body, functions)
        .into_iter()
        .any(|(callee, _)| decodes_a_value(callee, functions, seen))
}

/// The catalog has to name an input event the way the addon reads one.
///
/// It documented `{"type": "key", "keycode": "A"}` while the addon reads `kind` and `key`, so a
/// model that believed its own tool description was answered "Input event kind '' is not
/// supported" and had to discover the real shape by reading an action back. Nothing else keeps
/// the sentence and the decoder together, because the sentence is prose.
#[test]
fn the_input_event_shape_the_catalog_documents_is_the_one_the_addon_reads() {
    const ADDON: &str = PARAMS_ADDON;
    let summary = CATALOG
        .iter()
        .find(|domain| domain.name == "godot_project")
        .and_then(|domain| {
            domain
                .operations
                .iter()
                .find(|operation| operation.op == "set_input_action")
        })
        .expect("godot_project set_input_action is in the catalog")
        .summary;
    for field in ["kind", "key"] {
        assert!(
            ADDON.contains(&format!("entry.get(\"{field}\"")),
            "the addon reads {field} from an input event"
        );
        assert!(
            summary.contains(&format!("\"{field}\"")),
            "set_input_action must document the {field} field the addon reads: {summary}"
        );
    }
    assert!(
        !summary.contains("keycode"),
        "the addon has no `keycode` field on an input event: {summary}"
    );

    let events = crate::tool_params::params_of("godot_project", "set_input_action")
        .expect("set_input_action declares its parameters")
        .iter()
        .find(|param| param.name == "events")
        .expect("set_input_action takes an events list");
    for field in events.entry {
        assert!(
            ADDON.contains(&format!("entry.get(\"{}\"", field.name)),
            "set_input_action declares an event field `{}` the addon never reads",
            field.name
        );
    }
}

/// Every mutation the addon guards with a revision has to say so where the model reads it.
///
/// Without this the catalog documented the parameter nowhere an operation names its arguments,
/// and a live agent spent a whole turn being refused with `revision_conflict` on every
/// authoring call it made. The list is the protocol's own, so an operation added to the
/// contract cannot reach the model without its revision documented.
#[test]
fn mutating_operations_document_the_revision_they_require() {
    let mutating = crate::protocol_v2::MUTATING_COMMANDS.map(|command| {
        let (domain, op) = command
            .split_once('.')
            .unwrap_or_else(|| panic!("{command} names a domain and an operation"));
        (format!("godot_{domain}"), op)
    });
    for (tool, op) in &mutating {
        let tool = tool.as_str();
        let op = *op;
        let domain = CATALOG
            .iter()
            .find(|domain| domain.name == tool)
            .unwrap_or_else(|| panic!("{tool} is in the catalog"));
        assert!(
            domain.operations.iter().any(|operation| operation.op == op),
            "{tool} {op} is in the catalog"
        );
        let params = crate::tool_params::params_of(tool, op)
            .unwrap_or_else(|| panic!("{tool} {op} declares its parameters"));
        let revision = params
            .iter()
            .find(|param| param.name == "expectedRevision")
            .unwrap_or_else(|| {
                panic!(
                    "{tool} {op} must declare expectedRevision: {}",
                    crate::tool_params::signature(params)
                )
            });
        assert!(
            revision.hidden && !revision.required,
            "{tool} {op} must hide expectedRevision rather than ask for it: {}",
            crate::tool_params::signature(params)
        );
    }
}

/// The one line the log summary promises is never about the project.
///
/// `is_the_editor_talking_to_itself` drops it from the errors a failed call carries, and
/// `godot_logs read` still answers with it because that page is raw. Thirteen recorded runs carry
/// it, forty-five times, and one spent 66 seconds and a sub-agent call working out what in the
/// project was calling `ConfigFile.get_value` — nothing was; it is the editor restoring its script
/// tabs. The summary now says so, and the two have to name the same line or the sentence is
/// pointing at nothing.
#[test]
fn the_line_the_editor_talks_to_itself_with_is_the_one_the_summary_names() {
    let summary = crate::tool_params::operation_of("godot_logs", "read")
        .expect("godot_logs read")
        .summary;
    for named in ["`state`", "script tabs", "editorError"] {
        assert!(
            summary.contains(named),
            "the summary must name {named}: {summary}"
        );
    }
    assert!(
        crate::godot_session::is_the_editor_talking_to_itself(
            "ERROR: Couldn't find the given section \"res://scripts/player.gd\" and key \"state\", \
             and no default was given."
        ),
        "the filter and the sentence have to be about one line"
    );
    assert!(
        !crate::godot_session::is_the_editor_talking_to_itself(
            "ERROR: Failed loading resource: res://scenes/level_one.tscn."
        ),
        "and a real project error is not it"
    );
}
