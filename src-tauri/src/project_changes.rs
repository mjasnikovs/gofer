//! Telling the window that a project value changed under a screen that may be showing it.
//!
//! The Ledger says so from its own write path, through [`ChangeNotifier`], so a writer that forgets
//! to announce cannot exist. One event names what changed, so a screen hears only its own value.

use crate::ask::MAIN_WINDOW;
use serde::Serialize;
use std::fmt;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Runtime};

pub const CHANGED_EVENT: &str = "project-changed";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectValue {
    Memories,
    Sketches,
    Changes,
    Board,
}

/// Where the Ledger reports a write a screen could be showing.
pub trait ChangeNotifier: Send + Sync {
    fn changed(&self, what: ProjectValue);
}

/// The notifier a storage handle carries: none for a handle no window reads.
#[derive(Clone, Default)]
pub struct Notifier(Option<Arc<dyn ChangeNotifier>>);

impl Notifier {
    pub fn to(port: Arc<dyn ChangeNotifier>) -> Self {
        Self(Some(port))
    }

    pub fn changed(&self, what: ProjectValue) {
        if let Some(port) = &self.0 {
            port.changed(what);
        }
    }
}

impl fmt::Debug for Notifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(if self.0.is_some() {
            "Notifier"
        } else {
            "Notifier(none)"
        })
    }
}

#[derive(Clone, Serialize)]
struct Changed {
    what: ProjectValue,
}

/// The window, as the production notifier.
pub(crate) struct WindowNotifier<R: Runtime>(pub(crate) AppHandle<R>);

impl<R: Runtime> ChangeNotifier for WindowNotifier<R> {
    fn changed(&self, what: ProjectValue) {
        let _ = self.0.emit_to(MAIN_WINDOW, CHANGED_EVENT, Changed { what });
    }
}

/// Every announcement, in order, for a test to read back.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct RecordingNotifier(std::sync::Mutex<Vec<ProjectValue>>);

#[cfg(test)]
impl RecordingNotifier {
    pub(crate) fn take(&self) -> Vec<ProjectValue> {
        std::mem::take(&mut *self.0.lock().expect("the recorder"))
    }
}

#[cfg(test)]
impl ChangeNotifier for RecordingNotifier {
    fn changed(&self, what: ProjectValue) {
        self.0.lock().expect("the recorder").push(what);
    }
}

#[cfg(test)]
mod tests {
    use super::{Changed, ProjectValue};

    #[test]
    fn names_the_value_the_way_the_window_spells_it() {
        let payload = serde_json::to_value(Changed {
            what: ProjectValue::Memories,
        })
        .expect("serialize");
        assert_eq!(payload, serde_json::json!({"what": "memories"}));
    }
}
