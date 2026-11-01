#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, State, WindowEvent,
};

const APP_VERSION: &str = env!("QS_VERSION");
const APP_BUILD_DATE: &str = env!("QS_BUILD_DATE");

/// 数据库连接由主进程持有，所有写入走同一条连接，避免多窗口并发争锁
struct Db(Mutex<Connection>);

const DB_FILE: &str = "stocks.db";

/// v1/v2 -> v3：stocks 精简为最终结构，去掉 code/market/exchange/volume/open/high/low/pre_close/zx_order/price_diff
const STOCKS_FINAL_SQL: &str = r#"
DROP INDEX IF EXISTS ix_stocks_zx;
DROP INDEX IF EXISTS ix_stocks_code;
ALTER TABLE stocks RENAME TO stocks_old;
CREATE TABLE stocks (
    secid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price REAL,
    ratio REAL,
    amount REAL,
    turnover_ratio REAL,
    industry1 TEXT,
    industry2 TEXT,
    ths_industry TEXT,
    industry_updated_at INTEGER,
    zx INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER
);
INSERT INTO stocks (secid, name, price, ratio, amount, turnover_ratio,
                    industry1, industry2, ths_industry, industry_updated_at, zx, updated_at)
    SELECT secid, name, price, ratio, amount, turnover_ratio,
           industry1, industry2, ths_industry, industry_updated_at, zx, updated_at
    FROM stocks_old;
DROP TABLE stocks_old;
CREATE INDEX ix_stocks_zx ON stocks(zx);
"#;

/// v3 -> v4：stocks 增加当日行情价格字段（15:15 前用其合成当天K线）
const STOCKS_PRICE_SQL: &str = r#"
ALTER TABLE stocks ADD COLUMN open REAL;
ALTER TABLE stocks ADD COLUMN high REAL;
ALTER TABLE stocks ADD COLUMN low REAL;
"#;

/// v4 -> v5：histories 去掉 adjust（固定前复权），amount 由元改为亿
const HISTORIES_V5_SQL: &str = r#"
ALTER TABLE histories RENAME TO histories_old;
CREATE TABLE histories (
    secid TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL,
    close REAL,
    high REAL,
    low REAL,
    volume REAL,
    amount REAL,
    PRIMARY KEY (secid, date)
) WITHOUT ROWID;
INSERT INTO histories (secid, date, open, close, high, low, volume, amount)
    SELECT secid, date, open, close, high, low, volume,
           CASE WHEN amount IS NULL THEN NULL ELSE ROUND(amount / 100000000.0, 2) END
    FROM histories_old WHERE adjust = 'qfq';
DROP TABLE histories_old;
"#;

/// v8 -> v9：histories 去掉 volume，新增 ratio（涨跌幅，%）与 turnover_ratio（换手率，%），
/// 成交额不再按两位小数存储（显示精度由前端控制）
const HISTORIES_V9_SQL: &str = r#"
ALTER TABLE histories RENAME TO histories_old;
CREATE TABLE histories (
    secid TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL,
    close REAL,
    high REAL,
    low REAL,
    amount REAL,
    ratio REAL,
    turnover_ratio REAL,
    PRIMARY KEY (secid, date)
) WITHOUT ROWID;
INSERT INTO histories (secid, date, open, close, high, low, amount)
    SELECT secid, date, open, close, high, low, amount FROM histories_old;
DROP TABLE histories_old;
"#;

/// v5 -> v6：notions 去掉 editable（自选 id=0 不入表，其余概念一律可编辑）
const NOTIONS_V6_SQL: &str = "ALTER TABLE notions DROP COLUMN editable;";

/// v6 -> v7：概念名唯一范围改为「一级全局唯一、二级同组唯一」
const NOTIONS_V7_SQL: &str = r#"
DROP INDEX IF EXISTS ux_notions_name;
CREATE UNIQUE INDEX IF NOT EXISTS ux_notions_top_name ON notions(name) WHERE pid IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_notions_sub_name ON notions(pid, name) WHERE pid IS NOT NULL;
"#;

/// v7 -> v8：旧版 ths_boards 只有行业板块 code/name，无法容纳概念、申万与成分关系，
/// 迁移到统一的 boards 实体后删除
const THS_BOARDS_V8_SQL: &str = r#"
INSERT OR IGNORE INTO boards (board_key, source, type, level, code, name, parent_key, updated_at)
    SELECT 'ths_hy:' || code, 'ths', 'industry', 1, code, name, NULL, updated_at FROM ths_boards;
DROP TABLE ths_boards;
"#;

/// 已有个股行业字段回填成板块与成分关系（幂等，可重复执行）
const BOARDS_V8_BACKFILL_SQL: &str = r#"
INSERT OR IGNORE INTO boards (board_key, source, type, level, code, name, parent_key, updated_at)
    SELECT 'sw1:' || industry1, 'sw', 'industry', 1, NULL, industry1, NULL, MAX(industry_updated_at)
    FROM stocks WHERE industry1 IS NOT NULL AND industry1 <> '' GROUP BY industry1;
INSERT OR IGNORE INTO boards (board_key, source, type, level, code, name, parent_key, updated_at)
    SELECT 'sw2:' || industry2, 'sw', 'industry', 2, NULL, industry2, NULL, MAX(industry_updated_at)
    FROM stocks WHERE industry2 IS NOT NULL AND industry2 <> '' GROUP BY industry2;
INSERT OR IGNORE INTO stock_boards (secid, board_key, updated_at)
    SELECT secid, 'sw1:' || industry1, COALESCE(industry_updated_at, 0) FROM stocks
    WHERE industry1 IS NOT NULL AND industry1 <> '';
INSERT OR IGNORE INTO stock_boards (secid, board_key, updated_at)
    SELECT secid, 'sw2:' || industry2, COALESCE(industry_updated_at, 0) FROM stocks
    WHERE industry2 IS NOT NULL AND industry2 <> '';
INSERT OR IGNORE INTO stock_boards (secid, board_key, updated_at)
    SELECT s.secid, b.board_key, COALESCE(s.industry_updated_at, 0)
    FROM stocks s JOIN boards b ON b.source = 'ths' AND b.type = 'industry' AND b.name = s.ths_industry
    WHERE s.ths_industry IS NOT NULL AND s.ths_industry <> '';
INSERT OR IGNORE INTO boards (board_key, source, type, level, code, name, parent_key, updated_at)
    SELECT 'self:' || id, 'self', 'concept', CASE WHEN pid IS NULL THEN 1 ELSE 2 END, NULL, name,
           CASE WHEN pid IS NULL THEN NULL ELSE 'self:' || pid END, 0 FROM notions;
INSERT OR IGNORE INTO stock_boards (secid, board_key, updated_at)
    SELECT secid, 'self:' || notion_id, 0 FROM notion_stocks;
"#;

