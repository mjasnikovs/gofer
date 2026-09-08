//! Storing one thing the model decided is worth remembering.
//!
//! The memory it writes is a `candidate`, and retrieval reads `confirmed` and nothing else. So this
//! never changes what a later turn is told — the user does, by keeping it. That split is the whole
//! design: the model is the only thing present when something durable is established, and the user
//! is the only thing that can say it was worth keeping.
//!
//! Deliberately not a [`crate::ai_tools::CATALOG`] domain, for the reason
//! [`crate::ask::ASK_USER_TOOL`] gives at length: the catalogue is Godot domains with an addon
//! handler and a generated parameter contract, and this is a host operation.

use crate::ai_tools::ToolFailure;
use crate::storage::MEMORY_KINDS;
use serde_json::{Value, json};
use tauri::{AppHandle, Runtime};

/// Remembering something, by the name the worker sends it under.
pub const REMEMBER_TOOL: &str = "remember";

fn invalid(message: impl Into<String>) -> ToolFailure {
    ToolFailure::new("invalid_params", message)
}

/// Files one memory, or refuses in a sentence the model can act on.
pub(crate) fn remember<R: Runtime>(
    app: &AppHandle<R>,
    params: &Value,
) -> Result<Value, ToolFailure> {
    if params
        .get(crate::ai_tools::PROBE_KEY)
        .and_then(Value::as_bool)
        == Some(true)
    {
        return crate::ai_tools::probe(REMEMBER_TOOL);
    }
    let kind = params
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|named| MEMORY_KINDS.contains(named))
        .ok_or_else(|| {
            invalid(format!(
                "remember needs a `kind`, one of: {}.",
                MEMORY_KINDS.join(", ")
            ))
        })?;
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("remember needs `content`: the one thing worth remembering."))?;
    // The call this memory came from, so the chat can draw its card beside the call that made it
    // after the conversation is reloaded and the tool result is only text again.
    let call_id = params.get("callId").and_then(Value::as_str);

    let storage = crate::workspace::project_storage(app)
        .map_err(|failure| ToolFailure::new("memory_unavailable", failure.message))?;
    let task_id = storage.tasks().active().unwrap_or_default();
    let record =
        crate::project_memory::remember(&storage, task_id.as_deref(), kind, content, call_id)
            .map_err(invalid)?;
    Ok(json!({
        "memoryId": record.id,
        "stored": "The user has not kept it yet, so no later turn has been given it. Do not \
                   remember this again and do not ask them about it."
    }))
}

#[cfg(test)]
mod tests {
    use super::{REMEMBER_TOOL, remember};
    use crate::ai_tools::CATALOG;
    use serde_json::json;

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app")
    }

    #[test]
    fn remembering_is_not_a_catalog_domain() {
        assert!(
            !CATALOG.iter().any(|domain| domain.name == REMEMBER_TOOL),
            "remember must not be a catalog domain"
        );
        crate::ai_tools::probe(REMEMBER_TOOL).expect("remember answers its own probe");
    }

    #[test]
    fn a_memory_without_a_kind_the_store_knows_is_refused() {
        let app = mock_app();
        let failure = remember(app.handle(), &json!({"kind": "summary", "content": "x"}))
            .expect_err("summary is not a kind any more");
        assert_eq!(failure.code, "invalid_params");
        assert!(
            failure.message.contains("decision"),
            "the refusal names the kinds that do work: {}",
            failure.message
        );
    }

    #[test]
    fn a_memory_with_no_content_is_refused_before_the_store_is_reached() {
        let app = mock_app();
        let failure = remember(app.handle(), &json!({"kind": "fact"}))
            .expect_err("a memory needs something in it");
        assert_eq!(failure.code, "invalid_params");
    }

    #[test]
    fn a_probe_is_answered_without_storing_anything() {
        let app = mock_app();
        let answer = remember(app.handle(), &json!({"probe": true})).expect("a probe is answered");
        assert_eq!(answer["reachable"], json!(true));
    }
}
