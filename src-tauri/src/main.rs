#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod autostart_plugin;
mod fs_extra;
mod store_plugin;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(main) = app.get_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }
        }))
        .plugin(store_plugin::init())
        .plugin(autostart_plugin::init())
        .plugin(fs_extra::init())
        .setup(|app| {
            if let Some(main) = app.get_window("main") {
                let _ = main.set_always_on_top(true);
                let _ = main.set_skip_taskbar(true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running 趋势");
}
