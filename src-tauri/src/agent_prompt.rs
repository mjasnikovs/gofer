//! The agent's system prompt: the text Gofer ships, and the project's edit of it.
//!
//! The prompt used to be composed in the worker, out of a base the user could replace and a Godot
//! block they could not see. It is composed here now because the settings page shows the whole of
//! it: what the page holds is what the turn sends, and a project that stores its own text sends
//! exactly that text. The Godot half is still only added when the catalog offers those tools, so a
//! build without them never ships instructions for tools that are not there.

use crate::ai_tools::ToolDomain;

/// A prompt no larger than this. It is a ceiling on mistakes, not a budget: the shipped prompt is
/// around three kilobytes.
pub const MAX_PROMPT_BYTES: usize = 64 * 1024;

const BASE_PROMPT: &str = "You are Gofer, a capable local coding agent. Work autonomously toward the user's goal.
You can inspect and modify files and run shell commands with the provided tools. Use tools when they help; never claim an action succeeded unless its result confirms it. Keep the user informed with a concise final response.";

/// Added when the catalog offers the Godot domain tools. It carries only what the tool descriptions
/// cannot: that the two scene trees are different things, that a mutation needs the revision the
/// last read reported, and that stopping is an event a caller has to wait for.
const GODOT_PROMPT: &str = r#"A Gofer-managed Godot editor is available through the godot_* tools. Start with godot_session status, and start the session if it is offline.
The edited scene (godot_scene, godot_node) and the running game (godot_runtime) are separate: editing one never changes the other. Scene mutations take expectedRevision from the last read that reported one, and are undoable in the editor until godot_scene save writes them.
Scenes and project.godot belong to the editor, which holds them open: build and change them with godot_scene, godot_node and godot_project, never by writing the file as text. The write and edit tools refuse those files for that reason, and so does a shell command that names one; scripts and every other file are yours to write.
A property that holds a resource — a CollisionShape2D's shape, a Sprite2D's texture — is set with {"type": "resource", "value": {"path": "res://..."}}, and a path written as a string is refused. Small resources have no tool of their own, so write those yourself as .tres files and point at them: a shape is `[gd_resource type="RectangleShape2D" format=3]`, a blank line, `[resource]`, then `size = Vector2(64, 16)`.
A 2D level is built out of tiles, not out of one node per block: godot_resource create_tileset cuts an image the project holds into a TileSet and says which tiles collide, and godot_node set_cells paints a TileMapLayer with it by the rectangle. Do it that way whenever the project has art to build from — a hundred ColorRects is not a level, and a TileSet written as text opens with no tiles in it.
A scene is wired with godot_node connect_signal and add_to_group, and the saved scene keeps both — that is where a Godot project puts its wiring, rather than in a `connect` call in _ready. Do not do both: a signal the scene already connects and the script connects again is an error every time the node loads, in the running game where nothing points at the cause. Write the script and attach it first, because a connection names a method that has to exist already. godot_node inspect reads a node's groups, the signals it can emit, and the connections it already has.
Write GDScript with godot_script save rather than the write tool: it tells the language server, and then godot_script diagnostics on that path says whether what you wrote parses. Do that for every .gd file you write or change. A script that does not parse stops the scene using it from loading and the game never starts, and the only thing that says so is an error in the log long after the fact — the language server says it immediately. It is also the difference between Godot 4 and the Godot 3 names a model tends to reach for: PackedVector2Array, not PoolVector2Array.
godot_docs_search is the Godot 4.7 documentation on this machine, and it is there to be used: search it before you reach for a class, method, signal or constant you are not certain of, rather than writing the name you half-remember. It answers with passages from a chapter, so a name it does not return is a name to check rather than to guess at, and one search costs far less than a script that does not parse.
After godot_debug launch, wait with await_stop before reading the stack, scopes, or variables. Read godot_logs when something fails without explanation.
A few operations ask the user first — deleting or moving a file, enabling a plugin, and writing a machine-wide editor setting. The call waits for their answer, and approval_denied means they said no: do not retry it, ask what to do instead."#;

/// The prompt Gofer ships for this catalog.
pub fn default_prompt(tools: &[ToolDomain]) -> String {
    if tools.iter().any(|domain| domain.name.starts_with("godot_")) {
        return format!("{BASE_PROMPT}\n\n{GODOT_PROMPT}");
    }
    BASE_PROMPT.to_owned()
}

/// What a turn sends: the project's own prompt, or the shipped one when the project stored none.
pub fn resolve(stored: Option<&str>, tools: &[ToolDomain]) -> String {
    match stored {
        Some(prompt) if !prompt.trim().is_empty() => prompt.to_owned(),
        _ => default_prompt(tools),
    }
}

/// Whether this text is the shipped prompt, and so nothing a project needs to store.
///
/// A project that stores the default text would freeze it: a later Gofer that teaches the agent
/// about a new tool would never reach that project. Storing nothing keeps it following the ship.
pub fn is_default(prompt: &str, tools: &[ToolDomain]) -> bool {
    prompt.trim() == default_prompt(tools).trim()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_tools::CATALOG;

    #[test]
    fn the_godot_half_is_added_only_when_those_tools_are_offered() {
        let shipped = default_prompt(CATALOG);
        assert!(shipped.starts_with("You are Gofer"));
        assert!(shipped.contains("godot_session status"));
        assert!(shipped.contains("godot_docs_search"));
        assert_eq!(default_prompt(&[]), BASE_PROMPT);
    }

    #[test]
    fn a_stored_prompt_is_sent_whole_and_a_blank_one_is_not_stored_at_all() {
        assert_eq!(resolve(Some("Be brief."), CATALOG), "Be brief.");
        assert_eq!(resolve(Some("   "), CATALOG), default_prompt(CATALOG));
        assert_eq!(resolve(None, CATALOG), default_prompt(CATALOG));
        assert!(is_default(
            &format!("\n{}\n", default_prompt(CATALOG)),
            CATALOG
        ));
        assert!(!is_default("Be brief.", CATALOG));
    }
}
