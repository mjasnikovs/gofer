//! The editor's output as the model reads it.
//!
//! One buffer holds everything two processes printed, and almost none of it is an answer to
//! anything. What reaches the model is what is left once the terminal colour, the editor's own
//! progress bar and the addon talking to itself are taken out, and it is paged rather than handed
//! over whole.
//!
//! [`crate::session_diagnosis`] reads the same buffer for a different question — why a call went
//! unanswered. This is the question the model asked out loud.

use crate::ai_tools::{ToolFailure, from_params, to_value};
use crate::godot_session::{self, LogQuery};
use crate::tool_params;
use serde_json::{Value, json};

/// Reads log lines until the caller's limit is filled with lines a model can read.
///
/// The page is filtered after the buffer applies the limit, so one page of two hundred can come
/// back as forty once the editor's own terminal output is out of it — and forty lines where two
/// hundred were asked for reads as "there is no more", which is the one thing it must not mean.
/// So the pages are read forward until the limit is met or the buffer runs out.
///
/// The cursor answered is the one that continues from the last line actually handed over, never
/// from a line read past it: `after` takes a sequence, and every entry carries its own.
pub(crate) fn logs_domain(params: Value) -> Result<Value, ToolFailure> {
    let mut query: LogQuery = from_params(with_declared_defaults(
        tool_params::GODOT_LOGS_OPERATIONS,
        "read",
        params,
    ))?;
    // `editor` is the editor process, both its streams; `editorError` is its stderr alone. Every
    // warning and error the engine prints is on stderr, and a live turn that asked for warnings on
    // `editor` three ways was answered three empty pages and reported none had happened.
    if query.source == Some(godot_session::LogSource::Editor) {
        query.source = None;
    }
    let wanted = query
        .limit
        .unwrap_or(godot_session::DEFAULT_LOG_PAGE)
        .clamp(1, godot_session::MAX_LOG_PAGE);
    query.limit = Some(godot_session::MAX_LOG_PAGE);
    let mut kept: Vec<Value> = Vec::new();
    let mut omitted = 0;
    let first = godot_session::read_logs(&query)?;
    let dropped = first.dropped;
    let mut cursor = first.cursor;
    let mut page = first;
    loop {
        let counted = page.entries.len();
        for entry in page.entries {
            if kept.len() >= wanted {
                break;
            }
            cursor = entry.sequence;
            match a_line_a_model_can_read(&entry) {
                Some(line) => kept.push(line),
                None => omitted += 1,
            }
        }
        if counted == 0 || kept.len() >= wanted {
            break;
        }
        query.after = Some(cursor);
        page = godot_session::read_logs(&query)?;
    }
    Ok(json!({
        "entries": kept,
        "cursor": cursor,
        "dropped": dropped,
        "terminalLinesOmitted": omitted,
    }))
}

/// The call with every parameter the catalogue defaults filled in, where the call named none.
///
/// The default is read off the generated row rather than written here, so the value the model is
/// shown in the schema and the value this router applies cannot become two different words. Every
/// non-flat failure of the surface measurement was `logs read` sent with no `minSeverity`.
fn with_declared_defaults(
    operations: &'static [tool_params::Operation],
    op: &str,
    params: Value,
) -> Value {
    let Some(operation) = operations.iter().find(|operation| operation.op == op) else {
        return params;
    };
    let mut params = params;
    let Some(object) = params.as_object_mut() else {
        return params;
    };
    for param in operation.params {
        let Some(default) = param.default else {
            continue;
        };
        if !object.contains_key(param.name) {
            object.insert(param.name.to_owned(), to_value(default));
        }
    }
    params
}

/// One line with the terminal's own control codes taken out of it.
///
/// The editor writes to a terminal and colours what it writes. `\u{1b}[90m\u{1b}[1mfirst_scan…`
/// is one line of Godot's import progress, and a third of that line is the escapes. Written
/// without the `regex` crate, which this binary does not carry: an escape here is always
/// `ESC [ … letter`, the CSI form, which is all a terminal colour is.
fn without_terminal_colour(line: &str) -> String {
    let mut plain = String::with_capacity(line.len());
    let mut rest = line.chars();
    while let Some(character) = rest.next() {
        if character != '\u{1b}' {
            plain.push(character);
            continue;
        }
        if rest.next() != Some('[') {
            continue;
        }
        for parameter in rest.by_ref() {
            if parameter.is_ascii_alphabetic() {
                break;
            }
        }
    }
    plain
}

/// Whether this line is the editor's own progress bar rather than anything about the project.
///
/// `EditorProgress` prints `[  16% ] first_scan_filesystem | Scanning file structure...` and
/// `[ DONE ] save` to standard output, and both are a terminal drawing itself. **159 of the 655 log
/// entries in the recorded corpus are these**, 22,653 characters of 102,196 — more than a fifth of
/// everything `godot_logs read` has ever handed a model. Nothing in one is actionable: an import
/// that fails prints an `ERROR`, and a save that worked is answered by the save.
fn is_the_editors_progress_bar(line: &str) -> bool {
    let Some(bracketed) = line.strip_prefix('[') else {
        return false;
    };
    let Some((inside, _)) = bracketed.split_once(']') else {
        return false;
    };
    if inside.chars().count() != 6 {
        return false;
    }
    let inside = inside.trim();
    inside == "DONE"
        || inside
            .strip_suffix('%')
            .is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
}

