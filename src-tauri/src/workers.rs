//! Where the Node workers Gofer ships live, and how a running Gofer finds them.
//!
//! Every worker path used to be one expression: `CARGO_MANIFEST_DIR` joined with
//! `../scripts/<worker>.mjs`. That constant is the directory the crate was *compiled* in, frozen
//! into the binary, and nothing ever copied a `.mjs` into the bundle — the shipped AppImage
//! contained none. So a built Gofer read its workers out of the source tree it was built from, and
//! resolved their imports against that checkout's `node_modules`. Editing `scripts/ai-worker.mjs`
//! changed what an already-built application ran, with no rebuild in between. On any other machine
//! the same path is simply absent and the feature reports itself missing.
//!
//! `scripts/build-workers.mjs` now bundles each worker into one self-contained file under
//! `src-tauri/workers`, and `tauri.conf.json` bundles that directory as an application resource.
//! This module is the lookup: the override wins, then the bundled resource, and only a debug build
//! is allowed to fall back to the source tree.
//!
//! That last rule is the fix. `tauri dev` keeps reading the live `scripts/` directory, which is the
//! whole point of a dev build. A release binary cannot reach the source tree at all, so what it
//! runs is fixed the moment it is built.
//!
//! All five workers are bundled. `memory-worker.mjs`, `rag-warmup.mjs` and
//! `rag-retrieve-worker.mjs` load `onnxruntime-node`, `@lancedb/lancedb` and `sharp` through a
//! require computed at run time, so those three packages are left external and copied into
//! `workers/node_modules`, which Node finds by walking up from the bundle.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The subdirectory of the application's resource directory that `build-workers.mjs` fills.
///
/// The layout is the contract with `tauri.conf.json`, which bundles `src-tauri/workers`.
pub(crate) const RESOURCE_DIRECTORY: &str = "workers";

/// The Godot documentation table, copied beside the bundles by `build-workers.mjs`.
const DATABASE_DIRECTORY: &str = ".lancedb";

/// The environment variable gofer-rag reads instead of guessing where its own package sits.
const DATABASE_VARIABLE: &str = "GOFER_RAG_DATABASE_PATH";

/// The subdirectory `build-node-runtime.mjs` fills, bundled the same way.
const RUNTIME_DIRECTORY: &str = "runtime";

/// The resource directory, remembered once at startup.
///
/// The AI workers are spawned from places that hold no `AppHandle` — `chatgpt_auth::run_worker` is
/// called from a plain command thread — and the directory cannot change while the process runs, so
/// it is read once in `setup` rather than threaded through every caller.
static RESOURCE_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Records where this process's resources are. Called once, from the Tauri setup hook.
pub(crate) fn remember_resource_dir(directory: Option<PathBuf>) {
    let _ = RESOURCE_DIR.set(directory);
}

/// The source `scripts/` directory, or `None` in a release build.
///
/// A release binary that looked here would be back to reading whatever the build machine's
/// checkout says today, which is the bug this module exists to close.
fn source_directory() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    Some(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts"),
    )
}

/// The Node binary the workers are spawned with.
///
/// Every worker here is JavaScript, and the binary that ran them used to be whatever `node` PATH
/// answered with. That failed outright on a machine with no Node, and failed on macOS even with one
/// installed: a GUI-launched `.app` inherits `/usr/bin:/bin:/usr/sbin:/sbin` and never reads a
/// shell profile, so an nvm or Homebrew Node is invisible to it.
///
/// `GOFER_NODE_BINARY` still wins — the test suites point it at their own — and PATH is still the
/// last resort, because a `cargo test` or a `tauri dev` run may have no bundled runtime beside it.
pub(crate) fn node_binary() -> OsString {
    node_binary_from(
        std::env::var_os("GOFER_NODE_BINARY"),
        RESOURCE_DIR.get().and_then(Option::as_deref),
    )
}

