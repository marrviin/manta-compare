mod commands;
mod open_with;

use commands::finder::{
    finder_quick_action_install, finder_quick_action_installed, finder_quick_action_uninstall,
};
use commands::folder::{copy_path, diff_dirs, path_kind, trash_path};
use commands::fs::{allow_watch_path, read_text_file, write_text_file};
use commands::git::{git_checkout_file, git_diff_refs, git_repo_info, git_show};
use open_with::take_pending_open_paths;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .manage(open_with::OpenState::default())
        .setup(|app| {
            open_with::queue_argv_paths(app.state());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            allow_watch_path,
            diff_dirs,
            copy_path,
            path_kind,
            trash_path,
            git_repo_info,
            git_diff_refs,
            git_show,
            git_checkout_file,
            take_pending_open_paths,
            finder_quick_action_installed,
            finder_quick_action_install,
            finder_quick_action_uninstall
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Files handed to the app by the system (Finder "Open With" / Quick
            // Action / `open -a`) arrive here as file:// URLs.
            if let tauri::RunEvent::Opened { urls } = event {
                open_with::handle_opened(app, app.state(), urls);
            }
        });
}
