//! What the tool catalog claims about the engine, checked against the engine.
//!
//! Everything else in the suite holds Gofer to Gofer: the catalog to the addon, the addon to its
//! read-backs, a command to its handler. Those are ours, and they change when we change them. The
//! claims here are not ours. `key` names are resolved by `OS.find_keycode_from_string` out of a
//! table that belongs to Godot, and the catalog prints that table to the model as prose — so a
//! sentence that is true today is true until the engine says otherwise, and nothing in this
//! repository would notice the day it does.
//!
//! That is why this is its own gate rather than another acceptance test. Nothing in here can fail
//! because of a commit; it fails because the pinned version in `protocol/godot-artifacts.json`
//! moved. Run it when that pin moves:
//!
//! ```text
//! npm run test:godot:api
//! ```
//!
//! A failure is not a bug to fix in the addon. It is the engine having renamed something the model
//! is being told to send, and the fix is the sentence in `CATALOG`.

use crate::godot_editor_harness::Session;
use crate::tool_params::{GODOT_KEY_NAME, GODOT_KEY_NAME_REFUSED};
use serde_json::json;

/// Every key name the catalog advertises, against the engine that has to know it.
///
/// The catalog is the only place the model is told how to name a key, and it named one the way a
/// browser does — `Return`, which Godot calls `Enter`. The engine refused it, the model had no way
/// to learn what would be accepted, and the turn was spent guessing. The round-trip matters as much
/// as the acceptance: a name the engine resolves but reports back differently would leave
/// `list_input_actions` disagreeing with the sentence that produced it, which is the same trap one
/// step later.
///
/// Both lists are the vocabulary the signature is generated from, so this cannot drift from what
/// the model reads. They used to be parsed back out of the English of a catalogue summary.
#[test]
fn every_key_name_the_catalog_advertises_is_one_the_engine_knows() {
    let (accepted, refused) = (GODOT_KEY_NAME, GODOT_KEY_NAME_REFUSED);
    let session = Session::start();
    for key in accepted {
        let written = session.call(
            "project.set_input_action",
            json!({"name": "drift_keys", "events": [{"kind": "key", "key": key}]}),
        );
        assert_eq!(
            written["events"],
            json!([{"kind": "key", "key": key}]),
            "the catalog offers `{key}`, and this engine answers with something else"
        );
    }
    for key in refused {
        let failure = session.error(
            "project.set_input_action",
            json!({"name": "drift_keys", "events": [{"kind": "key", "key": key}]}),
            None,
        );
        assert!(
            failure.starts_with("unsupported_value"),
            "the catalog says `{key}` is refused, and this engine took it: {failure}"
        );
    }
}