/// The lookup itself, with the resource directory passed in so it can be tested without an app.
fn node_binary_from(override_path: Option<OsString>, resource_dir: Option<&Path>) -> OsString {
    if let Some(path) = override_path {
        return path;
    }
    if let Some(directory) = resource_dir {
        let bundled =
            directory
                .join(RUNTIME_DIRECTORY)
                .join(if cfg!(windows) { "node.exe" } else { "node" });
        if bundled.is_file() {
            return bundled.into_os_string();
        }
    }
    OsString::from("node")
}

/// What to add to a documentation worker's environment so it reads the table Gofer shipped.
///
/// gofer-rag resolves its database one directory above its own module file. Bundling inlined that
/// file into `workers/`, so the guess became the resource root — which holds no database, and every
/// warmup failed on `Table 'chunks' was not found` after downloading 1.8 GiB of models first.
///
/// Nothing is added when the worker has no table beside it. That is the source-tree build, where
/// the import is not inlined and the package's own guess is the right one.
pub(crate) fn database_env(worker: &Path) -> Vec<(OsString, OsString)> {
    if std::env::var_os(DATABASE_VARIABLE).is_some() {
        return Vec::new();
    }
    let Some(directory) = worker.parent() else {
        return Vec::new();
    };
    let database = directory.join(DATABASE_DIRECTORY);
    if !database.is_dir() {
        return Vec::new();
    }
    vec![(OsString::from(DATABASE_VARIABLE), database.into_os_string())]
}

/// Resolves a bundled worker, naming itself in the failure so the message is actionable.
///
/// `label` is how the worker is spoken about to the user ("The Pi AI worker"), `variable` is its
/// environment override, and `file` is the bundle's name in both `scripts/` and `workers/`.
pub(crate) fn resolve(label: &str, variable: &str, file: &str) -> Result<PathBuf, String> {
    resolve_from(
        std::env::var_os(variable),
        RESOURCE_DIR.get().and_then(Option::as_deref),
        source_directory().as_deref(),
        label,
        variable,
        file,
    )
}

