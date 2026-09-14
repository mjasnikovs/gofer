//! An agent probing `gofer --help` has to get text back, not a second window on its directory.

const HELP: &str = "\
An AI agent workspace for Godot.

Usage: gofer

Opens the window on the project in the current directory, or in GOFER_WORKSPACE_DIR.
There are no subcommands. Other agents reach the project board over MCP.
Its address and the `claude mcp add` line are in Settings, Other agents.

Options:
  -h, --help     Print this and exit
  -V, --version  Print the version and exit";

/// The text the arguments ask for instead of the window, if they ask for any.
pub(crate) fn answer<I: IntoIterator<Item = String>>(arguments: I) -> Option<String> {
    let version = concat!("gofer ", env!("CARGO_PKG_VERSION"));
    arguments
        .into_iter()
        .find_map(|argument| match argument.as_str() {
            "-h" | "--help" => Some(format!("{version}\n{HELP}")),
            "-V" | "--version" => Some(version.to_string()),
            _ => None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer_to(arguments: &[&str]) -> Option<String> {
        answer(arguments.iter().map(|argument| argument.to_string()))
    }

    #[test]
    fn help_and_version_answer_in_text() {
        for flag in ["-h", "--help"] {
            let help = answer_to(&[flag]).expect("help is answered");
            assert!(help.contains("Usage: gofer"), "{help}");
            assert!(help.contains("Settings, Other agents"), "{help}");
        }
        for flag in ["-V", "--version"] {
            assert_eq!(
                answer_to(&[flag]).as_deref(),
                Some(concat!("gofer ", env!("CARGO_PKG_VERSION")))
            );
        }
    }

    #[test]
    fn anything_else_opens_the_window() {
        assert_eq!(answer_to(&[]), None);
        assert_eq!(answer_to(&["card", "create"]), None);
    }
}
