//! The agent's system prompt: the text Gofer ships, and the project's edit of it.
//!
//! The prompt used to be composed in the worker, out of a base the user could replace and a Godot
//! block they could not see. It is composed here now because the settings page shows the whole of
//! it: what the page holds is what the turn sends, and a project that stores its own text sends
//! exactly that text. The Godot half is still only added when the catalog offers those tools, so a
//! build without them never ships instructions for tools that are not there.
//!
//! The shape — one opening sentence, then labelled sections of short bullets — is pi's own system
//! prompt (`@earendil-works/pi-coding-agent`, `core/system-prompt.ts`), which is what these models
//! meet in the harness Gofer's worker is built from. It replaced paragraphs of prose that argued
//! for each rule. A bullet is scanned; a paragraph explaining why the rule is right is skimmed.

use crate::ai_tools::ToolDomain;

/// A prompt no larger than this. It is a ceiling on mistakes, not a budget: the shipped prompt is
/// around three kilobytes.
pub const MAX_PROMPT_BYTES: usize = 64 * 1024;

const BASE_PROMPT: &str = "You are Gofer, an expert coding agent operating inside a desktop workspace for Godot projects. You help the user by reading files, running commands, editing code, and driving a live Godot editor. Work autonomously toward their goal.

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
- A path written as @scripts/player.gd in the user's message is a file they picked out of this project: it is the path, and they are pointing at it, not quoting it
- Never claim an action succeeded unless a tool result says it did
- Send the subagent any question that spans more than one file, or that means finding a file you cannot name — it reads in isolation and answers in a paragraph, and what it reads never enters this conversation
- Ask it one self-contained question per call, naming the files and terms to start from; dispatch independent ones together
- It has read and bash only: anything that changes, you do yourself
- Search the web before answering anything about a library, framework, tool or service outside this project — its current version, its API, what it shipped recently — because your memory of those is a release or more out of date
- web_search returns links; web_fetch reads one of them and returns only the answer, so search first and fetch the result worth reading
- Fetch the page rather than guessing how something outside this project is configured or wired: a wrong setup detail costs far more to find later than the fetch costs now";

/// Added when the catalog offers the Godot domain tools. It carries only what the tool descriptions
/// cannot: that the two scene trees are different things, that the revision a mutation is checked
/// against is not the model's to carry, and that stopping is an event a caller has to wait for.
///
/// It opens with the pinned engine version and the date that release was published, because the
/// engine is the one thing here a model thinks it already knows. 4.7.2 is newer than the training
/// data of every model this ships against, and the failure that produces is not an error message —
/// it is a confident Godot 3 name, written into a script, found minutes later by a scene that will
/// not load. The date is what turns "search the docs" from advice into arithmetic the model can do.
const GODOT_PROMPT: &str = r#"Godot engine (a Gofer-managed editor, reached through the godot_* tools):
{engine}
- Search godot_docs_search before writing any Godot class, method, signal, property or constant, every time, including when the name feels obvious
- What Gofer already knows about this project — the editor session, anything it has learned before, the files it tracks — is written at the end of the message that started this turn; read it there rather than asking for any of it, and if the session says offline, start it with godot_session start before any other godot_ tool
- Every godot_ tool takes an ops list, so put everything you want from that tool now into one call: three inspections is one call of three entries, not three calls
- Each entry names its op with its parameters beside it, and the entries run in order; most ops may be repeated in one call, and the few that may not — along with the debugger's, which have to be the only entry of theirs — say so on their own line

