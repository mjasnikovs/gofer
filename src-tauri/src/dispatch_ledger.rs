//! The ledger of operations a real editor answered, kept only while the acceptance suite or a
//! live turn runs.
//!
//! The catalogue promises the model an operation, and only a run proves it still answers. The
//! suite is one process per test with several in flight, so each write opens the file, appends one
//! line and closes it: an `O_APPEND` write lands whole for a line under `PIPE_BUF`, so parallel
//! processes interleave lines instead of clobbering each other. A line holding a script's whole
//! text can be longer than that, and the live turn is one process, which is the only reader that
//! asks for the parameters.
//!
//! A module rather than a hundred and fifty lines of suite scaffolding between `run_in_order` and
//! `run_one`, which is where it sat.
#![cfg(all(test, feature = "godot-acceptance"))]

use crate::ai_tools::ToolFailure;
use serde_json::{Value, json};
use std::io::Write;

/// Where `scripts/godot-acceptance.mjs` and `scripts/live-turn.mjs` want the ledger. Unset
/// everywhere else, and then nothing is written.
pub(crate) const LEDGER: &str = "GOFER_DISPATCH_LEDGER";

/// One dispatched operation as a JSON line: `op` spelled the way
/// `protocol/schemas/v2/godot-tool.json` spells it, which is what the complement is computed
/// against; `code` and `message` of the failure, or null; the milliseconds it took; and the
/// parameters the router handed the handler.
pub(crate) fn line(
    domain: &str,
    op: &str,
    params: &Value,
    answered: &Result<Value, ToolFailure>,
    ms: u128,
) -> String {
    let failure = answered.as_ref().err();
    let mut line = json!({
        "op": format!("{}.{op}", domain.strip_prefix("godot_").unwrap_or(domain)),
        "code": failure.map(|f| f.code.clone()),
        "message": failure.map(|f| f.message.clone()),
        "ms": ms,
        "params": params,
    })
    .to_string();
    line.push('\n');
    line
}

pub(crate) fn record(
    domain: &str,
    op: &str,
    params: &Value,
    answered: &Result<Value, ToolFailure>,
    ms: u128,
) {
    let Ok(path) = std::env::var(LEDGER) else {
        return;
    };
    let Ok(mut ledger) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    let _ = ledger.write_all(line(domain, op, params, answered, ms).as_bytes());
}

/// Named for the runner: `scripts/godot-acceptance.mjs` selects by `acceptance` in the test's
/// path, so a module called `tests` here is a test that silently stops running.
mod acceptance {
    use super::LEDGER;
    use crate::ai_tools::{ToolDomain, ToolFailure, record_dispatched};
    use crate::tool_params;

    use super::*;

    /// The runner reads what this writes, so the line format is a contract between two files.
    #[test]
    fn the_hook_appends_one_json_line_per_dispatched_operation() {
        let directory = tempfile::tempdir().expect("a directory for the ledger");
        let ledger = directory.path().join("dispatch-ledger.jsonl");
        let held = std::env::var(LEDGER).ok();
        // SAFETY: the acceptance runner gives each test its own process.
        unsafe { std::env::set_var(LEDGER, &ledger) };

        let started = std::time::Instant::now();
        record_dispatched(
            &ToolDomain {
                name: "godot_scene",
                operations: &[],
            },
            tool_params::operation_of("godot_scene", "open")
                .expect("scene.open is a catalogue row"),
            &json!({"path": "res://scenes/main.tscn"}),
            &Ok(json!({"opened": true})),
            started,
        );
        record_dispatched(
            &ToolDomain {
                name: "godot_docs_search",
                operations: &[],
            },
            tool_params::operation_of("godot_docs_search", "ask")
                .expect("docs_search.ask is a catalogue row"),
            &json!({"question": "what is a Timer"}),
            &Err(ToolFailure::new("docs_unavailable", "no index")),
            started,
        );

        // SAFETY: as above.
        match held {
            Some(path) => unsafe { std::env::set_var(LEDGER, path) },
            None => unsafe { std::env::remove_var(LEDGER) },
        }
        let lines: Vec<Value> = std::fs::read_to_string(&ledger)
            .expect("the ledger the hook opened")
            .lines()
            .map(|line| serde_json::from_str(line).expect("a JSON line"))
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["op"], "scene.open");
        assert_eq!(lines[0]["code"], Value::Null);
        assert_eq!(lines[0]["params"]["path"], "res://scenes/main.tscn");
        assert_eq!(lines[1]["op"], "docs_search.ask");
        assert_eq!(lines[1]["code"], "docs_unavailable");
        assert_eq!(lines[1]["message"], "no index");
        assert!(lines[1]["ms"].is_u64());
    }
}