/// The log page, with what only a terminal can use taken out of it, and a count of what went.
///
/// Three things, measured over the 655 entries the recorded live runs read back: the escape codes
/// are 7.5% of them, the lines that are nothing but escape codes are 3.7%, and the editor's own
/// progress bar is 22%. Together they are a third of every character `godot_logs read` answers
/// with, and `godot_logs read` is 18% of everything the ten Godot tools answer — 15% once `read`
/// and `bash` are counted in too.
///
/// Counted rather than silently dropped, and only here: the renderer reads the same buffer through
/// [`godot_session::read_logs`] and shows the user their editor's output as their editor wrote it.
fn a_line_a_model_can_read(entry: &godot_session::LogEntry) -> Option<Value> {
    let message = without_terminal_colour(&entry.message);
    if message.trim().is_empty()
        || is_the_editors_progress_bar(message.trim())
        || is_gofers_own_addon_talking(message.trim())
    {
        return None;
    }
    Some(json!({
        "sequence": entry.sequence,
        "source": entry.source,
        "severity": entry.severity,
        "message": message,
        "timestamp": entry.timestamp,
    }))
}

/// A line Gofer's own addon put in the log, which is never about the model's game.
///
/// The headless editor cannot draw the thumbnail `EditorInterface.save_scene` asks for, and says
/// so as an engine error with a GDScript backtrace whose every frame is in `res://addons/gofer/`.
/// Two live turns read that as their game failing and spent a page of the log on it.
fn is_gofers_own_addon_talking(line: &str) -> bool {
    line.contains("(res://addons/gofer/")
        || line.contains("texture_2d_get") && line.contains("/dummy/")
        || line.starts_with("ERROR: Parameter \"t\" is null")
        // The header above every backtrace, the addon's included; a game's own frames follow
        // theirs and say where they are without it.
        || line == "GDScript backtrace (most recent call first):"
        // The editor's breakpoint store has no entry for a file until Gofer's first
        // set_breakpoints writes one, and says so as an error.
        || line.contains("Couldn't find the given section") && line.contains("key \"state\"")
}

/// The same question asked of a whole page, which is what the tests drive.
#[cfg(test)]
fn what_a_model_can_read(entries: Vec<godot_session::LogEntry>) -> (Vec<Value>, usize) {
    let mut kept = Vec::with_capacity(entries.len());
    let mut omitted = 0;
    for entry in entries {
        match a_line_a_model_can_read(&entry) {
            Some(line) => kept.push(line),
            None => omitted += 1,
        }
    }
    (kept, omitted)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The editor's terminal drawing itself is not something a model can read.
    ///
    /// Measured over the 655 log entries the recorded live runs read back: the escape codes are
    /// 7.5% of them, the lines that are nothing but escape codes are 3.7%, and the progress bar is
    /// 22%. The lines below are real ones out of `logs/oxloop`.
    #[test]
    fn the_editors_terminal_colour_and_progress_bar_do_not_reach_the_model() {
        let escape = char::from(27);
        let line = |sequence: u64, message: &str| godot_session::LogEntry {
            sequence,
            source: godot_session::LogSource::Editor,
            severity: godot_session::LogSeverity::Info,
            message: message.to_owned(),
            timestamp: 1_787_680_547_282,
        };
        let (kept, omitted) = what_a_model_can_read(vec![
            line(
                1,
                &format!(
                    "[  16% ] {escape}[90m{escape}[1mfirst_scan_filesystem{escape}[22m | Scanning \
                     file structure...{escape}[39m{escape}[0m"
                ),
            ),
            line(
                2,
                &format!("{escape}[92m[ DONE ]{escape}[39m {escape}[1msave{escape}[22m"),
            ),
            line(3, &format!("{escape}[0m")),
            line(4, ""),
            line(
                5,
                &format!("{escape}[1mSCRIPT ERROR:{escape}[0m Parse Error: Identifier not found"),
            ),
            line(6, "[player] hit right window edge after 580.1 px"),
            line(7, "[ 50% ] loading the level"),
        ]);

        assert_eq!(omitted, 4, "{kept:?}");
        assert_eq!(kept.len(), 3, "{kept:?}");
        assert_eq!(kept[2]["message"], "[ 50% ] loading the level");
        assert_eq!(
            kept[0]["message"],
            "SCRIPT ERROR: Parse Error: Identifier not found"
        );
        assert_eq!(
            kept[1]["message"],
            "[player] hit right window edge after 580.1 px"
        );
        assert_eq!(kept[0]["sequence"], json!(5));
    }
}
