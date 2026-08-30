use std::env;
use std::fs;
use std::path::PathBuf;

/// The Common Controls v6 side-by-side dependency Tauri needs on Windows.
///
/// This is `tauri-build`'s own default manifest. Gofer supplies it instead, because `tauri-build`
/// can only attach it to binaries — see `embed_windows_manifest`.
const WINDOWS_APP_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

/// Embeds the application manifest into every artifact the crate links, not just its binaries.
///
/// Without the Common Controls v6 dependency the loader binds the process to comctl32 v5 from
/// System32, which does not export everything Tauri imports, and the artifact dies before `main`
/// with `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139). `tauri-build` embeds the manifest as a Windows
/// resource, but the `embed-resource` crate under it announces that resource as
/// `cargo:rustc-link-arg-bins`, and Cargo reads `bins` as "targets that are binaries" — the unit
/// test harness is the *library* target compiled in test mode, so it is not one. That is why
/// `cargo test` has never been able to start on Windows here while `cargo build` was fine, and why
/// `rustc-link-arg-tests` would not fix it either: that one means `tests/*.rs`.
///
/// So Gofer takes the manifest away from `tauri-build` (`new_without_app_manifest`, which still
/// leaves it the icon and version resource) and hands it to the linker directly. A plain
/// `rustc-link-arg` reaches every target, and because the resource no longer carries a manifest of
/// its own there is nothing for `/MANIFEST:EMBED` to collide with.
fn embed_windows_manifest() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return;
    }

    let manifest = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set for build scripts"))
        .join("windows-app-manifest.xml");
    fs::write(&manifest, WINDOWS_APP_MANIFEST).expect("write the Windows application manifest");

    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
        manifest.to_str().expect("OUT_DIR is valid UTF-8")
    );
}

fn main() {
    embed_windows_manifest();

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
            .app_manifest(tauri_build::AppManifest::new()),
    )
    .expect("failed to build the Tauri application")
}
