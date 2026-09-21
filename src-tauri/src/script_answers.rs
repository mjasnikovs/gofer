//! A language-server answer as the model reads it.
//!
//! The editor's answer and the model's question are not the same shape. A completion list is 276
//! entries with a resolve blob on each, an empty hover is a `null` that says nothing about why,
//! and a file is a wall of text with no line to point at. Each of these is arithmetic over one
//! answer, and none of it is routing — it sat in `ai_tools.rs` because the `godot_script` arm did.

use crate::ai_tools::ToolFailure;
use serde_json::Value;

/// The model counts lines badly: a named breakpoint line went from 15/60 right to 60/60 once the
/// text carried its numbers (scripts/bench/lines-run.mjs), so a script reads the way the read
/// tool answers.
///
/// A blank line is its number alone. `45\t` reads as a line holding one tab, and the model quoted
/// that tab back in an anchor, which the file does not have.
pub(crate) fn numbered_lines(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    text.strip_suffix('\n')
        .unwrap_or(text)
        .split('\n')
        .enumerate()
        .map(|(index, line)| {
            if line.trim().is_empty() {
                (index + 1).to_string()
            } else {
                format!("{}\t{line}", index + 1)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// How much script text one `open` call answers with before it starts withholding.
///
/// The worker holds a tool result at 24,000 characters and slices it there, mid-file. Ten of
/// thirty-two `open` calls in a live project hit that, and the file cut in half was the last one
/// named — after which an `edit` anchored on text the model had been shown only part of failed with
/// `anchor_not_found`. A budget answers instead with whole files and a note about the rest, which
/// is a thing the model can act on.
pub(crate) const OPEN_TEXT_BUDGET: usize = 16_000;

/// Whether this file's text is the one an `open` call stops carrying.
///
/// The first file is answered however large it is. A budget that could withhold everything would
/// turn `open scripts/main.gd` — one file, larger than the budget on its own — into a call that
/// says only how big it is, and there is no smaller call to fall back to. Truncation is the worse
/// failure of the two, but it is only worse when the model has somewhere else to go.
pub(crate) fn withholds_the_text(spent: usize, text_bytes: usize, first: bool) -> bool {
    !first && spent + text_bytes > OPEN_TEXT_BUDGET
}

/// Names the operation that needs no anchors, when an edit call arrives in a shape it cannot use.
///
/// `godot_script edit` carries the largest nested payload of any operation — a list of files, each
/// holding a list of before-and-after strings that are whole functions — and it is where this
/// model's JSON tears most often. `files[0] requires path` is the second commonest refusal in every
/// recorded live turn: nine of them across five turns, three of those inside one call sequence.
///
/// It is not a misunderstanding of the shape. Asked directly, twelve seeds out of twelve wrote
/// `files[{path, edits}]` correctly. The turn that met it three times said so itself, in the middle
/// of the run:
///
/// > The JSON structure is getting mangled. Let me just save the whole file:
///
/// — and `godot_script save`, which takes one path and one string, worked immediately. So there is
/// nothing here to repair: the intended text never reaches the wire, and a router that guessed a
/// path would be writing a guess into somebody's script. What can be done is name the way out that
/// this run took four calls to find on its own.
pub(crate) fn the_whole_file(tool: &str, op: &str, failure: ToolFailure) -> ToolFailure {
    let shape = matches!(
        failure.code.as_str(),
        "missing_param" | "unknown_param" | "invalid_param"
    );
    if !shape || tool != "godot_script" || op != "edit" {
        return failure;
    }
    let mut failure = failure;
    failure.message = format!(
        "{} If this call keeps arriving in a shape it cannot use, script.save writes the \
         whole file as one string and needs no anchors at all.",
        failure.message.trim_end()
    );
    failure
}

/// Whether a position-taking answer came back empty: no hover, no location, no highlight.
pub(crate) fn answer_names_nothing(op: &str, answered: &Value) -> bool {
    match op {
        "hover" => answered.get("hover").is_none_or(|hover| {
            hover.is_null() || hover["contents"].as_array().is_some_and(Vec::is_empty)
        }),
        "definition" | "declaration" | "references" => {
            answered["locations"].as_array().is_some_and(Vec::is_empty)
        }
        "highlights" => answered["highlights"].as_array().is_some_and(Vec::is_empty),
        _ => false,
    }
}

/// An empty answer with a sentence about the position that earned it.
///
/// Four hovers on a blank line, two declarations on a `(` and a space, five rename probes: every
/// one answered nothing and said nothing, and the model guessed the next column. The names on
/// the line and where each starts is what lets it aim once.
pub(crate) fn with_where_the_cursor_was(
    mut answered: Value,
    asked: &Value,
    text_of: impl Fn(&str) -> Option<String>,
) -> Value {
    let Some(path) = asked["path"].as_str() else {
        return answered;
    };
    let (Some(line), Some(character)) = (
        asked["position"]["line"].as_u64(),
        asked["position"]["character"].as_u64(),
    ) else {
        return answered;
    };
    let Some(text) = text_of(path) else {
        return answered;
    };
    let note = where_the_cursor_is(&text, line, character);
    if let Some(fields) = answered.as_object_mut() {
        fields.insert("note".to_owned(), Value::String(note));
    }
    answered
}

/// Godot's server answers a rename check with the range and no placeholder; one live turn in
/// three then invented one. The text inside the range is the placeholder, and it is read here.
pub(crate) fn with_the_placeholder_the_range_holds(
    mut answered: Value,
    asked: &Value,
    text_of: impl Fn(&str) -> Option<String>,
) -> Value {
    if answered["renameable"] != true || answered.get("placeholder").is_some() {
        return answered;
    }
    let (Some(line), Some(from), Some(to)) = (
        answered["range"]["start"]["line"].as_u64(),
        answered["range"]["start"]["character"].as_u64(),
        answered["range"]["end"]["character"].as_u64(),
    ) else {
        return answered;
    };
    if answered["range"]["end"]["line"].as_u64() != Some(line) {
        return answered;
    }
    let Some(text) = asked["path"].as_str().and_then(&text_of) else {
        return answered;
    };
    let Some(row) = usize::try_from(line)
        .ok()
        .and_then(|index| text.lines().nth(index))
    else {
        return answered;
    };
    let held: String = row
        .chars()
        .skip(usize::try_from(from).unwrap_or(usize::MAX))
        .take(usize::try_from(to.saturating_sub(from)).unwrap_or(0))
        .collect();
    if let Some(fields) = answered.as_object_mut()
        && !held.is_empty()
    {
        fields.insert("placeholder".to_owned(), Value::String(held));
    }
    answered
}

fn where_the_cursor_is(text: &str, line: u64, character: u64) -> String {
    let Some(row) = usize::try_from(line)
        .ok()
        .and_then(|index| text.lines().nth(index))
    else {
        return format!(
            "Line {line} (0-based) is past the end of the file, which has {} lines.",
            text.lines().count()
        );
    };
    let names: Vec<(usize, &str)> = identifiers_on(row);
    let under = row
        .chars()
        .nth(usize::try_from(character).unwrap_or(usize::MAX))
        .map_or_else(
            || "past the end of the line".to_owned(),
            |found| {
                names
                    .iter()
                    .find(|(start, name)| {
                        let column = usize::try_from(character).unwrap_or(usize::MAX);
                        column >= *start && column < start + name.len()
                    })
                    .map_or_else(
                        || format!("'{found}', which is not part of a name"),
                        |(_, name)| format!("inside `{name}`"),
                    )
            },
        );
    let where_names_start = if names.is_empty() {
        "no names on that line".to_owned()
    } else {
        format!(
            "the names on that line start at {}",
            names
                .iter()
                .map(|(start, name)| format!("{name} {start}"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    format!(
        "Line {line} char {character} (0-based) is {under}; {where_names_start}. Positions count \
         from 0, one less than the numbers script.open shows."
    )
}

/// Every identifier on one line with the 0-based column it starts at.
fn identifiers_on(row: &str) -> Vec<(usize, &str)> {
    let mut found = Vec::new();
    let mut start = None;
    for (index, ch) in row.char_indices() {
        let continues = ch.is_alphanumeric() || ch == '_';
        match (start, continues) {
            (None, true) if !ch.is_ascii_digit() => start = Some(index),
            (Some(from), false) => {
                found.push((from, &row[from..index]));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(from) = start {
        found.push((from, &row[from..]));
    }
    found
}

/// Completion items as the model can use them: members first, and no `data`.
///
/// After `timer.` the server answered 276 items, every one carrying a `data` blob that repeats the
/// request it came from, and the enum types and `NOTIFICATION_*` constants sorted first. The
/// result budget cut the list at 88, before `wait_time`, `start` or `timeout` — the only items the
/// question was about. `data` is what `completionItem/resolve` needs, and Monaco keeps it on its
/// own path; the model never resolves. Methods, fields, properties, variables and events come
/// first, in the server's order within each half.
pub(crate) fn a_completion_the_model_can_read(mut answered: Value) -> Value {
    const MEMBER_KINDS: [u64; 6] = [2, 3, 5, 6, 10, 23];
    let Some(items) = answered.get_mut("items").and_then(Value::as_array_mut) else {
        return answered;
    };
    for item in items.iter_mut() {
        if let Some(fields) = item.as_object_mut() {
            fields.remove("data");
            fields.remove("sortText");
            fields.remove("filterText");
        }
    }
    items.sort_by_key(|item| {
        let kind = item.get("kind").and_then(Value::as_u64).unwrap_or(0);
        u8::from(!MEMBER_KINDS.contains(&kind))
    });
    answered
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_listing_numbers_every_line_and_not_the_newline_after_the_last() {
        assert_eq!(super::numbered_lines(""), "");
        assert_eq!(super::numbered_lines("a\n\nb\n"), "1\ta\n2\n3\tb");
        assert_eq!(super::numbered_lines("a\n\t\nb"), "1\ta\n2\n3\tb");
        assert_eq!(super::numbered_lines("a\r\nb"), "1\ta\r\n2\tb");
    }

    /// A batched `open` answers with whole files and a note, never with one cut in half.
    ///
    /// The worker slices a tool result at 24,000 characters. Ten of thirty-two `open` calls in a
    /// live project reached that, always in the last file named, and an `edit` anchored on the text
    /// the model had been shown half of then failed with `anchor_not_found`.
    #[test]
    fn a_batched_open_stops_carrying_text_before_the_worker_cuts_it() {
        assert!(!withholds_the_text(0, OPEN_TEXT_BUDGET * 4, true));

        assert!(!withholds_the_text(OPEN_TEXT_BUDGET - 1, 1, false));
        assert!(withholds_the_text(OPEN_TEXT_BUDGET - 1, 2, false));

        assert!(!withholds_the_text(0, 22_752, true));
        assert!(withholds_the_text(22_752, 6_671, false));

        const { assert!(OPEN_TEXT_BUDGET < 24_000) };
    }

    #[test]
    fn members_come_first_and_the_resolve_blob_is_dropped() {
        let trimmed = a_completion_the_model_can_read(json!({
            "op": "completion",
            "isIncomplete": false,
            "items": [
                {"label": "ConnectFlags", "kind": 13, "data": {"position": 1}, "sortText": "a"},
                {"label": "NOTIFICATION_READY", "kind": 21, "data": {"position": 1}},
                {"label": "wait_time", "kind": 10, "data": {"position": 1}, "insertText": "wait_time"},
                {"label": "start", "kind": 2, "data": {"position": 1}},
                {"label": "timeout", "kind": 23, "data": {"position": 1}}
            ]
        }));
        let labels: Vec<&str> = trimmed["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|item| item["label"].as_str().expect("label"))
            .collect();
        assert_eq!(
            labels,
            [
                "wait_time",
                "start",
                "timeout",
                "ConnectFlags",
                "NOTIFICATION_READY"
            ]
        );
        assert!(
            trimmed["items"]
                .as_array()
                .expect("items")
                .iter()
                .all(|item| item.get("data").is_none() && item.get("sortText").is_none()),
            "{trimmed}"
        );
        assert_eq!(trimmed["items"][0]["insertText"], "wait_time");
        assert_eq!(
            a_completion_the_model_can_read(json!({"op": "hover"})),
            json!({"op": "hover"}),
            "an answer without items is left alone"
        );
    }

    #[test]
    fn an_empty_answer_says_what_was_under_the_cursor_and_where_the_names_start() {
        let text = "extends Node2D\n\n\tprint(\"%s %d\" % [TICK_MESSAGE, ticks])\n";
        let asked = json!({"path": "scripts/main.gd", "position": {"line": 2, "character": 6}});
        let noted =
            with_where_the_cursor_was(json!({"op": "locations", "locations": []}), &asked, |_| {
                Some(text.to_owned())
            });
        let note = noted["note"].as_str().expect("a note");
        assert!(note.starts_with("Line 2 char 6 (0-based) is '(', which is not part of a name; the names on that line start at print 1, s 9, d 12, TICK_MESSAGE 18, ticks 32"), "{note}");

        let inside = with_where_the_cursor_was(
            json!({"op": "locations", "locations": []}),
            &json!({"path": "scripts/main.gd", "position": {"line": 2, "character": 20}}),
            |_| Some(text.to_owned()),
        );
        assert!(
            inside["note"]
                .as_str()
                .expect("a note")
                .contains("is inside `TICK_MESSAGE`"),
            "{inside}"
        );

        let beyond = with_where_the_cursor_was(
            json!({"op": "hover", "hover": null}),
            &json!({"path": "scripts/main.gd", "position": {"line": 9, "character": 0}}),
            |_| Some(text.to_owned()),
        );
        assert!(
            beyond["note"]
                .as_str()
                .expect("a note")
                .contains("past the end of the file, which has 3 lines"),
            "{beyond}"
        );

        let unread =
            with_where_the_cursor_was(json!({"op": "hover", "hover": null}), &asked, |_| None);
        assert!(unread.get("note").is_none(), "no text, no note: {unread}");

        assert!(answer_names_nothing(
            "hover",
            &json!({"hover": {"contents": []}})
        ));
        assert!(answer_names_nothing("hover", &json!({"hover": null})));
        assert!(!answer_names_nothing(
            "hover",
            &json!({"hover": {"contents": {"kind": "markdown", "value": "x"}}})
        ));
        assert!(answer_names_nothing(
            "declaration",
            &json!({"locations": []})
        ));
        assert!(!answer_names_nothing(
            "references",
            &json!({"locations": [{"path": "a"}]})
        ));
        assert!(!answer_names_nothing("completion", &json!({"items": []})));
    }

    #[test]
    fn a_rename_check_without_a_placeholder_reads_it_off_the_range() {
        let text = "extends Node2D\n\nvar total_ticks := 0\n";
        let asked = json!({"path": "scripts/main.gd", "position": {"line": 2, "character": 6}});
        let filled = with_the_placeholder_the_range_holds(
            json!({"op": "prepareRename", "renameable": true,
                "range": {"start": {"line": 2, "character": 4}, "end": {"line": 2, "character": 15}}}),
            &asked,
            |_| Some(text.to_owned()),
        );
        assert_eq!(filled["placeholder"], "total_ticks", "{filled}");
        let refused = with_the_placeholder_the_range_holds(
            json!({"op": "prepareRename", "renameable": false}),
            &asked,
            |_| Some(text.to_owned()),
        );
        assert!(refused.get("placeholder").is_none(), "{refused}");
        let kept = with_the_placeholder_the_range_holds(
            json!({"op": "prepareRename", "renameable": true, "placeholder": "given",
                "range": {"start": {"line": 2, "character": 4}, "end": {"line": 2, "character": 15}}}),
            &asked,
            |_| Some(text.to_owned()),
        );
        assert_eq!(
            kept["placeholder"], "given",
            "the server's own placeholder wins"
        );
    }
}
