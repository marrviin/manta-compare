//! Finder Quick Action (macOS Services menu) install/uninstall.
//!
//! The Quick Action is an Automator `.workflow` bundle whose templates live in
//! `templates/manta-compare-quick-action/` (compiled in via `include_str!`).
//! Installing just writes the bundle to `~/Library/Services/` — no signing is
//! involved, since plain workflow services are not gated by Gatekeeper. At run
//! time the workflow does `open -a "Manta Compare" "$@"`, which hands the
//! selected paths to the app through odoc events (see `crate::open_with`).

use std::fs;
use std::path::PathBuf;

/// Templates compiled into the binary (keyed by their path inside the
/// generated workflow bundle).
const TEMPLATE_FILES: &[(&str, &str)] = &[
    (
        "Contents/Info.plist",
        include_str!("../../templates/manta-compare-quick-action/Info.plist"),
    ),
    (
        "Contents/document.wflow",
        include_str!("../../templates/manta-compare-quick-action/document.wflow"),
    ),
    (
        "Contents/Resources/en.lproj/ServicesMenu.strings",
        include_str!("../../templates/manta-compare-quick-action/en.lproj/ServicesMenu.strings"),
    ),
    (
        "Contents/Resources/zh_CN.lproj/ServicesMenu.strings",
        include_str!("../../templates/manta-compare-quick-action/zh_CN.lproj/ServicesMenu.strings"),
    ),
];

/// Where the installed workflow bundle lives (inside the user's Services dir).
fn workflow_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "cannot resolve the user's home directory".to_string())?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Services")
        .join("Manta Compare.workflow"))
}

/// Nudge the Services cache so a fresh install shows up (or a removal
/// disappears) without a logout. Best-effort: errors are ignored.
fn flush_services_cache() {
    let _ = std::process::Command::new("/System/Library/CoreServices/pbs")
        .arg("-flush")
        .output();
}

/// Bump when a template file changes so existing installs are rewritten on the
/// next launch (the sync effect only installs when `installed` says "stale").
const WORKFLOW_VERSION: &str = "1";

/// Marker file written on install; its content is [`WORKFLOW_VERSION`].
const VERSION_FILE: &str = "Contents/version";

#[tauri::command]
pub fn finder_quick_action_installed() -> bool {
    workflow_dir()
        .ok()
        .map(|dir| {
            fs::read_to_string(dir.join(VERSION_FILE))
                .map(|v| v.trim() == WORKFLOW_VERSION)
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

#[tauri::command]
pub fn finder_quick_action_install() -> Result<(), String> {
    let dir = workflow_dir()?;
    for (rel, contents) in TEMPLATE_FILES {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
        }
        fs::write(&path, contents)
            .map_err(|e| format!("failed to write {}: {e}", path.display()))?;
    }
    // Stamp after the templates so a failed write never leaves a "current"
    // version marker behind (the next sync will then rewrite the bundle).
    let version_path = dir.join(VERSION_FILE);
    if let Some(parent) = version_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    fs::write(&version_path, WORKFLOW_VERSION)
        .map_err(|e| format!("failed to write {}: {e}", version_path.display()))?;
    flush_services_cache();
    Ok(())
}

#[tauri::command]
pub fn finder_quick_action_uninstall() -> Result<(), String> {
    let dir = workflow_dir()?;
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| format!("failed to remove {}: {e}", dir.display()))?;
    }
    flush_services_cache();
    Ok(())
}
