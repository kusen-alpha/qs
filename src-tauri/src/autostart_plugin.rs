// 兼容原版 `plugin:autostart|*`：HKCU Run 键写入当前 exe 路径。
use std::process::Command;

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "盘盯盯";

fn exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
fn is_enabled() -> bool {
    let out = Command::new("reg")
        .args(["query", RUN_KEY, "/v", VALUE_NAME])
        .output();
    match out {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

#[tauri::command]
fn enable() -> Result<(), String> {
    let status = Command::new("reg")
        .args([
            "add",
            RUN_KEY,
            "/v",
            VALUE_NAME,
            "/t",
            "REG_SZ",
            "/d",
            &format!("\"{}\"", exe_path()),
            "/f",
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("reg add failed".into())
    }
}

#[tauri::command]
fn disable() -> Result<(), String> {
    let _ = Command::new("reg")
        .args(["delete", RUN_KEY, "/v", VALUE_NAME, "/f"])
        .status();
    Ok(())
}

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("autostart")
        .invoke_handler(tauri::generate_handler![is_enabled, enable, disable])
        .build()
}
