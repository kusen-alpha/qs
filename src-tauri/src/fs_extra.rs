// 对齐原版 `plugin:fs-extra|exists` 命令，避免 fs scope 限制。
use std::path::PathBuf;

#[tauri::command]
fn exists(path: PathBuf) -> bool {
    path.exists()
}

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("fs-extra")
        .invoke_handler(tauri::generate_handler![exists])
        .build()
}
