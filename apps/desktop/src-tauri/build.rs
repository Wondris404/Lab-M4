fn main() {
    // Ensure Windows .exe icon resources recompile when icons change.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    // Own invoke commands are allowed by default. Limit that set to the pty,
    // shell, session, settings, and Usage commands the frontend actually calls.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "spawn_powershell",
            "write_powershell",
            "resize_powershell",
            "kill_powershell",
            "load_sessions",
            "save_sessions",
            "agent_hook_url",
            "load_app_settings",
            "save_app_settings",
            "usage_list_sources",
            "usage_select_source",
            "usage_remove_source",
            "usage_scan",
        ]),
    ))
    .expect("failed to run tauri-build");
}