/// 个股K线统一最短入库日期（与前端 MIN_BEG 一致），更早的K线不落库
const HISTORY_MIN_DATE: &str = "2024-01-01";
/// 市场宽度（sckd）统一最短入库日期，与个股历史保持一致
const MARKET_WIDTH_MIN_DATE: &str = "2024-01-01";

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS stocks (
    secid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price REAL,
    open REAL,
    high REAL,
    low REAL,
    ratio REAL,
    amount REAL,
    turnover_ratio REAL,
    industry1 TEXT,
    industry2 TEXT,
    ths_industry TEXT,
    industry_updated_at INTEGER,
    zx INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_stocks_zx ON stocks(zx);

CREATE TABLE IF NOT EXISTS notions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    pid INTEGER REFERENCES notions(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notions_top_name ON notions(name) WHERE pid IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_notions_sub_name ON notions(pid, name) WHERE pid IS NOT NULL;

CREATE TABLE IF NOT EXISTS notion_stocks (
    notion_id INTEGER NOT NULL REFERENCES notions(id) ON DELETE CASCADE,
    secid TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (notion_id, secid)
);

CREATE TABLE IF NOT EXISTS histories (
    secid TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL,
    close REAL,
    high REAL,
    low REAL,
    volume REAL,
    amount REAL,
    ratio REAL,
    turnover_ratio REAL,
    PRIMARY KEY (secid, date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS boards (
    board_key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    level INTEGER,
    code TEXT,
    name TEXT NOT NULL,
    parent_key TEXT,
    updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_boards_source ON boards(source, type);

CREATE TABLE IF NOT EXISTS stock_boards (
    secid TEXT NOT NULL,
    board_key TEXT NOT NULL,
    updated_at INTEGER,
    PRIMARY KEY (secid, board_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_stock_boards_key ON stock_boards(board_key);

CREATE TABLE IF NOT EXISTS board_histories (
    board_key TEXT NOT NULL,
    date TEXT NOT NULL,
    close REAL,
    pct REAL,
    amount REAL,
    members INTEGER,
    PRIMARY KEY (board_key, date)
) WITHOUT ROWID;

/* 市场宽度（sckd）：行=申万一级行业，列=交易日，value20 为站上 MA20 的股票占比(%) */
CREATE TABLE IF NOT EXISTS sckd (
    trade_date TEXT NOT NULL,
    industry_code TEXT NOT NULL,
    industry_name TEXT NOT NULL,
    value20 REAL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER,
    PRIMARY KEY (trade_date, industry_code)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_sckd_date ON sckd(trade_date);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let conn = Connection::open(dir.join(DB_FILE))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;",
    )?;
    conn.execute_batch(SCHEMA_SQL)?;

    // 旧库（v1/v2）的 stocks 含冗余列，升级到 v3 时重建一次
    let version: i64 = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    if version > 0 && version < 3 {
        conn.execute_batch(STOCKS_FINAL_SQL)?;
    }
    // 兼容旧库：stocks 缺价格列时补齐（v3 及更早）
    let has_price_columns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('stocks') WHERE name = 'open'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if has_price_columns == 0 {
        conn.execute_batch(STOCKS_PRICE_SQL)?;
    }
    // 兼容旧库：histories 含 adjust 列时重建（固定前复权，amount 元转亿）
    let has_adjust_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('histories') WHERE name = 'adjust'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if has_adjust_column > 0 {
        conn.execute_batch(HISTORIES_V5_SQL)?;
    }
    // 兼容 v8 旧库：有 volume 但没有 ratio，说明还是"去成交量"之前的结构 → 重建
    let has_volume_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('histories') WHERE name = 'volume'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let has_ratio_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('histories') WHERE name = 'ratio'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if has_volume_column > 0 && has_ratio_column == 0 {
        conn.execute_batch(HISTORIES_V9_SQL)?;
    }
    // 兜底：histories 缺列时补齐（volume 由回填全量重拉填充）
    for column in ["ratio", "turnover_ratio", "volume"] {
        let has_column: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('histories') WHERE name = ?1",
                params![column],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if has_column == 0 {
            conn.execute_batch(&format!("ALTER TABLE histories ADD COLUMN {column} REAL;"))?;
        }
    }
    // 兼容旧库：notions 含 editable 列时去掉（该字段恒为 1，无实际意义）
    let has_editable_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('notions') WHERE name = 'editable'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if has_editable_column > 0 {
        conn.execute_batch(NOTIONS_V6_SQL)?;
    }
    // 兼容旧库：notions 的全局唯一索引改为按父级作用域唯一（同名二级概念可挂在不同的
    // 一级概念下，但同一一级概念内不可重名）
    let has_global_name_index: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'ux_notions_name'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if has_global_name_index > 0 {
        conn.execute_batch(NOTIONS_V7_SQL)?;
    }
    // v7 -> v8：ths_boards 并入 boards（旧库才存在该表，迁移后删除）
    let has_ths_boards: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'ths_boards'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if has_ths_boards > 0 {
        conn.execute_batch(THS_BOARDS_V8_SQL)?;
    }
    // 旧库按 stocks 里已有的申万/同花顺行业字段回填板块与成分（幂等）
    if version > 0 && version < 8 {
        conn.execute_batch(BOARDS_V8_BACKFILL_SQL)?;
    }
    // v10 -> v11：清理孤儿历史——既非自选、也不属于任何板块的空名股票（多为退市占位记录），
    // 其K线是腾讯兜底按结束日反向补满 640 根的远古数据，历史与占位记录一并删除
    if version > 0 && version < 11 {
        conn.execute(
            "DELETE FROM histories WHERE secid IN (
                 SELECT secid FROM stocks WHERE zx = 0 AND name = ''
                 AND NOT EXISTS (SELECT 1 FROM stock_boards b WHERE b.secid = stocks.secid)
             )",
            [],
        )?;
        conn.execute(
            "DELETE FROM stocks WHERE zx = 0 AND name = '' AND NOT EXISTS (
                 SELECT 1 FROM stock_boards b WHERE b.secid = stocks.secid
             )",
            [],
        )?;
    }
    // v11 -> v12：新增 board_histories（板块日线落库），表由 SCHEMA_SQL 幂等创建
    // v12 -> v13：历史统一只保留 2024-01-01 之后的数据；
    // 板块历史基于成分股历史聚合，基准点需从新起点整段重算，故一并清空
    if version > 0 && version < 13 {
        conn.execute(
            "DELETE FROM histories WHERE date < ?1",
            params![HISTORY_MIN_DATE],
        )?;
        conn.execute("DELETE FROM board_histories", [])?;
    }
    // v13 -> v14：旧库的申万二级板块没有 parent_key（v8 回填时未建立归属关系），
    // 按成分股的 industry1/industry2 关系补上所属一级板块，前端据此做一二级展开
    if version > 0 && version < 14 {
        conn.execute_batch(
            "UPDATE boards SET parent_key = (
                 SELECT 'sw1:' || s.industry1 FROM stocks s
                 WHERE s.industry2 = substr(boards.board_key, 5)
                   AND s.industry1 IS NOT NULL AND s.industry1 <> ''
                 GROUP BY s.industry1
                 ORDER BY COUNT(*) DESC, s.industry1
                 LIMIT 1
             )
             WHERE board_key LIKE 'sw2:%' AND parent_key IS NULL",
        )?;
    }
    // v14 -> v15：新增 sckd（市场宽度落库），表由 SCHEMA_SQL 幂等创建
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '15')",
        [],
    )?;
    Ok(conn)
}

/// 保留两位小数（stocks.amount / histories.amount 单位均为亿）
fn round2(value: Option<f64>) -> Option<f64> {
    value.map(|v| (v * 100.0).round() / 100.0)
}

/// JSON 数值字段：兼容数字与字符串，"-" 等无效值返回 None
fn num_of(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn upsert_stock(
    tx: &rusqlite::Transaction,
    symbol: &Value,
    zx: bool,
) -> Result<(), String> {
    let secid = symbol
        .get("secid")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if secid.is_empty() {
        return Ok(());
    }
    let name = symbol
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    tx.execute(
        "INSERT INTO stocks (secid, name, zx, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(secid) DO UPDATE SET
             name = CASE WHEN excluded.name = '' THEN stocks.name ELSE excluded.name END,
             zx = MAX(stocks.zx, excluded.zx),
             updated_at = excluded.updated_at",
        params![secid, name, zx as i64, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn insert_notion(
    tx: &rusqlite::Transaction,
    id: i64,
    name: &str,
    pid: Option<i64>,
    sort_order: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO notions (id, name, pid, sort_order)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             pid = excluded.pid,
             sort_order = excluded.sort_order",
        params![id, name, pid, sort_order],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn link_member(
    tx: &rusqlite::Transaction,
    notion_id: i64,
    secid: &str,
    sort_order: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT OR IGNORE INTO notion_stocks (notion_id, secid, sort_order)
         VALUES (?1, ?2, ?3)",
        params![notion_id, secid, sort_order],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 板块实体：board_key 一旦确定不再变化，名称/代码可以随抓取结果更新
fn upsert_board(
    tx: &rusqlite::Transaction,
    board_key: &str,
    source: &str,
    kind: &str,
    level: Option<i64>,
    code: Option<&str>,
    name: &str,
    parent_key: Option<&str>,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO boards (board_key, source, type, level, code, name, parent_key, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(board_key) DO UPDATE SET
             source = excluded.source,
             type = excluded.type,
             level = excluded.level,
             code = COALESCE(excluded.code, boards.code),
             name = excluded.name,
             parent_key = COALESCE(excluded.parent_key, boards.parent_key),
             updated_at = excluded.updated_at",
        params![board_key, source, kind, level, code, name, parent_key, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn link_board(
    tx: &rusqlite::Transaction,
    secid: &str,
    board_key: &str,
    updated_at: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO stock_boards (secid, board_key, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(secid, board_key) DO UPDATE SET updated_at = excluded.updated_at",
        params![secid, board_key, updated_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 自建概念（notions/notion_stocks）同步到 boards/stock_boards（source='self'），
/// 让自建概念与官方概念、申万行业共用同一套板块日K 聚合逻辑
fn sync_self_boards(tx: &rusqlite::Transaction) -> Result<(), String> {
    tx.execute("DELETE FROM stock_boards WHERE board_key LIKE 'self:%'", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM boards WHERE source = 'self'", [])
        .map_err(|e| e.to_string())?;
    let now = now_ms();
    tx.execute(
        "INSERT INTO boards (board_key, source, type, level, code, name, parent_key, updated_at)
         SELECT 'self:' || id, 'self', 'concept',
                CASE WHEN pid IS NULL THEN 1 ELSE 2 END, NULL, name,
                CASE WHEN pid IS NULL THEN NULL ELSE 'self:' || pid END, ?1
         FROM notions",
        params![now],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO stock_boards (secid, board_key, updated_at)
         SELECT secid, 'self:' || notion_id, ?1 FROM notion_stocks",
        params![now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "趋势",
        "version": APP_VERSION,
        "buildDate": APP_BUILD_DATE,
    })
}

/// 把 watchGroup（自选 id=0 + 概念树）写入 stocks / notions / notion_stocks
fn fill_watchgroup(
    tx: &rusqlite::Transaction,
    payload: &Value,
) -> Result<(i64, i64, i64), String> {
    let mut stock_count = 0i64;
    let mut notion_count = 0i64;
    let mut member_count = 0i64;

    let empty: Vec<Value> = Vec::new();
    for (index, group) in payload.as_array().unwrap_or(&empty).iter().enumerate() {
        let gid = group
            .get("id")
            .and_then(|v| v.as_i64())
            .unwrap_or(index as i64);
        let gname = group.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let symbols = group
            .get("symbols")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        // id=0 是「自选」分组，改为 stocks.zx 标记
        if gid == 0 {
            for symbol in symbols.iter() {
                upsert_stock(tx, symbol, true)?;
                stock_count += 1;
            }
            continue;
        }

        // 一级概念 sort_order 即其在看板中的顺序（自选 id=0 不入表，不占位）
        insert_notion(tx, gid, gname, None, index as i64)?;
        notion_count += 1;
        for (order, symbol) in symbols.iter().enumerate() {
            upsert_stock(tx, symbol, false)?;
            if let Some(secid) = symbol.get("secid").and_then(|v| v.as_str()) {
                link_member(tx, gid, secid, order as i64)?;
                member_count += 1;
            }
        }

        if let Some(children) = group.get("children").and_then(|v| v.as_array()) {
            for (child_index, child) in children.iter().enumerate() {
                let cid = child.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                let cname = child.get("name").and_then(|v| v.as_str()).unwrap_or("");
                insert_notion(tx, cid, cname, Some(gid), child_index as i64)?;
                notion_count += 1;

                let child_symbols = child
                    .get("symbols")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                for (order, symbol) in child_symbols.iter().enumerate() {
                    upsert_stock(tx, symbol, false)?;
                    if let Some(secid) = symbol.get("secid").and_then(|v| v.as_str()) {
                        link_member(tx, cid, secid, order as i64)?;
                        member_count += 1;
                    }
                }
            }
        }
    }
    Ok((stock_count, notion_count, member_count))
}

/// 把旧版 monitor.dat 中的自选/概念一次性导入 stocks.db（幂等，只执行一次）
#[tauri::command]
fn db_migrate_watchgroup(state: State<'_, Db>, groups: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&groups).map_err(|e| format!("解析自选数据失败: {e}"))?;
    let mut conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;

    let migrated: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'migrated_v1'", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if migrated.is_some() {
        return Ok(json!({ "migrated": false, "skipped": true }));
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (stock_count, notion_count, member_count) = fill_watchgroup(&tx, &payload)?;
    sync_self_boards(&tx)?;
    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_v1', ?1)",
        params![now_ms().to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    // 自建概念成分入库后整段重算板块历史（成分变化会让历史涨跌幅整体变化）
    let (board_count, board_rows) =
        refresh_board_histories(&conn, &["self:"]).unwrap_or((0, 0));

    Ok(json!({
        "migrated": true,
        "stocks": stock_count,
        "notions": notion_count,
        "members": member_count,
        "boards": board_count,
        "board_rows": board_rows,
    }))
}

/// 全量保存 watchGroup：重建概念与成员，并按 zx 标记自选
#[tauri::command]
fn db_save_watchgroup(state: State<'_, Db>, groups: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&groups).map_err(|e| format!("解析自选数据失败: {e}"))?;
    let mut conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM notion_stocks", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM notions", [])
        .map_err(|e| e.to_string())?;
    // 自选由当前快照重建，先全部降级再按快照置回
    tx.execute("UPDATE stocks SET zx = 0", [])
        .map_err(|e| e.to_string())?;

    let (stock_count, notion_count, member_count) = fill_watchgroup(&tx, &payload)?;
    // 自建概念同步为板块实体，供板块日K 统一聚合
    sync_self_boards(&tx)?;

    // 删除不再被自选或任何概念引用的股票，并连带清理其历史K线。
    // name 为空的行是添加弹窗/搜索时补录的行业缓存（非用户数据），保留不删。
    let removed_stocks = tx
        .execute(
            "DELETE FROM stocks
             WHERE zx = 0 AND name <> ''
               AND secid NOT IN (SELECT secid FROM notion_stocks)",
            [],
        )
        .map_err(|e| e.to_string())?;
    let removed_histories = tx
        .execute(
            "DELETE FROM histories WHERE secid NOT IN (SELECT secid FROM stocks)",
            [],
        )
        .map_err(|e| e.to_string())?;
    // 股票被移除后同步清理其板块成分关系
    let removed_links = tx
        .execute(
            "DELETE FROM stock_boards WHERE secid NOT IN (SELECT secid FROM stocks)",
            [],
        )
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    // 增删改自选/概念后整段重算：删除自选会连带删除股票及其全部板块成分关系，
    // 因此官方行业/行业板块/概念板块的成分也可能变化，一并重算
    let (board_count, board_rows) = refresh_board_histories(
        &conn,
        &["self:", "sw1:", "sw2:", "ths_hy:", "ths_gn:"],
    )
    .unwrap_or((0, 0));

    Ok(json!({
        "stocks": stock_count,
        "notions": notion_count,
        "members": member_count,
        "removed_stocks": removed_stocks,
        "removed_histories": removed_histories,
        "removed_links": removed_links,
        "boards": board_count,
        "board_rows": board_rows,
    }))
}

/// 读取全部股票（含 zx 标记）、概念树与概念成员，供前端回填 store
#[tauri::command]
fn db_load_watchlist(state: State<'_, Db>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT secid, name, zx, price, ratio, turnover_ratio
             FROM stocks ORDER BY zx DESC, rowid",
        )
        .map_err(|e| e.to_string())?;
    let stocks: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(json!({
                "secid": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "zx": row.get::<_, i64>(2)? == 1,
                "price": row.get::<_, Option<f64>>(3)?,
                "ratio": row.get::<_, Option<f64>>(4)?,
                "turnover_ratio": row.get::<_, Option<f64>>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, name, pid, sort_order FROM notions ORDER BY sort_order, id")
        .map_err(|e| e.to_string())?;
    let notions: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "pid": row.get::<_, Option<i64>>(2)?,
                "sort_order": row.get::<_, i64>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT notion_id, secid, sort_order FROM notion_stocks
             ORDER BY notion_id, sort_order",
        )
        .map_err(|e| e.to_string())?;
    let members: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(json!({
                "notion_id": row.get::<_, i64>(0)?,
                "secid": row.get::<_, String>(1)?,
                "sort_order": row.get::<_, i64>(2)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(json!({ "stocks": stocks, "notions": notions, "members": members }))
}

/// 实时行情批量写入 stocks（每轮刷新一个事务）。
/// 停牌/缺值字段沿用库内旧值，避免用 NULL 覆盖上一次的有效行情。
#[tauri::command]
fn db_save_quotes(state: State<'_, Db>, quotes: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&quotes).map_err(|e| format!("解析行情失败: {e}"))?;
    let list = payload.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        return Ok(json!({ "updated": 0 }));
    }

    let mut conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_ms();
    let mut updated = 0i64;

    for quote in list.iter() {
        let Some(secid) = quote.get("secid").and_then(|v| v.as_str()) else {
            continue;
        };
        if secid.is_empty() {
            continue;
        }
        let name = quote
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        tx.execute(
            "INSERT INTO stocks (secid, name, open, high, low, price, ratio, amount, turnover_ratio, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(secid) DO UPDATE SET
                 name = CASE WHEN excluded.name = '' THEN stocks.name ELSE excluded.name END,
                 open = COALESCE(excluded.open, stocks.open),
                 high = COALESCE(excluded.high, stocks.high),
                 low = COALESCE(excluded.low, stocks.low),
                 price = COALESCE(excluded.price, stocks.price),
                 ratio = COALESCE(excluded.ratio, stocks.ratio),
                 amount = COALESCE(excluded.amount, stocks.amount),
                 turnover_ratio = COALESCE(excluded.turnover_ratio, stocks.turnover_ratio),
                 updated_at = excluded.updated_at",
            params![
                secid,
                name,
                num_of(quote.get("open")),
                num_of(quote.get("high")),
                num_of(quote.get("low")),
                num_of(quote.get("price")),
                num_of(quote.get("range")),
                round2(num_of(quote.get("amount"))),
                num_of(quote.get("turn")),
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        updated += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(json!({ "updated": updated }))
}

/// 当天尚未落库时，用 stocks 的 open/high/low/price 合成一根当日K线。
/// day_start_ms 为本地零点毫秒，用来判断当天是否有行情刷新（非交易日/未开盘则不合成）。
#[tauri::command]
fn db_load_today_candle(
    state: State<'_, Db>,
    secid: String,
    today: String,
    day_start_ms: i64,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let row = conn
        .query_row(
            "SELECT price, open, high, low, updated_at, ratio, turnover_ratio FROM stocks WHERE secid = ?1",
            params![secid],
            |row| {
                Ok((
                    row.get::<_, Option<f64>>(0)?,
                    row.get::<_, Option<f64>>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                    row.get::<_, Option<f64>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<f64>>(5)?,
                    row.get::<_, Option<f64>>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((price, open, high, low, updated, ratio, turnover)) = row else {
        return Ok(json!({ "candle": null }));
    };
    let Some(price) = price else {
        return Ok(json!({ "candle": null }));
    };
    if updated.unwrap_or(0) < day_start_ms {
        return Ok(json!({ "candle": null }));
    }

    Ok(json!({
        "candle": {
            "date": today,
            "open": open.unwrap_or(price),
            "close": price,
            "high": high.unwrap_or(price),
            "low": low.unwrap_or(price),
            "volume": null,
            "amount": null,
            "ratio": ratio,
            "turnover_ratio": turnover,
        }
    }))
}

/// 申万一级/二级、同花顺行业字段写回 stocks，并同步 boards/stock_boards 的成分关系
#[tauri::command]
fn db_save_industries(state: State<'_, Db>, rows: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&rows).map_err(|e| format!("解析行业数据失败: {e}"))?;
    let list = payload.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        return Ok(json!({ "updated": 0 }));
    }

    let mut conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_ms();
    let mut updated = 0i64;

    for item in list.iter() {
        let code = item.get("code").and_then(|v| v.as_str()).unwrap_or("");
        if code.is_empty() {
            continue;
        }
        let l1 = item.get("l1").and_then(|v| v.as_str()).unwrap_or("").trim();
        let l2 = item.get("l2").and_then(|v| v.as_str()).unwrap_or("").trim();
        let ths = item.get("ths").and_then(|v| v.as_str()).unwrap_or("").trim();
        let changed = tx
            .execute(
                "UPDATE stocks SET industry1 = ?2, industry2 = ?3, ths_industry = ?4,
                     industry_updated_at = ?5
                 WHERE substr(secid, instr(secid, '.') + 1) = ?1",
                params![code, l1, l2, ths, now],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            // 库里还没有这只股票（非自选/非概念成员）时单独补一行，保证 7 天内不再重复抓取
            let secid = if code.starts_with('6') {
                format!("1.{code}")
            } else {
                format!("0.{code}")
            };
            tx.execute(
                "INSERT OR IGNORE INTO stocks
                     (secid, name, industry1, industry2, ths_industry, industry_updated_at)
                 VALUES (?1, '', ?2, ?3, ?4, ?5)",
                params![secid, l1, l2, ths, now],
            )
            .map_err(|e| e.to_string())?;
        }
        updated += 1;

        let secid = if code.starts_with('6') {
            format!("1.{code}")
        } else {
            format!("0.{code}")
        };
        // 行业变了就换板块：先清掉这只股票旧的申万关系
        tx.execute(
            "DELETE FROM stock_boards
             WHERE secid = ?1 AND (board_key LIKE 'sw1:%' OR board_key LIKE 'sw2:%')",
            params![secid],
        )
        .map_err(|e| e.to_string())?;
        if !l1.is_empty() {
            let key = format!("sw1:{l1}");
            upsert_board(&tx, &key, "sw", "industry", Some(1), None, l1, None)?;
            link_board(&tx, &secid, &key, now)?;
        }
        if !l2.is_empty() {
            let key = format!("sw2:{l2}");
            let parent = if l1.is_empty() {
                None
            } else {
                Some(format!("sw1:{l1}"))
            };
            upsert_board(
                &tx,
                &key,
                "sw",
                "industry",
                Some(2),
                None,
                l2,
                parent.as_deref(),
            )?;
            link_board(&tx, &secid, &key, now)?;
        }
        // 同花顺行业只存板块名，需要从板块全表换成 board_key（全表还没抓到时先跳过）
        tx.execute(
            "DELETE FROM stock_boards WHERE secid = ?1 AND board_key LIKE 'ths_hy:%'",
            params![secid],
        )
        .map_err(|e| e.to_string())?;
        if !ths.is_empty() {
            let key: Option<String> = tx
                .query_row(
                    "SELECT board_key FROM boards
                     WHERE source = 'ths' AND type = 'industry' AND name = ?1 LIMIT 1",
                    params![ths],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(key) = key {
                link_board(&tx, &secid, &key, now)?;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    // 行业归属变化即板块成分变化：申万一级/二级与同花顺行业的板块历史整段重算
    let (board_count, board_rows) =
        refresh_board_histories(&conn, &["sw1:", "sw2:", "ths_hy:"]).unwrap_or((0, 0));

    Ok(json!({
        "updated": updated,
        "boards": board_count,
        "board_rows": board_rows,
    }))
}

/// 按 6 位代码读取行业字段（含更新时间），供前端判断是否还在 7 天有效期内
#[tauri::command]
fn db_load_industries(state: State<'_, Db>, codes: String) -> Result<Value, String> {
    let list: Vec<String> = serde_json::from_str(&codes).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT substr(secid, instr(secid, '.') + 1), industry1, industry2,
                    ths_industry, industry_updated_at
             FROM stocks
             WHERE substr(secid, instr(secid, '.') + 1) = ?1",
        )
        .map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    for code in list {
        let code = code.trim().to_string();
        if code.is_empty() {
            continue;
        }
        let row = stmt
            .query_row(params![code], |row| {
                Ok(json!({
                    "code": row.get::<_, String>(0)?,
                    "l1": row.get::<_, Option<String>>(1)?,
                    "l2": row.get::<_, Option<String>>(2)?,
                    "ths": row.get::<_, Option<String>>(3)?,
                    "updated_at": row.get::<_, Option<i64>>(4)?,
                }))
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(row) = row {
            items.push(row);
        }
    }
    Ok(json!(items))
}

/// 读取同花顺行业板块全表，返回 { boards: {代码: 名称}, updated_at }
#[tauri::command]
fn db_load_boards(state: State<'_, Db>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT code, name, updated_at FROM boards
             WHERE source = 'ths' AND type = 'industry' AND code IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, Option<i64>)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut boards = serde_json::Map::new();
    let mut updated_at = 0i64;
    for (code, name, t) in rows {
        boards.insert(code, Value::String(name));
        if let Some(t) = t {
            updated_at = updated_at.max(t);
        }
    }
    Ok(json!({ "boards": boards, "updated_at": updated_at }))
}

/// 全量替换同花顺行业板块（只重建 source='ths' 的行业板块，概念/申万/自建板块不受影响）
#[tauri::command]
fn db_save_boards(state: State<'_, Db>, boards: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&boards).map_err(|e| format!("解析板块数据失败: {e}"))?;
    let mut conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // 旧板块的成分为 881xxx 行业，整批重建
    tx.execute(
        "DELETE FROM stock_boards WHERE board_key LIKE 'ths_hy:%'",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM boards WHERE source = 'ths' AND type = 'industry'",
        [],
    )
    .map_err(|e| e.to_string())?;

    let now = now_ms();
    let mut count = 0i64;
    if let Some(map) = payload.as_object() {
        for (code, name) in map {
            let name = name.as_str().unwrap_or("").trim();
            if code.is_empty() || name.is_empty() {
                continue;
            }
            let key = format!("ths_hy:{code}");
            upsert_board(&tx, &key, "ths", "industry", Some(1), Some(code), name, None)?;
            count += 1;
        }
    }
    // 板块名更新后补建成分关系：个股只存同花顺行业名称，行业抓取可能早于板块全表
    tx.execute(
        "INSERT OR IGNORE INTO stock_boards (secid, board_key, updated_at)
         SELECT s.secid, b.board_key, ?1
         FROM stocks s JOIN boards b
              ON b.source = 'ths' AND b.type = 'industry' AND b.name = s.ths_industry
         WHERE s.ths_industry IS NOT NULL AND s.ths_industry <> ''",
        params![now],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    // 同花顺行业板块全表重建后成分关系可能整体变化，板块历史整段重算
    let (board_count, board_rows) =
        refresh_board_histories(&conn, &["ths_hy:"]).unwrap_or((0, 0));

    Ok(json!({
        "boards": count,
        "updated_at": now,
        "history_boards": board_count,
        "history_rows": board_rows,
    }))
}

/// 读取市场宽度（sckd）：默认取库内全部交易日（2024-01-01 起），
/// 返回 { dates, rows: [{ name, code, values }] }，values 与 dates 一一对应，缺值为 null
#[tauri::command]
fn db_load_market_width(state: State<'_, Db>, days: Option<i64>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    // days 为空或 <=0 时返回全部历史（2024-01-01 起），正数表示只取最近 N 个交易日
    let limit = days.filter(|days| *days > 0).unwrap_or(-1);
    // 库内完整覆盖区间（不受展示窗口限制），前端据此决定整段补齐还是增量更新
    let (range_first, range_last): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT MIN(trade_date), MAX(trade_date) FROM sckd WHERE trade_date >= ?1",
            params![MARKET_WIDTH_MIN_DATE],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;

    let mut date_stmt = conn
        .prepare(
            "SELECT DISTINCT trade_date FROM sckd
             WHERE trade_date >= ?2
             ORDER BY trade_date DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let mut dates: Vec<String> = date_stmt
        .query_map(params![limit, MARKET_WIDTH_MIN_DATE], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    if dates.is_empty() {
        return Ok(json!({
            "dates": [],
            "rows": [],
            "range": { "first": range_first, "last": range_last },
        }));
    }
    dates.reverse();
    let first = dates.first().cloned().unwrap_or_default();

    let mut industry_stmt = conn
        .prepare(
            "SELECT industry_code, MAX(industry_name), MAX(sort_order)
             FROM sckd WHERE trade_date >= ?1
             GROUP BY industry_code
             ORDER BY MAX(sort_order), industry_code",
        )
        .map_err(|e| e.to_string())?;
    let industries: Vec<(String, String)> = industry_stmt
        .query_map(params![first], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut series: Vec<(String, String, Vec<Option<f64>>)> = industries
        .into_iter()
        .map(|(code, name)| (code, name, vec![None; dates.len()]))
        .collect();
    let mut position: HashMap<String, usize> = HashMap::new();
    for (index, (code, _, _)) in series.iter().enumerate() {
        position.insert(code.clone(), index);
    }
    let date_index: HashMap<&str, usize> = dates
        .iter()
        .enumerate()
        .map(|(index, date)| (date.as_str(), index))
        .collect();

    let mut value_stmt = conn
        .prepare(
            "SELECT trade_date, industry_code, value20 FROM sckd
             WHERE trade_date >= ?1 AND value20 IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let values: Vec<(String, String, f64)> = value_stmt
        .query_map(params![first], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    for (date, code, value) in values {
        let (Some(&row_index), Some(&col_index)) = (position.get(&code), date_index.get(date.as_str()))
        else {
            continue;
        };
        series[row_index].2[col_index] = Some(value);
    }
    drop(date_index);

    let rows: Vec<Value> = series
        .into_iter()
        .map(|(code, name, values)| json!({ "name": name, "code": code, "values": values }))
        .collect();
    Ok(json!({
        "dates": dates,
        "rows": rows,
        "range": { "first": range_first, "last": range_last },
    }))
}

/// 市场宽度写入 sckd：入参 { dates, rows: [{ name, code, values }] }，
/// 按 (交易日, 行业代码) 幂等 upsert，null 值不覆盖库内已有数据
#[tauri::command]
fn db_save_market_width(state: State<'_, Db>, payload: String) -> Result<Value, String> {
    let data: Value =
        serde_json::from_str(&payload).map_err(|e| format!("解析市场宽度失败: {e}"))?;
    let dates: Vec<String> = data
        .get("dates")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str())
                .filter(|date| *date >= MARKET_WIDTH_MIN_DATE)
                .map(|date| date.to_string())
                .collect()
        })
        .unwrap_or_default();
    let rows = data
        .get("rows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if dates.is_empty() || rows.is_empty() {
        return Ok(json!({ "saved": 0, "dates": 0 }));
    }

    let mut conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_ms();
    let mut saved = 0i64;

    for (order, row) in rows.iter().enumerate() {
        let code = row
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let name = row
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if code.is_empty() || name.is_empty() {
            continue;
        }
        let values = row.get("values").and_then(|v| v.as_array());
        for (index, date) in dates.iter().enumerate() {
            let Some(value) = values
                .and_then(|list| list.get(index))
                .and_then(|v| num_of(Some(v)))
            else {
                continue;
            };
            tx.execute(
                "INSERT INTO sckd (trade_date, industry_code, industry_name, value20, sort_order, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(trade_date, industry_code) DO UPDATE SET
                     industry_name = excluded.industry_name,
                     value20 = excluded.value20,
                     sort_order = excluded.sort_order,
                     updated_at = excluded.updated_at",
                params![date, code, name, value, order as i64, now],
            )
            .map_err(|e| e.to_string())?;
            saved += 1;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({ "saved": saved, "dates": dates.len(), "updated_at": now }))
}

/// 官方概念成分写入 boards/stock_boards（source='ths', type='concept'）。
/// 入参：[{ code: "600519", concepts: [{ code: "885761", name: "白酒" }] }]
#[tauri::command]
fn db_save_stock_concepts(state: State<'_, Db>, rows: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&rows).map_err(|e| format!("解析概念数据失败: {e}"))?;
    let list = payload.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        return Ok(json!({ "updated": 0, "relations": 0 }));
    }

    let mut conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_ms();
    let mut updated = 0i64;
    let mut relations = 0i64;

    for item in list.iter() {
        let code = item.get("code").and_then(|v| v.as_str()).unwrap_or("").trim();
        if code.is_empty() {
            continue;
        }
        let secid = if code.starts_with('6') {
            format!("1.{code}")
        } else {
            format!("0.{code}")
        };
        // 非自选/非概念成员的股票也保留一条缓存行
        tx.execute(
            "INSERT OR IGNORE INTO stocks (secid, name, updated_at) VALUES (?1, '', ?2)",
            params![secid, now],
        )
        .map_err(|e| e.to_string())?;
        // 概念归属会变化：先清掉这只股票旧的官方概念关系
        tx.execute(
            "DELETE FROM stock_boards WHERE secid = ?1 AND board_key LIKE 'ths_gn:%'",
            params![secid],
        )
        .map_err(|e| e.to_string())?;

        let empty: Vec<Value> = Vec::new();
        let concepts = item
            .get("concepts")
            .and_then(|v| v.as_array())
            .unwrap_or(&empty);
        for concept in concepts.iter() {
            let name = concept
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if name.is_empty() {
                continue;
            }
            let gn_code = concept
                .get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            // 概念代码稳定，优先用代码做键；缺失时退回名称（同花顺概念名全局唯一）
            let key = if gn_code.is_empty() {
                format!("ths_gn:{name}")
            } else {
                format!("ths_gn:{gn_code}")
            };
            let code_value = if gn_code.is_empty() {
                None
            } else {
                Some(gn_code)
            };
            upsert_board(&tx, &key, "ths", "concept", Some(1), code_value, name, None)?;
            link_board(&tx, &secid, &key, now)?;
            relations += 1;
        }
        updated += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;

    // 官方概念归属变化：概念板块历史整段重算
    let (board_count, board_rows) =
        refresh_board_histories(&conn, &["ths_gn:"]).unwrap_or((0, 0));

    Ok(json!({
        "updated": updated,
        "relations": relations,
        "boards": board_count,
        "board_rows": board_rows,
    }))
}

/// 板块单日聚合结果：涨跌幅合计、参与计算的成分数、成交额合计
#[derive(Default, Clone, Copy)]
struct DayAgg {
    sum_pct: f64,
    count: i64,
    sum_amount: f64,
}

/// 当日等权涨跌幅（小数，0.0235 表示 +2.35%）
fn day_pct_of(agg: &DayAgg) -> f64 {
    if agg.count > 0 {
        agg.sum_pct / agg.count as f64
    } else {
        0.0
    }
}

/// 按成分股日线聚合板块日线（等权平均涨跌幅 + 成交额求和）。
/// limit 为 None 取全部历史；否则每只成分股只取最近 limit+1 根（多取一根用于首日分母）。
fn accumulate_board_days(
    conn: &Connection,
    board_key: &str,
    limit: Option<i64>,
) -> Result<BTreeMap<String, DayAgg>, String> {
    let mut member_stmt = conn
        .prepare("SELECT secid FROM stock_boards WHERE board_key = ?1")
        .map_err(|e| e.to_string())?;
    let members: Vec<String> = member_stmt
        .query_map(params![board_key], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut candle_stmt = conn
        .prepare(
            "SELECT date, close, amount FROM histories
             WHERE secid = ?1 AND close IS NOT NULL AND close > 0
             ORDER BY date DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    // LIMIT -1 表示不限制（整段重算）
    let take = limit.map(|n| n + 1).unwrap_or(-1);

    let mut acc: BTreeMap<String, DayAgg> = BTreeMap::new();
    for secid in members.iter() {
        let rows: Vec<(String, f64, Option<f64>)> = candle_stmt
            .query_map(params![secid, take], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        // 查询按日期倒序，反转后逐日计算 (close / 前一日 close - 1)
        let mut prev: Option<f64> = None;
        for (date, close, amount) in rows.into_iter().rev() {
            if let Some(prev_close) = prev {
                let entry = acc.entry(date).or_default();
                entry.sum_pct += close / prev_close - 1.0;
                entry.count += 1;
                if let Some(amount) = amount {
                    entry.sum_amount += amount;
                }
            }
            prev = Some(close);
        }
    }
    Ok(acc)
}

/// 整段重算板块日线：以最早一天 100 为基准，逐日累乘等权涨跌幅后落库。
/// 成分股或复权基准变化后历史涨跌幅会整体变化，必须走整段重算。
fn full_rebuild_board_history(conn: &Connection, board_key: &str) -> Result<i64, String> {
    let acc = accumulate_board_days(conn, board_key, None)?;
    conn.execute(
        "DELETE FROM board_histories WHERE board_key = ?1",
        params![board_key],
    )
    .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "INSERT OR REPLACE INTO board_histories (board_key, date, close, pct, amount, members)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .map_err(|e| e.to_string())?;
    let mut index = 100.0f64;
    let mut rows = 0i64;
    for (date, agg) in acc.iter() {
        let day_pct = day_pct_of(agg);
        index *= 1.0 + day_pct;
        stmt.execute(params![
            board_key,
            date,
            index,
            day_pct * 100.0,
            agg.sum_amount,
            agg.count
        ])
        .map_err(|e| e.to_string())?;
        rows += 1;
    }
    Ok(rows)
}

/// 增量刷新最近 days 个交易日：以首个增量日之前已存的收盘指数为基准向后累乘。
/// 没有基准（首次计算或窗口超出已有历史）时退回整段重算，保证结果与整段重算一致。
fn incremental_update_board_history(
    conn: &Connection,
    board_key: &str,
    days: i64,
) -> Result<i64, String> {
    let acc = accumulate_board_days(conn, board_key, Some(days))?;
    if acc.is_empty() {
        return full_rebuild_board_history(conn, board_key);
    }
    let dates: Vec<String> = acc.keys().cloned().collect();
    let start = dates.len().saturating_sub(days.max(1) as usize);
    let first = dates[start].clone();
    let base: Option<f64> = conn
        .query_row(
            "SELECT close FROM board_histories
             WHERE board_key = ?1 AND date < ?2
             ORDER BY date DESC LIMIT 1",
            params![board_key, first],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(mut index) = base else {
        return full_rebuild_board_history(conn, board_key);
    };

    conn.execute(
        "DELETE FROM board_histories WHERE board_key = ?1 AND date >= ?2",
        params![board_key, first],
    )
    .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "INSERT OR REPLACE INTO board_histories (board_key, date, close, pct, amount, members)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = 0i64;
    for date in dates[start..].iter() {
        let agg = &acc[date];
        let day_pct = day_pct_of(agg);
        index *= 1.0 + day_pct;
        stmt.execute(params![
            board_key,
            date,
            index,
            day_pct * 100.0,
            agg.sum_amount,
            agg.count
        ])
        .map_err(|e| e.to_string())?;
        rows += 1;
    }
    Ok(rows)
}

/// 从指定日期起重算板块尾段：该日之前的落库数据保持不动，
/// 以该日之前最近一条已存收盘指数为基准向后累乘。
/// 若中间缺行（数据被整体改写）则退回整段重算，保证与整段结果一致。
fn rebuild_board_history_from(
    conn: &Connection,
    board_key: &str,
    from_date: &str,
) -> Result<i64, String> {
    let tail_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM board_histories WHERE board_key = ?1 AND date >= ?2",
            params![board_key, from_date],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    // 多留 5 天余量，覆盖写入日之后新追加的交易日
    let acc = accumulate_board_days(conn, board_key, Some(tail_count.max(1) + 5))?;
    let dates: Vec<String> = acc
        .keys()
        .filter(|d| d.as_str() >= from_date)
        .cloned()
        .collect();
    let Some(first) = dates.first().cloned() else {
        return full_rebuild_board_history(conn, board_key);
    };

    let gap: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM board_histories
             WHERE board_key = ?1 AND date >= ?2 AND date < ?3",
            params![board_key, from_date, first],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if gap > 0 {
        return full_rebuild_board_history(conn, board_key);
    }

    let base: Option<f64> = conn
        .query_row(
            "SELECT close FROM board_histories
             WHERE board_key = ?1 AND date < ?2
             ORDER BY date DESC LIMIT 1",
            params![board_key, first],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(mut index) = base else {
        return full_rebuild_board_history(conn, board_key);
    };

    conn.execute(
        "DELETE FROM board_histories WHERE board_key = ?1 AND date >= ?2",
        params![board_key, first],
    )
    .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "INSERT OR REPLACE INTO board_histories (board_key, date, close, pct, amount, members)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = 0i64;
    for date in dates.iter() {
        let agg = &acc[date];
        let day_pct = day_pct_of(agg);
        index *= 1.0 + day_pct;
        stmt.execute(params![
            board_key,
            date,
            index,
            day_pct * 100.0,
            agg.sum_amount,
            agg.count
        ])
        .map_err(|e| e.to_string())?;
        rows += 1;
    }
    Ok(rows)
}

/// 某只成分股日线被改写后，重算包含它的板块历史。
/// from_date 为改写的起始日期：None 表示复权基准变动（整段重算），
/// Some(d) 表示只从该日（含）向后重算尾段。
fn refresh_boards_for_secid(
    conn: &Connection,
    secid: &str,
    from_date: Option<&str>,
) -> Result<(i64, i64), String> {
    let mut stmt = conn
        .prepare("SELECT board_key FROM stock_boards WHERE secid = ?1")
        .map_err(|e| e.to_string())?;
    let keys: Vec<String> = stmt
        .query_map(params![secid], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut boards = 0i64;
    let mut rows = 0i64;
    for key in keys.iter() {
        rows += match from_date {
            None => full_rebuild_board_history(conn, key)?,
            Some(date) => rebuild_board_history_from(conn, key, date)?,
        };
        boards += 1;
    }
    Ok((boards, rows))
}

/// 清理已不存在板块（boards 中已删除）的板块日线残留
fn clean_orphan_board_histories(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM board_histories WHERE board_key NOT IN (SELECT board_key FROM boards)",
        [],
    )
    .map_err(|e| e.to_string())
}

/// 指定前缀（如 self:/ths_gn:）的板块在成分变化后整段重算，返回 (板块数, 写入行数)
fn refresh_board_histories(conn: &Connection, prefixes: &[&str]) -> Result<(i64, i64), String> {
    let mut keys: Vec<String> = Vec::new();
    for prefix in prefixes {
        let pattern = format!("{prefix}%");
        let mut stmt = conn
            .prepare("SELECT board_key FROM boards WHERE board_key LIKE ?1")
            .map_err(|e| e.to_string())?;
        let list: Vec<String> = stmt
            .query_map(params![pattern], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        keys.extend(list);
    }
    keys.sort();
    keys.dedup();

    let mut boards = 0i64;
    let mut rows = 0i64;
    for key in keys.iter() {
        rows += full_rebuild_board_history(conn, key)?;
        boards += 1;
    }
    clean_orphan_board_histories(conn)?;
    Ok((boards, rows))
}

/// 启动时幂等刷新板块日线（默认最近 5 个交易日）：已有数据的板块增量补齐，
/// 尚未计算过的板块整段重算；顺带清理已不存在板块的残留。
#[tauri::command]
fn db_refresh_board_history(state: State<'_, Db>, days: Option<i64>) -> Result<Value, String> {
    let days = days.unwrap_or(5).clamp(1, 60);
    let conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let orphans = clean_orphan_board_histories(&conn)?;

    let mut stmt = conn
        .prepare(
            "SELECT b.board_key,
                    (SELECT COUNT(*) FROM board_histories h WHERE h.board_key = b.board_key)
             FROM boards b ORDER BY b.board_key",
        )
        .map_err(|e| e.to_string())?;
    let list: Vec<(String, i64)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let board_count = list.len() as i64;

    let mut refreshed = 0i64;
    let mut rebuilt = 0i64;
    let mut rows = 0i64;
    for (key, stored) in list.iter() {
        if *stored == 0 {
            rows += full_rebuild_board_history(&conn, key)?;
            rebuilt += 1;
        } else {
            rows += incremental_update_board_history(&conn, key, days)?;
            refreshed += 1;
        }
    }

    Ok(json!({
        "days": days,
        "boards": board_count,
        "refreshed": refreshed,
        "rebuilt": rebuilt,
        "rows": rows,
        "orphans": orphans,
    }))
}

/// EMA 序列（首个值作为种子），与前端 src/utils/macd.js 的 ema 口径一致
fn ema_series(values: &[f64], period: usize) -> Vec<f64> {
    let k = 2.0 / (period as f64 + 1.0);
    let mut out = Vec::with_capacity(values.len());
    let mut prev = 0.0f64;
    for (i, value) in values.iter().enumerate() {
        prev = if i == 0 { *value } else { value * k + prev * (1.0 - k) };
        out.push(prev);
    }
    out
}

/// MACD 柱（DIF-DEA）最近一段连续同号天数：正数=红柱天数，负数=绿柱天数，0=末根为 0
fn macd_sign_days(closes: &[f64]) -> i64 {
    let fast = ema_series(closes, 12);
    let slow = ema_series(closes, 26);
    let difs: Vec<f64> = fast.iter().zip(slow.iter()).map(|(a, b)| a - b).collect();
    let deas = ema_series(&difs, 9);
    let hist: Vec<f64> = difs.iter().zip(deas.iter()).map(|(d, e)| d - e).collect();
    let Some(last) = hist.last() else {
        return 0;
    };
    if !last.is_finite() || *last == 0.0 {
        return 0;
    }
    let positive = *last > 0.0;
    let mut count = 0i64;
    for value in hist.iter().rev() {
        if !value.is_finite() || *value == 0.0 || (*value > 0.0) != positive {
            break;
        }
        count += 1;
    }
    if positive {
        count
    } else {
        -count
    }
}

/// 板块列表（板块页与图表页左侧列表）：
/// scope='sw' 返回申万一级/二级，其它返回同花顺行业板块；
/// 每项带成分股 secid（前端据此按实时行情算涨跌幅/换手率）与板块指数 MACD 连击天数。
#[tauri::command]
fn db_load_board_list(state: State<'_, Db>, scope: String) -> Result<Value, String> {
    let conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let second_like = if scope == "sw" { "sw2:%" } else { "" };
    let mut stmt = conn
        .prepare(
            "SELECT board_key, name, level, parent_key FROM boards
             WHERE board_key LIKE ?1 OR board_key LIKE ?2
             ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let list: Vec<(String, String, Option<i64>, Option<String>)> = stmt
        .query_map(params![if scope == "sw" { "sw1:%" } else { "ths_hy:%" }, second_like], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut member_stmt = conn
        .prepare("SELECT secid FROM stock_boards WHERE board_key = ?1 ORDER BY secid")
        .map_err(|e| e.to_string())?;
    let mut close_stmt = conn
        .prepare(
            "SELECT close FROM board_histories
             WHERE board_key = ?1 AND close IS NOT NULL ORDER BY date",
        )
        .map_err(|e| e.to_string())?;

    let mut boards = Vec::new();
    for (key, name, level, parent) in list {
        let members: Vec<String> = member_stmt
            .query_map(params![key], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        // 同花顺行业板块是全量目录，本地没有成分股的板块既算不出行情也没有 MACD，直接不列出
        if members.is_empty() {
            continue;
        }
        // 板块尚未计算过历史时先整段重算，保证 MACD 有数据
        let stored: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM board_histories WHERE board_key = ?1",
                params![key],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if stored == 0 {
            full_rebuild_board_history(&conn, &key)?;
        }
        let closes: Vec<f64> = close_stmt
            .query_map(params![key], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        // 数据太短的 EMA 结果没有参考价值，前端按「-」展示
        let macd = if closes.len() >= 60 {
            Some(macd_sign_days(&closes))
        } else {
            None
        };
        boards.push(json!({
            "board_key": key,
            "name": name,
            "level": level,
            "parent_key": parent,
            "members": members,
            "macd": macd,
        }));
    }
    Ok(json!({ "boards": boards }))
}

/// 板块日K：读 board_histories（成分股等权平均落库结果）。
/// pct 为百分数（2.35 表示 +2.35%），close 为以 100 为基准累乘的等权指数。
/// 板块首次被访问且尚无落库数据时先整段重算一次。
#[tauri::command]
fn db_load_board_k(
    state: State<'_, Db>,
    board_key: String,
    limit: Option<i64>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let board = conn
        .query_row(
            "SELECT name, source, type, level FROM boards WHERE board_key = ?1",
            params![board_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((name, source, kind, level)) = board else {
        return Ok(json!({
            "board": null, "dates": [], "close": [], "pct": [], "amount": [], "members": 0
        }));
    };

    let limit = limit.unwrap_or(250).clamp(1, 2000);
    let stored: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM board_histories WHERE board_key = ?1",
            params![board_key],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if stored == 0 {
        full_rebuild_board_history(&conn, &board_key)?;
    }

    let members: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM stock_boards WHERE board_key = ?1",
            params![board_key],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT date, close, pct, amount FROM board_histories
             WHERE board_key = ?1 ORDER BY date DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, Option<f64>, Option<f64>, Option<f64>)> = stmt
        .query_map(params![board_key, limit], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut dates = Vec::new();
    let mut close = Vec::new();
    let mut pct = Vec::new();
    let mut amount = Vec::new();
    for (date, c, p, a) in rows.into_iter().rev() {
        dates.push(date);
        close.push(round2(c));
        pct.push(round2(p));
        amount.push(a.unwrap_or(0.0));
    }

    Ok(json!({
        "board": {
            "board_key": board_key,
            "name": name,
            "source": source,
            "type": kind,
            "level": level,
        },
        "dates": dates,
        "close": close,
        "pct": pct,
        "amount": amount,
        "members": members,
    }))
}

/// 写入一批日K（同一 secid + date 覆盖），amount 由元换算为亿，不做小数舍入
fn write_candles(
    tx: &rusqlite::Transaction,
    secid: &str,
    list: &[Value],
) -> Result<i64, String> {
    let mut stmt = tx
        .prepare(
            "INSERT INTO histories (secid, date, open, close, high, low, volume, amount, ratio, turnover_ratio)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(secid, date) DO UPDATE SET
                 open = excluded.open,
                 close = excluded.close,
                 high = excluded.high,
                 low = excluded.low,
                 volume = excluded.volume,
                 amount = excluded.amount,
                 ratio = excluded.ratio,
                 turnover_ratio = excluded.turnover_ratio",
        )
        .map_err(|e| e.to_string())?;
    let mut saved = 0i64;
    for candle in list.iter() {
        let date = candle.get("date").and_then(|v| v.as_str()).unwrap_or("");
        // 早于统一起点的K线（腾讯兜底可能返回 beg 之前的远古数据）一律不入库
        if date.is_empty() || date < HISTORY_MIN_DATE {
            continue;
        }
        stmt.execute(params![
            secid,
            date,
            num_of(candle.get("open")),
            num_of(candle.get("close")),
            num_of(candle.get("high")),
            num_of(candle.get("low")),
            num_of(candle.get("volume")),
            num_of(candle.get("amount")).map(|v| v / 1e8),
            num_of(candle.get("ratio")),
            num_of(candle.get("turnover_ratio")),
        ])
        .map_err(|e| e.to_string())?;
        saved += 1;
    }
    Ok(saved)
}

/// 日 K 线批量落库（按 secid + date 去重）
#[tauri::command]
fn db_save_history(
    state: State<'_, Db>,
    secid: String,
    candles: String,
) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&candles).map_err(|e| format!("解析K线数据失败: {e}"))?;
    let list = payload.as_array().cloned().unwrap_or_default();
    if list.is_empty() || secid.is_empty() {
        return Ok(json!({ "saved": 0 }));
    }

    let mut conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let saved = write_candles(&tx, &secid, &list)?;
    tx.commit().map_err(|e| e.to_string())?;

    // 成分股日线被改写：从最早写入日向后重算相关板块的尾段历史
    let first_date = list
        .iter()
        .filter_map(|c| c.get("date").and_then(|v| v.as_str()))
        .filter(|d| !d.is_empty())
        .min()
        .map(|d| d.to_string());
    let (board_count, board_rows) = match first_date.as_deref() {
        Some(date) => refresh_boards_for_secid(&conn, &secid, Some(date)).unwrap_or((0, 0)),
        None => (0, 0),
    };

    Ok(json!({ "saved": saved, "boards": board_count, "board_rows": board_rows }))
}

/// 全量替换某股票的日K：先按 secid 删除，再写入（用于复权基准变动后的重拉）
#[tauri::command]
fn db_replace_history(
    state: State<'_, Db>,
    secid: String,
    candles: String,
) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&candles).map_err(|e| format!("解析K线数据失败: {e}"))?;
    let list = payload.as_array().cloned().unwrap_or_default();
    if list.is_empty() || secid.is_empty() {
        return Ok(json!({ "saved": 0 }));
    }

    let mut conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let removed = tx
        .execute("DELETE FROM histories WHERE secid = ?1", params![secid])
        .map_err(|e| e.to_string())?;
    let saved = write_candles(&tx, &secid, &list)?;
    tx.commit().map_err(|e| e.to_string())?;

    // 整段重拉（复权基准变动）会改写已有历史涨跌幅，包含该股的板块必须整段重算
    let (board_count, board_rows) =
        refresh_boards_for_secid(&conn, &secid, None).unwrap_or((0, 0));

    Ok(json!({
        "removed": removed,
        "saved": saved,
        "boards": board_count,
        "board_rows": board_rows,
    }))
}

/// 自选股票（zx=1）及其本地日K最新日期，供启动时补齐
#[tauri::command]
fn db_history_targets(state: State<'_, Db>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT s.secid,
                    (SELECT MAX(h.date) FROM histories h WHERE h.secid = s.secid),
                    (SELECT h.turnover_ratio FROM histories h
                     WHERE h.secid = s.secid ORDER BY h.date DESC LIMIT 1),
                    (SELECT h.volume FROM histories h
                     WHERE h.secid = s.secid ORDER BY h.date DESC LIMIT 1)
             FROM stocks s
             WHERE s.zx = 1 OR EXISTS (SELECT 1 FROM histories h2 WHERE h2.secid = s.secid)
             ORDER BY s.rowid",
        )
        .map_err(|e| e.to_string())?;
    let targets: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(json!({
                "secid": row.get::<_, String>(0)?,
                "last_date": row.get::<_, Option<String>>(1)?,
                "latest_turnover": row.get::<_, Option<f64>>(2)?,
                "latest_volume": row.get::<_, Option<f64>>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(json!({ "targets": targets }))
}

/// 读取本地日 K（升序），接口不可用时作为兜底；amount 单位仍为亿
#[tauri::command]
fn db_load_history(
    state: State<'_, Db>,
    secid: String,
    limit: i64,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let limit = if limit <= 0 { 400 } else { limit.min(5000) };
    let mut stmt = conn
        .prepare(
            "SELECT date, open, close, high, low, volume, amount, ratio, turnover_ratio FROM histories
             WHERE secid = ?1
             ORDER BY date DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let mut list: Vec<Value> = stmt
        .query_map(params![secid, limit], |row| {
            Ok(json!({
                "date": row.get::<_, String>(0)?,
                "open": row.get::<_, Option<f64>>(1)?,
                "close": row.get::<_, Option<f64>>(2)?,
                "high": row.get::<_, Option<f64>>(3)?,
                "low": row.get::<_, Option<f64>>(4)?,
                "volume": row.get::<_, Option<f64>>(5)?,
                "amount": row.get::<_, Option<f64>>(6)?,
                "ratio": row.get::<_, Option<f64>>(7)?,
                "turnover_ratio": row.get::<_, Option<f64>>(8)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    list.reverse();

    Ok(json!({ "candles": list }))
}

/// 迁移结果概览，便于调试与验证
#[tauri::command]
fn db_stats(state: State<'_, Db>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(|e| format!("数据库占用异常: {e}"))?;
    let stocks: i64 = conn
        .query_row("SELECT COUNT(*) FROM stocks", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let notions: i64 = conn
        .query_row("SELECT COUNT(*) FROM notions", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let members: i64 = conn
        .query_row("SELECT COUNT(*) FROM notion_stocks", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let histories: i64 = conn
        .query_row("SELECT COUNT(*) FROM histories", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let boards: i64 = conn
        .query_row("SELECT COUNT(*) FROM boards", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let links: i64 = conn
        .query_row("SELECT COUNT(*) FROM stock_boards", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let migrated = conn
        .query_row("SELECT value FROM meta WHERE key = 'migrated_v1'", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();

    Ok(json!({
        "stocks": stocks,
        "notions": notions,
        "members": members,
        "histories": histories,
        "boards": boards,
        "links": links,
        "migrated": migrated,
    }))
}

/// 窗口是否有一块足够大的区域落在某个显示器内
fn is_visible_on_screen(main: &tauri::WebviewWindow) -> bool {
    let (Ok(pos), Ok(size), Ok(monitors)) = (
        main.outer_position(),
        main.outer_size(),
        main.available_monitors(),
    ) else {
        return true;
    };
    monitors.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        let overlap_x =
            (pos.x + size.width as i32).min(mp.x + ms.width as i32) - pos.x.max(mp.x);
        let overlap_y =
            (pos.y + size.height as i32).min(mp.y + ms.height as i32) - pos.y.max(mp.y);
        overlap_x > 80 && overlap_y > 40
    })
}

/// 显示主窗口：若窗口被折叠或移动到屏幕外，先还原再居中，避免“点了图标却看不到”
fn reveal_main(app: &tauri::AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let _ = main.unminimize();
    let _ = main.show();
    if !is_visible_on_screen(&main) {
        let _ = main.unmaximize();
        let _ = main.center();
    }
    let _ = main.set_focus();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            reveal_main(app);
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            app_info,
            db_migrate_watchgroup,
            db_save_watchgroup,
            db_load_watchlist,
            db_save_quotes,
            db_load_today_candle,
            db_save_industries,
            db_load_industries,
            db_load_boards,
            db_save_boards,
            db_save_stock_concepts,
            db_load_market_width,
            db_save_market_width,
            db_refresh_board_history,
            db_load_board_list,
            db_load_board_k,
            db_save_history,
            db_replace_history,
            db_history_targets,
            db_load_history,
            db_stats
        ])
        .on_window_event(|window, event| {
            // 主窗口点关闭时最小化到托盘，托盘菜单“退出”才是真正退出
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let conn = open_db(app.handle())?;
            app.manage(Db(Mutex::new(conn)));

            if let Some(main) = app.get_webview_window("main") {
                let _ = main.set_always_on_top(true);
                let _ = main.set_skip_taskbar(true);
            }

            let show = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("趋势")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => reveal_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        reveal_main(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running 趋势");
}
