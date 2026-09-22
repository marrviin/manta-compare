mod commands;
mod open_with;

use commands::finder::{
    finder_quick_action_install, finder_quick_action_installed, finder_quick_action_uninstall,
};
use commands::folder::{copy_path, create_dir, diff_dirs, path_kind, rename_path, trash_path};
use commands::fs::{allow_watch_path, read_text_file, write_text_file};
use commands::git::{git_checkout_file, git_diff_refs, git_repo_info, git_show};
use open_with::take_pending_open_paths;
use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};
use tauri::Manager;

/// Install the app menu: tauri's default menu mirrored, minus Edit → Select All.
/// That item's Cmd+A key equivalent dispatches the native `selectAll:` editing
/// command straight to the webview — it never reaches the DOM as a keydown, and
/// WebKit's command ignores CSS `user-select: none`, so every label in the app
/// gets highlighted. Cut/Copy/Paste/Undo/Redo stay so text editing in inputs and
/// the Monaco editors is unaffected.
#[cfg(target_os = "macos")]
fn install_app_menu(handle: &tauri::AppHandle) -> tauri::Result<()> {
    let pkg_info = handle.package_info();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: handle.config().bundle.copyright.clone(),
        ..Default::default()
    };

    let window_menu = Submenu::with_id_and_items(
        handle,
        "pc-window-submenu",
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;

    let menu = Menu::with_items(
        handle,
        &[
            &Submenu::with_items(
                handle,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(handle, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::services(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::hide(handle, None)?,
                    &PredefinedMenuItem::hide_others(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::quit(handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                handle,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(handle, None)?,
                    &PredefinedMenuItem::redo(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::cut(handle, None)?,
                    &PredefinedMenuItem::copy(handle, None)?,
                    &PredefinedMenuItem::paste(handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                handle,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(handle, None)?],
            )?,
            &window_menu,
            &Submenu::with_items(handle, "Help", true, &[])?,
        ],
    )?;
    handle.set_menu(menu)?;
    Ok(())
}

/// Windows/Linux: tauri's default menu carries the same Ctrl+A Select All
/// accelerator in its Edit submenu; install a mirrored one without it.
#[cfg(not(target_os = "macos"))]
fn install_app_menu(handle: &tauri::AppHandle) -> tauri::Result<()> {
    let window_menu = Submenu::with_id_and_items(
        handle,
        "pc-window-submenu",
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;

    let menu = Menu::with_items(
        handle,
        &[
            &Submenu::with_items(
                handle,
                "File",
                true,
                &[
                    &PredefinedMenuItem::close_window(handle, None)?,
                    &PredefinedMenuItem::quit(handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                handle,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(handle, None)?,
                    &PredefinedMenuItem::redo(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::cut(handle, None)?,
                    &PredefinedMenuItem::copy(handle, None)?,
                    &PredefinedMenuItem::paste(handle, None)?,
                ],
            )?,
            &window_menu,
        ],
    )?;
    handle.set_menu(menu)?;
    Ok(())
}

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
            install_app_menu(app.handle())?;
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
            rename_path,
            create_dir,
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
