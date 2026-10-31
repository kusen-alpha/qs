use std::env;
use std::fs;
use std::path::Path;

fn main() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let version_file = Path::new(&manifest_dir)
        .join("..")
        .join("version.json");
    if let Ok(raw) = fs::read_to_string(&version_file) {
        if let Some(version) = raw.lines().find_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix("\"version\"")?.trim_start_matches(':').trim();
            let value = rest.trim_end_matches(',').trim().trim_matches('"');
            (!value.is_empty()).then(|| value.to_string())
        }) {
            println!("cargo:rustc-env=QS_VERSION={}", version);
        }
    }
    println!("cargo:rustc-env=QS_BUILD_DATE={}", build_date());
    tauri_build::build()
}

fn build_date() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let z = secs / 86400 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    format!("{:04}-{:02}-{:02}", y, m, d)
}
