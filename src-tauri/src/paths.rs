//! One canonicalization rule for every path Gofer hands to another program.
//!
//! `std::fs::canonicalize` returns a Windows extended-length path — `\\?\C:\users\…` — and the
//! programs this application drives do not accept one. `SetCurrentDirectory` rejects the verbatim
//! prefix, so `Command::current_dir` on a canonical path cannot start Git at all; Git for Windows
//! resolves paths through MSYS and reads `\\?\C:\…` as a relative name; and Godot simplifies
//! `--path` before opening the project. A canonical worktree therefore has to be spelled the plain
//! way on Windows, which is what `dunce` does: it strips the prefix whenever the plain spelling
//! addresses the same file, and keeps it only for the paths that genuinely need it (past
//! `MAX_PATH`, or a reserved device name). On every other platform it is `fs::canonicalize`.
//!
//! Because that fallback exists, a canonical root and a canonical path inside it can disagree
//! about the prefix — a short root and a long child. Comparisons therefore run through
//! [`simplified`], which drops the prefix from both sides without touching the filesystem, rather
//! than comparing two spellings of one directory.

use std::io;
use std::path::{Path, PathBuf};

/// Resolves `path` to an absolute path with symlinks followed, spelled the way other programs on
/// this platform accept.
pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// Drops a Windows verbatim prefix so two canonical paths can be compared. A no-op elsewhere.
pub fn simplified(path: &Path) -> &Path {
    dunce::simplified(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn canonical_resolves_a_real_directory() {
        let directory = TempDir::new().expect("temporary directory");
        let nested = directory.path().join("nested");
        std::fs::create_dir(&nested).expect("create nested directory");

        let canonical = canonical(&nested.join(".").join("..").join("nested"))
            .expect("canonicalize an existing directory");
        assert_eq!(
            canonical,
            self::canonical(&nested).expect("canonicalize the same directory")
        );
        assert!(canonical.is_absolute());
        assert_eq!(simplified(&canonical), canonical.as_path());
    }

    #[test]
    fn canonical_reports_a_missing_path() {
        let directory = TempDir::new().expect("temporary directory");
        assert!(canonical(&directory.path().join("absent")).is_err());
    }

    /// The whole reason this module exists: what Git and Godot are handed must be a plain path.
    #[cfg(windows)]
    #[test]
    fn canonical_keeps_windows_paths_plain() {
        let directory = TempDir::new().expect("temporary directory");
        let canonical = canonical(directory.path()).expect("canonicalize a temporary directory");
        assert!(
            !canonical.to_string_lossy().starts_with(r"\\?\"),
            "{} is spelled verbatim",
            canonical.display()
        );
    }
}