Editing the project:
- Scenes and project.godot belong to the editor: change them with godot_scene, godot_node and godot_project, never by writing the file as text — the write, edit and bash tools refuse those paths
- GDScript belongs to the language server: the write and edit tools refuse a .gd, because a file written behind the server leaves Godot running the old code
{typing}- Never guess a script filename: godot_script list names every script in the project, and is the call to make before opening, reading or writing one whose path you were not given
- Every other file is yours to write
- Create a script with godot_script save, then godot_script diagnostics on the same path — a script that does not parse stops its scene from loading, and the language server is the only thing that says so immediately
- godot_script open, close and diagnostics each take a list of paths: after writing several scripts, name them all in one diagnostics call, not one call per script
- Change a script that exists with godot_script edit, which replaces exact text and answers with the diagnostics itself: read the file, then send every change to every file in one call, not one call per change
- Scene mutations are undoable until godot_scene save; the revision each one is checked against is supplied by the router, so never ask for it or pass it
- Build with godot_node create_nodes and set_properties: one call carrying every node, then one carrying every property, not one call per node — every call costs a whole request, and a batch is also one undo step
- The edited scene (godot_scene, godot_node) and the running game (godot_runtime) are separate: editing one never changes the other
- A property holding a resource takes {"type": "resource", "value": {"path": "res://..."}}; a bare string is refused
- A 2D collision shape has a tool: godot_resource create_shape writes it and imports it. Anything else small has none — write the .tres yourself, as `[gd_resource type="BoxMesh" format=3]`, a blank line, `[resource]`, then `size = Vector3(2, 2, 2)`
- Build a 2D level from tiles — godot_resource create_tileset, then godot_node set_cells on a TileMapLayer; a hundred ColorRects is not a level, and a TileSet written as text opens with no tiles in it
- Wire a scene with godot_node connect_signal and add_to_group, never with a connect call in _ready as well: the second connection errors every time the node loads
- Write and attach a script before connecting to it, because a connection names a method that has to exist; godot_node inspect reads groups, signals and connections

Running and debugging:
- After godot_debug launch, wait with await_stop before reading the stack
- Read godot_logs when something fails without explanation

Approvals:
- Deleting or moving a file, enabling a plugin, and writing a machine-wide editor setting ask the user first
- approval_denied means they said no: do not retry, ask what to do instead"#;

/// The prompt Gofer ships for this catalog.
pub fn default_prompt(tools: &[ToolDomain], strict_typing: bool) -> String {
    if tools.iter().any(|domain| domain.name.starts_with("godot_")) {
        let typing = if strict_typing {
            format!("{STRICT_TYPING_LINE}\n")
        } else {
            String::new()
        };
        let godot = GODOT_PROMPT
            .replace("{engine}", &engine_line())
            .replace("{typing}", &typing);
        return format!("{BASE_PROMPT}\n\n{godot}");
    }
    BASE_PROMPT.to_owned()
}

/// Added when the project enforces strict typing, which is the rule Gofer ships turned on.
///
/// With `debug/gdscript/warnings/untyped_declaration` at Error — which is what
/// [`crate::godot_policy`] sets — `var x = 1` is a parse error and the script does not load. The
/// model was never told. In one recorded project 400 of 601 Godot error events were exactly that,
/// across 27 of 79 runs, and a live turn wrote `const SPEED = 200.0` and
/// `func _physics_process(delta):` into a player script and reported zero diagnostics.
///
/// Measured before it was written, interleaved against a local Qwen3.6-27B in one process, scored
/// by whether every declaration in the script the model wrote carries a type: the shipped prompt
/// wrote fully typed GDScript 3 times in 10 and this one 9 times in 10. The failure it removes is
/// always the same line — `var visual = $PlayerVisual`, a node lookup bound to an untyped `var`.
const STRICT_TYPING_LINE: &str = "- This project treats GDScript warnings as errors, so untyped code does not parse: give every var, const, parameter and return an explicit type, and cast a Variant before you use it";

/// The one line of the prompt the user does not own: which engine this build is pinned to.
///
/// The prompt above interpolates this rather than repeating it, so the line the refresh has to
/// recognise and the line the prompt writes are the same string. Two copies of that shape is one
/// copy too many: the matcher would go on matching a line the prompt had stopped writing.
const ENGINE_LINE: &str =
    "- Version {version} {channel}, released {released} — newer than your training data";

/// How the line is recognised in text somebody has edited: its opening and its closing claim.
const ENGINE_LINE_START: &str = "- Version ";
const ENGINE_LINE_END: &str = "newer than your training data";

fn engine_line() -> String {
    ENGINE_LINE
        .replace("{version}", crate::godot_session::REQUIRED_ENGINE_VERSION)
        .replace("{channel}", crate::godot_session::REQUIRED_CHANNEL)
        .replace("{released}", crate::godot_session::REQUIRED_ENGINE_RELEASED)
}

