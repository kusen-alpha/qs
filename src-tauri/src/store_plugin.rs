// 兼容原版 `plugin:store|*` 命令的最小实现：
// 每个 path 对应一个 JSON 文件，全部数据保存在内存 HashMap，save() 时落盘。
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct StoreState(pub Mutex<HashMap<String, Value>>);

fn read_file(path: &str) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn with_store<F, T>(state: &StoreState, path: &str, f: F) -> Result<T, String>
where
    F: FnOnce(&mut Map<String, Value>) -> T,
{
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let entry = map.entry(path.to_string()).or_insert_with(|| read_file(path));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    Ok(f(entry.as_object_mut().unwrap()))
}

#[tauri::command]
fn set(state: State<StoreState>, path: String, key: String, value: Value) -> Result<(), String> {
    with_store(&state, &path, |m| {
        m.insert(key, value);
    })
}

#[tauri::command]
fn get(state: State<StoreState>, path: String, key: String) -> Result<Option<Value>, String> {
    with_store(&state, &path, |m| m.get(&key).cloned())
}

#[tauri::command]
fn has(state: State<StoreState>, path: String, key: String) -> Result<bool, String> {
    with_store(&state, &path, |m| m.contains_key(&key))
}

#[tauri::command]
fn delete(state: State<StoreState>, path: String, key: String) -> Result<(), String> {
    with_store(&state, &path, |m| {
        m.remove(&key);
    })
}

#[tauri::command]
fn clear(state: State<StoreState>, path: String) -> Result<(), String> {
    with_store(&state, &path, |m| m.clear())
}

#[tauri::command]
fn reset(state: State<StoreState>, path: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    map.insert(path, Value::Object(Map::new()));
    Ok(())
}

#[tauri::command]
fn keys(state: State<StoreState>, path: String) -> Result<Vec<String>, String> {
    with_store(&state, &path, |m| m.keys().cloned().collect())
}

#[tauri::command]
fn values(state: State<StoreState>, path: String) -> Result<Vec<Value>, String> {
    with_store(&state, &path, |m| m.values().cloned().collect())
}

#[tauri::command]
fn entries(state: State<StoreState>, path: String) -> Result<Vec<(String, Value)>, String> {
    with_store(&state, &path, |m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

#[tauri::command]
fn length(state: State<StoreState>, path: String) -> Result<usize, String> {
    with_store(&state, &path, |m| m.len())
}

#[tauri::command]
fn load(state: State<StoreState>, path: String) -> Result<(), String> {
    let value = read_file(&path);
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    map.insert(path, value);
    Ok(())
}

#[tauri::command]
fn save(state: State<StoreState>, path: String) -> Result<(), String> {
    let value = {
        let map = state.0.lock().map_err(|e| e.to_string())?;
        map.get(&path).cloned().unwrap_or(Value::Object(Map::new()))
    };
    if let Some(parent) = PathBuf::from(&path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    let text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("store")
        .setup(|app| {
            app.manage(StoreState(Mutex::new(HashMap::new())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
    set,
    get,
    has,
    delete,
    clear,
    reset,
    keys,
    values,
    entries,
    length,
    load,
    save
])
        .build()
}