/// The lookup itself, with every directory passed in so it can be tested without a running app.
fn resolve_from(
    override_path: Option<OsString>,
    resource_dir: Option<&Path>,
    source_dir: Option<&Path>,
    label: &str,
    variable: &str,
    file: &str,
) -> Result<PathBuf, String> {
    if let Some(path) = override_path {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "{label} was not found at {}, where {variable} points.",
            path.display()
        ));
    }
    if let Some(directory) = resource_dir {
        let bundled = directory.join(RESOURCE_DIRECTORY).join(file);
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    if let Some(directory) = source_dir {
        let source = directory.join(file);
        if source.is_file() {
            return Ok(source);
        }
    }
    Err(format!(
        "{label} was not found. Run npm run build:workers, or set {variable}."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const LABEL: &str = "The Pi AI worker";
    const VARIABLE: &str = "GOFER_TEST_WORKER";
    const FILE: &str = "ai-worker.mjs";

    fn resolve_in(
        override_path: Option<OsString>,
        resource_dir: Option<&Path>,
        source_dir: Option<&Path>,
    ) -> Result<PathBuf, String> {
        resolve_from(
            override_path,
            resource_dir,
            source_dir,
            LABEL,
            VARIABLE,
            FILE,
        )
    }

    /// Writes `workers/ai-worker.mjs` under a resource directory, the way the bundle ships it.
    fn bundled(root: &Path) -> PathBuf {
        let directory = root.join(RESOURCE_DIRECTORY);
        std::fs::create_dir_all(&directory).expect("create the workers directory");
        let path = directory.join(FILE);
        std::fs::write(&path, b"bundled").expect("write the bundled worker");
        path
    }

    #[test]
    fn the_bundled_resource_is_preferred_over_the_source_tree() {
        let resources = TempDir::new().expect("resource directory");
        let source = TempDir::new().expect("source directory");
        let expected = bundled(resources.path());
        std::fs::write(source.path().join(FILE), b"source").expect("write the source worker");

        let resolved = resolve_in(None, Some(resources.path()), Some(source.path()))
            .expect("the bundled worker");

        assert_eq!(resolved, expected);
    }

    /// A worker loose in the resource root is not the one Gofer ships; the subdirectory is the
    /// contract with `tauri.conf.json`.
    #[test]
    fn a_worker_outside_the_workers_directory_is_not_the_bundled_one() {
        let resources = TempDir::new().expect("resource directory");
        std::fs::write(resources.path().join(FILE), b"loose").expect("write a loose worker");

        let failure =
            resolve_in(None, Some(resources.path()), None).expect_err("nothing bundled to find");

        assert!(failure.contains("build:workers"), "{failure}");
    }

    #[test]
    fn the_override_wins_and_says_where_it_pointed_when_it_is_wrong() {
        let resources = TempDir::new().expect("resource directory");
        bundled(resources.path());
        let elsewhere = TempDir::new().expect("override directory");
        let path = elsewhere.path().join("mine.mjs");
        std::fs::write(&path, b"mine").expect("write the override worker");

        let resolved = resolve_in(Some(path.clone().into()), Some(resources.path()), None)
            .expect("the overridden worker");
        assert_eq!(resolved, path);

        let failure = resolve_in(
            Some(OsString::from("/nowhere/ai-worker.mjs")),
            Some(resources.path()),
            None,
        )
        .expect_err("a path that is not a file");
        assert!(failure.contains("/nowhere/ai-worker.mjs"), "{failure}");
        assert!(failure.contains(VARIABLE), "{failure}");
    }

    /// The bundled runtime is what a shipped Gofer spawns; PATH is what a `tauri dev` run does.
    #[test]
    fn the_bundled_node_is_preferred_and_path_is_the_last_resort() {
        let resources = TempDir::new().expect("resource directory");
        let directory = resources.path().join(RUNTIME_DIRECTORY);
        std::fs::create_dir_all(&directory).expect("create the runtime directory");
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        let bundled = directory.join(name);
        std::fs::write(&bundled, b"runtime").expect("write the bundled runtime");

        assert_eq!(
            node_binary_from(None, Some(resources.path())),
            bundled.into_os_string()
        );

        let empty = TempDir::new().expect("empty resource directory");
        assert_eq!(
            node_binary_from(None, Some(empty.path())),
            OsString::from("node")
        );
        assert_eq!(node_binary_from(None, None), OsString::from("node"));

        // The override is taken as written, because the suites point it at a binary this lookup
        // has no reason to know about.
        let mine = OsString::from("/nowhere/node");
        assert_eq!(node_binary_from(Some(mine.clone()), None), mine);
    }

    /// The documentation table is named outright when it is beside the worker, and not otherwise.
    #[test]
    fn the_documentation_table_is_named_only_when_it_ships_beside_the_worker() {
        let directory = TempDir::new().expect("worker directory");
        let worker = directory.path().join("rag-warmup.mjs");
        std::fs::write(&worker, b"worker").expect("write the worker");

        // No table beside it is the source-tree build, where the import is not inlined and
        // gofer-rag's own guess at its package root is the right one.
        assert!(database_env(&worker).is_empty());

        let database = directory.path().join(DATABASE_DIRECTORY);
        std::fs::create_dir_all(&database).expect("create the table");
        assert_eq!(
            database_env(&worker),
            vec![(OsString::from(DATABASE_VARIABLE), database.into_os_string())]
        );
    }

    /// The point of the whole module: a release build has no source directory to fall back to, so
    /// an unbundled release binary fails loudly instead of quietly running the build machine's
    /// working tree.
    #[test]
    fn a_release_build_has_no_source_fallback() {
        let source = TempDir::new().expect("source directory");
        std::fs::write(source.path().join(FILE), b"source").expect("write the source worker");

        assert_eq!(
            resolve_in(None, None, Some(source.path())).expect("a debug build reads the source"),
            source.path().join(FILE)
        );
        assert!(resolve_in(None, None, None).is_err());
        assert_eq!(source_directory().is_some(), cfg!(debug_assertions));
    }
}