/// Rewrites the pinned-engine line in a stored prompt to the engine this build actually runs.
///
/// `is_default` already refuses to store an unmodified prompt, so a project following the ship
/// never freezes. A project that edited one word froze the whole text — including the version and
/// the release date — and went on telling the model about an engine Gofer no longer launches. That
/// is the exact failure the line exists to prevent, so the line is not the user's to keep: they own
/// what they wrote, and the build owns which engine it is pinned to.
fn refresh_engine_line(prompt: &str) -> String {
    let current = engine_line();
    // Split on `\n` rather than `lines()`, and rejoin on `\n`, so a prompt written with CRLF keeps
    // its `\r` — `lines()` strips it and the rejoin would silently rewrite the whole file's endings.
    // The replacement keeps the matched line's own indentation for the same reason: what the user
    // wrote around this line is theirs, and only the claim itself is the build's.
    prompt
        .split('\n')
        .map(|line| {
            let carriage = line.ends_with('\r');
            let body = if carriage {
                &line[..line.len() - 1]
            } else {
                line
            };
            let trimmed = body.trim();
            if !trimmed.starts_with(ENGINE_LINE_START) || !trimmed.ends_with(ENGINE_LINE_END) {
                return line.to_owned();
            }
            let indent = &body[..body.len() - body.trim_start().len()];
            format!("{indent}{current}{}", if carriage { "\r" } else { "" })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// What a turn sends: the project's own prompt, or the shipped one when the project stored none.
pub fn resolve(stored: Option<&str>, tools: &[ToolDomain], strict_typing: bool) -> String {
    match stored {
        Some(prompt) if !prompt.trim().is_empty() => refresh_engine_line(prompt),
        _ => default_prompt(tools, strict_typing),
    }
}

/// Whether this text is the shipped prompt, and so nothing a project needs to store.
///
/// A project that stores the default text would freeze it: a later Gofer that teaches the agent
/// about a new tool would never reach that project. Storing nothing keeps it following the ship.
pub fn is_default(prompt: &str, tools: &[ToolDomain], strict_typing: bool) -> bool {
    prompt.trim() == default_prompt(tools, strict_typing).trim()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_tools::CATALOG;

    /// The regression: a customized prompt must not freeze the engine this build is pinned to.
    ///
    /// `is_default` stops an *unmodified* prompt from being stored, so a project following the ship
    /// keeps up. A project that edited one word stored the whole text — including the version and
    /// its release date — and went on telling the model about an engine Gofer no longer launches.
    /// The comment above the line calls that failure by name: a confident Godot 3 method, written
    /// into a script, found minutes later by a scene that will not load.
    #[test]
    fn a_customized_prompt_still_names_the_engine_this_build_pins() {
        let customized = concat!(
            "You are Gofer.\n",
            "- Version 4.6.0 stable, released 2025-01-01 — newer than your training data\n",
            "- My own rule, which is mine to keep\n"
        );

        let sent = resolve(Some(customized), CATALOG, true);

        assert!(
            sent.contains(crate::godot_session::REQUIRED_ENGINE_VERSION),
            "the pinned engine has to reach the model: {sent}"
        );
        assert!(
            sent.contains(crate::godot_session::REQUIRED_ENGINE_RELEASED),
            "and so does the release date the model does arithmetic on: {sent}"
        );
        assert!(
            !sent.contains("4.6.0"),
            "the frozen version is gone: {sent}"
        );
        // Everything the user actually wrote is theirs, and is untouched.
        assert!(sent.contains("You are Gofer."));
        assert!(sent.contains("- My own rule, which is mine to keep"));
        assert!(sent.ends_with('\n'), "the text's own shape survives");
    }

    /// A prompt with no engine line — a catalog without the Godot tools — is left exactly alone.
    #[test]
    fn a_prompt_that_names_no_engine_is_not_given_one() {
        let plain = "You are Gofer.\n- One rule.";
        assert_eq!(resolve(Some(plain), CATALOG, true), plain);
    }

    #[test]
    fn the_godot_half_is_added_only_when_those_tools_are_offered() {
        let shipped = default_prompt(CATALOG, true);
        assert!(shipped.starts_with("You are Gofer"));
        assert!(shipped.contains("godot_session start"));
        assert!(shipped.contains("godot_docs_search"));
        assert_eq!(default_prompt(&[], true), BASE_PROMPT);
        // The sub-agent is a Node tool, registered in `ai-provider.mjs` for every session and
        // absent from the Rust catalog. So its instructions belong to the base half: gated on the
        // Godot tools they would vanish from a build that has none, while the tool stayed.
        assert!(default_prompt(&[], true).contains("subagent"));
        // The same holds for the two web tools, which are also Node-side and also always present.
        assert!(default_prompt(&[], true).contains("web_search"));
        assert!(default_prompt(&[], true).contains("web_fetch"));
        // And the Godot half still sends engine questions to the local docs rather than the web:
        // the shipped 4.7 documentation is on this machine and the web is a worse answer for it.
        assert!(shipped.contains("godot_docs_search"));
    }

    /// The engine the prompt names is the engine the session refuses to start without. Read from
    /// the pin rather than typed, so a version bump cannot leave the agent being told the old one —
    /// and a placeholder left unreplaced is a prompt that says `{version}` to the model.
    #[test]
    fn the_prompt_names_the_pinned_engine_and_the_date_it_was_released() {
        let shipped = default_prompt(CATALOG, true);
        assert!(shipped.contains(&format!(
            "Version {} {}, released {}",
            crate::godot_session::REQUIRED_ENGINE_VERSION,
            crate::godot_session::REQUIRED_CHANNEL,
            crate::godot_session::REQUIRED_ENGINE_RELEASED,
        )));
        assert!(!shipped.contains("{version}"));
        assert!(!shipped.contains("{channel}"));
        assert!(!shipped.contains("{released}"));
        // The date is only useful with the instruction it exists for.
        assert!(shipped.contains("newer than your training data"));
    }

    /// The rule the model was never told about, and the only line of the prompt that depends on a
    /// setting.
    ///
    /// A project with the rule off is not told GDScript warnings are errors, because there they are
    /// not — and a placeholder left behind would say `{typing}` to the model, which is the failure
    /// the engine-line test guards against for the same reason.
    #[test]
    fn every_operation_the_prompt_names_is_one_the_catalogue_has() {
        let prompt = default_prompt(crate::ai_tools::CATALOG, true);
        let mut checked: Vec<String> = Vec::new();
        for domain in crate::ai_tools::CATALOG {
            let known: Vec<&str> = domain.operations.iter().map(|one| one.op).collect();
            for occurrence in prompt.match_indices(&format!("{} ", domain.name)) {
                let rest = &prompt[occurrence.0 + domain.name.len() + 1..];
                let word: String = rest
                    .chars()
                    .take_while(|one| one.is_ascii_lowercase() || *one == '_')
                    .collect();
                // Only a name that could not be an English word: two lowercase runs joined by an
                // underscore. `create_shape` and `set_cells` are unmistakable; `godot_logs when`
                // is prose and is not the business of this test.
                if !word.contains('_') || word.starts_with('_') || word.ends_with('_') {
                    continue;
                }
                checked.push(format!("{} {word}", domain.name));
                assert!(
                    known.contains(&word.as_str()),
                    "the prompt tells the model to use `{} {word}`, and {} has no such operation. \
                     Its operations are: {known:?}",
                    domain.name,
                    domain.name
                );
            }
        }
        // Named rather than counted, so a prompt edit that quietly stops naming any operation
        // fails here instead of leaving a test that asserts nothing.
        assert!(
            checked.len() >= 5,
            "this test only means something while the prompt names operations; it found {checked:?}"
        );
    }

    #[test]
    fn the_strict_typing_rule_is_in_the_prompt_only_where_it_is_enforced() {
        let enforced = default_prompt(CATALOG, true);
        let relaxed = default_prompt(CATALOG, false);
        assert!(
            enforced.contains("treats GDScript warnings as errors"),
            "{enforced}"
        );
        assert!(
            !relaxed.contains("treats GDScript warnings as errors"),
            "{relaxed}"
        );
        assert!(!enforced.contains("{typing}"));
        assert!(!relaxed.contains("{typing}"));

        // One line, and nothing else moved: the rest of the prompt is the same text either way.
        let without: Vec<&str> = enforced
            .lines()
            .filter(|line| !line.contains("treats GDScript warnings as errors"))
            .collect();
        assert_eq!(without, relaxed.lines().collect::<Vec<&str>>());

        // A build with no Godot tools ships neither the Godot block nor this line.
        assert!(!default_prompt(&[], true).contains("treats GDScript warnings as errors"));
    }

    #[test]
    fn a_stored_prompt_is_sent_whole_and_a_blank_one_is_not_stored_at_all() {
        assert_eq!(resolve(Some("Be brief."), CATALOG, true), "Be brief.");
        assert_eq!(
            resolve(Some("   "), CATALOG, true),
            default_prompt(CATALOG, true)
        );
        assert_eq!(resolve(None, CATALOG, true), default_prompt(CATALOG, true));
        assert!(is_default(
            &format!("\n{}\n", default_prompt(CATALOG, true)),
            CATALOG,
            true
        ));
        assert!(!is_default("Be brief.", CATALOG, true));
    }
}
