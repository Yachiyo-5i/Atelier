fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            // Autogenerate `allow-window-control` / `allow-desktop-platform`
            // app permissions referenced by capabilities/main.json.
            tauri_build::AppManifest::new().commands(&["window_control", "desktop_platform"]),
        ),
    )
    .expect("failed to run tauri-build");
}
