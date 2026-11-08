#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use mysql::prelude::Queryable;
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, State, WindowEvent, Emitter,
};

const APP_VERSION: &str = env!("QS_VERSION");
const APP_BUILD_DATE: &str = env!("QS_BUILD_DATE");

/// 运行时数据库后端。启动时未配置则为 None，业务命令返回「数据库尚未配置」。
enum Backend {
    Sqlite(Connection),
    Mysql(mysql::Pool),
}

/// 数据库连接由主进程持有：SQLite 走单连接串行访问，MySQL 走连接池。
/// 所有命令通过 `Db::with_conn` 获取会话，未配置时统一报错。
struct Db {
    backend: Mutex<Option<Backend>>,
    error: Mutex<Option<String>>,
}

impl Db {
    fn new(backend: Option<Backend>, error: Option<String>) -> Self {
        Self {
            backend: Mutex::new(backend),
            error: Mutex::new(error),
        }
    }

    fn configured(&self) -> bool {
        self.backend
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    fn last_error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|guard| guard.clone())
    }

    fn set_error(&self, message: Option<String>) {
        if let Ok(mut guard) = self.error.lock() {
            *guard = message;
        }
    }

    fn replace_backend(&self, backend: Backend) -> Result<(), String> {
        let mut guard = self
            .backend
            .lock()
            .map_err(|e| format!("数据库占用异常: {e}"))?;
        *guard = Some(backend);
        Ok(())
    }

    /// 在持有后端锁的期间执行一段数据库操作，保证 MySQL 事务始终使用同一条连接。
    fn with_conn<T>(
        &self,
        f: impl FnOnce(&mut dyn SqlSession) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .backend
            .lock()
            .map_err(|e| format!("数据库占用异常: {e}"))?;
        match guard.as_mut() {
            None => Err("数据库尚未配置".to_string()),
            Some(Backend::Sqlite(conn)) => {
                let mut session = SqliteSession { conn };
                f(&mut session)
            }
            Some(Backend::Mysql(pool)) => {
                let mut conn = pool
                    .get_conn()
                    .map_err(|e| format!("数据库连接失败: {e}"))?;
                let mut session = MysqlSession { conn: &mut conn };
                f(&mut session)
            }
        }
    }

    /// 在同一个会话里开启事务；成功提交，任何失败自动回滚。
    fn with_tx<T>(
        &self,
        f: impl FnOnce(&mut dyn SqlSession) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_conn(|conn| {
            conn.begin()?;
            match f(conn) {
                Ok(value) => {
                    conn.commit()?;
                    Ok(value)
                }
                Err(error) => {
                    let _ = conn.rollback();
                    Err(error)
                }
            }
        })
    }
}

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

/// v8 -> v9：histories 重建为 ratio（涨跌幅，%）与 turnover_ratio（换手率，%）结构，
/// 重建语句里暂时去掉旧 volume 列；随后由 init 的兜底 ALTER 重新加回并按需回填
/// （前端K线仍需要成交量），成交额不再按两位小数存储（显示精度由前端控制）
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
    pre_close REAL,
    price_diff REAL,
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

/* 日历事件：start_date/end_date 为首次发生的区间，重复时按首次日号与持续天数向后推 */
CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    repeat_type TEXT NOT NULL DEFAULT 'none',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_calendar_events_start ON calendar_events(start_date);

/* 软件设置：数据库为唯一持久化来源，key='setting' 存整份设置 JSON */
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
);

/* 个股持仓/提醒配置：每只股票一行，config 为整份配置 JSON */
CREATE TABLE IF NOT EXISTS symbol_configs (
    secid TEXT PRIMARY KEY,
    config TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
);

/* 非交易日：只记录休市日期（含周末），交易日 = 周一至周五 - 本表日期 */
CREATE TABLE IF NOT EXISTS non_trading_days (
    date TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    confirmed_at INTEGER NOT NULL DEFAULT 0
);

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

// ---------------------------------------------------------------------------
// SQL 会话抽象：SQLite 与 MySQL 共用一套命令实现，方言差异在会话层处理
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum SqlVal {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
}

trait ToSqlVal {
    fn to_sql_val(&self) -> SqlVal;
}

impl ToSqlVal for str {
    fn to_sql_val(&self) -> SqlVal {
        SqlVal::Text(self.to_string())
    }
}

impl ToSqlVal for &str {
    fn to_sql_val(&self) -> SqlVal {
        SqlVal::Text((*self).to_string())
    }
}

impl ToSqlVal for String {
    fn to_sql_val(&self) -> SqlVal {
        SqlVal::Text(self.clone())
    }
}

impl ToSqlVal for &String {
    fn to_sql_val(&self) -> SqlVal {
        SqlVal::Text((*self).clone())
    }
}

impl ToSqlVal for i64 {
    fn to_sql_val(&self) -> SqlVal {
        SqlVal::Int(*self)
    }
}

impl ToSqlVal for i32 {
    fn to_sql_val(&self) -> SqlVal {
        SqlVal::Int(*self as i64)
    }
}

impl ToSqlVal for u32 {
    fn to_sql_val(&self) -> SqlVal {
        SqlVal::Int(*self as i64)
    }
}

impl ToSqlVal for u16 {
    fn to_sql_val(&self) -> SqlVal {
        SqlVal::Int(*self as i64)
    }
}

impl ToSqlVal for usize {
    fn to_sql_val(&self) -> SqlVal {
        SqlVal::Int(*self as i64)
    }
}

impl ToSqlVal for bool {
    fn to_sql_val(&self) -> SqlVal {
        SqlVal::Int(if *self { 1 } else { 0 })
    }
}

impl ToSqlVal for f64 {
    fn to_sql_val(&self) -> SqlVal {
        SqlVal::Real(*self)
    }
}

impl ToSqlVal for f32 {
    fn to_sql_val(&self) -> SqlVal {
        SqlVal::Real(*self as f64)
    }
}

impl<T: ToSqlVal> ToSqlVal for Option<T> {
    fn to_sql_val(&self) -> SqlVal {
        match self {
            Some(value) => value.to_sql_val(),
            None => SqlVal::Null,
        }
    }
}

fn to_sql_val<T: ToSqlVal + ?Sized>(value: &T) -> SqlVal {
    value.to_sql_val()
}

macro_rules! p {
    () => { Vec::<SqlVal>::new() };
    ($($x:expr),+ $(,)?) => {
        vec![$(to_sql_val(&$x)),+]
    };
}

/// 与旧 rusqlite `params!` 用法保持一致，但生成的是后端无关的参数列表。
macro_rules! params {
    () => { Vec::<SqlVal>::new() };
    ($($x:expr),+ $(,)?) => {
        vec![$(to_sql_val(&$x)),+]
    };
}

struct DbRow {
    values: Vec<SqlVal>,
}

fn conversion_error(index: usize, message: &str) -> rusqlite::Error {
    rusqlite::Error::InvalidColumnType(
        index,
        message.to_string(),
        rusqlite::types::Type::Null,
    )
}

trait FromSqlVal: Sized {
    fn from_sql_val(value: &SqlVal) -> rusqlite::Result<Self>;
}

impl FromSqlVal for String {
    fn from_sql_val(value: &SqlVal) -> rusqlite::Result<Self> {
        match value {
            SqlVal::Text(text) => Ok(text.clone()),
            SqlVal::Int(number) => Ok(number.to_string()),
            SqlVal::Real(number) => Ok(number.to_string()),
            SqlVal::Null => Err(conversion_error(0, "NULL 不能转换为字符串")),
        }
    }
}

impl FromSqlVal for i64 {
    fn from_sql_val(value: &SqlVal) -> rusqlite::Result<Self> {
        match value {
            SqlVal::Int(number) => Ok(*number),
            SqlVal::Real(number) => Ok(*number as i64),
            SqlVal::Text(text) => text
                .trim()
                .parse::<i64>()
                .map_err(|_| conversion_error(0, "文本不能转换为整数")),
            SqlVal::Null => Err(conversion_error(0, "NULL 不能转换为整数")),
        }
    }
}

impl FromSqlVal for f64 {
    fn from_sql_val(value: &SqlVal) -> rusqlite::Result<Self> {
        match value {
            SqlVal::Int(number) => Ok(*number as f64),
            SqlVal::Real(number) => Ok(*number),
            SqlVal::Text(text) => text
                .trim()
                .parse::<f64>()
                .map_err(|_| conversion_error(0, "文本不能转换为浮点数")),
            SqlVal::Null => Err(conversion_error(0, "NULL 不能转换为浮点数")),
        }
    }
}

impl<T: FromSqlVal> FromSqlVal for Option<T> {
    fn from_sql_val(value: &SqlVal) -> rusqlite::Result<Self> {
        match value {
            SqlVal::Null => Ok(None),
            _ => T::from_sql_val(value).map(Some),
        }
    }
}

trait RowIndex {
    fn to_index(&self) -> usize;
}

impl RowIndex for usize {
    fn to_index(&self) -> usize {
        *self
    }
}

impl RowIndex for i64 {
    fn to_index(&self) -> usize {
        *self as usize
    }
}

impl RowIndex for i32 {
    fn to_index(&self) -> usize {
        *self as usize
    }
}

impl RowIndex for u32 {
    fn to_index(&self) -> usize {
        *self as usize
    }
}

impl DbRow {
    fn get<I: RowIndex, T: FromSqlVal>(&self, index: I) -> rusqlite::Result<T> {
        let index = index.to_index();
        let value = self
            .values
            .get(index)
            .ok_or_else(|| conversion_error(index, "列不存在"))?;
        T::from_sql_val(value)
    }
}

fn sqlite_to_sql_val(value: rusqlite::types::Value) -> SqlVal {
    match value {
        rusqlite::types::Value::Null => SqlVal::Null,
        rusqlite::types::Value::Integer(number) => SqlVal::Int(number),
        rusqlite::types::Value::Real(number) => SqlVal::Real(number),
        rusqlite::types::Value::Text(text) => SqlVal::Text(text),
        rusqlite::types::Value::Blob(bytes) => {
            SqlVal::Text(String::from_utf8_lossy(&bytes).into_owned())
        }
    }
}

fn sql_val_to_sqlite(value: &SqlVal) -> rusqlite::types::Value {
    match value {
        SqlVal::Null => rusqlite::types::Value::Null,
        SqlVal::Int(number) => rusqlite::types::Value::Integer(*number),
        SqlVal::Real(number) => rusqlite::types::Value::Real(*number),
        SqlVal::Text(text) => rusqlite::types::Value::Text(text.clone()),
    }
}

fn mysql_to_sql_val(value: mysql::Value) -> SqlVal {
    match value {
        mysql::Value::NULL => SqlVal::Null,
        mysql::Value::Int(number) => SqlVal::Int(number),
        mysql::Value::UInt(number) => SqlVal::Int(number as i64),
        mysql::Value::Float(number) => SqlVal::Real(number as f64),
        mysql::Value::Double(number) => SqlVal::Real(number),
        mysql::Value::Bytes(bytes) => SqlVal::Text(String::from_utf8_lossy(&bytes).into_owned()),
        other => SqlVal::Text(format!("{other:?}")),
    }
}

fn sql_val_to_mysql(value: SqlVal) -> mysql::Value {
    match value {
        SqlVal::Null => mysql::Value::NULL,
        SqlVal::Int(number) => mysql::Value::Int(number),
        SqlVal::Real(number) => mysql::Value::Double(number),
        SqlVal::Text(text) => mysql::Value::Bytes(text.into_bytes()),
    }
}

/// 把 `?1`/`?2` 占位符重写为按出现顺序排列的 `?`，同时重排参数。
/// MySQL 只支持顺序占位符，SQLite 也按同一套规则执行，保证两种后端参数顺序一致。
fn expand_placeholders(sql: &str, params: &[SqlVal]) -> Result<(String, Vec<SqlVal>), String> {
    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(sql.len());
    let mut values = Vec::with_capacity(params.len());
    let mut last = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'?' {
            let mut end = index + 1;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            let position = if end > index + 1 {
                sql[index + 1..end]
                    .parse::<usize>()
                    .map_err(|_| "SQL 占位符解析失败".to_string())?
            } else {
                values.len() + 1
            };
            let value = params
                .get(position.saturating_sub(1))
                .cloned()
                .ok_or_else(|| format!("SQL 参数 ?{position} 缺失"))?;
            out.push_str(&sql[last..index]);
            out.push('?');
            values.push(value);
            last = end;
            index = end;
            continue;
        }
        index += 1;
    }
    out.push_str(&sql[last..]);
    Ok((out, values))
}

trait SqlSession {
    fn is_mysql(&self) -> bool;
    fn execute(&mut self, sql: &str, params: Vec<SqlVal>) -> Result<usize, String>;
    fn query(&mut self, sql: &str, params: Vec<SqlVal>) -> Result<Vec<DbRow>, String>;
    fn query_one(&mut self, sql: &str, params: Vec<SqlVal>) -> Result<Option<DbRow>, String> {
        Ok(self.query(sql, params)?.into_iter().next())
    }
    fn execute_d(
        &mut self,
        sqlite_sql: &str,
        mysql_sql: &str,
        params: Vec<SqlVal>,
    ) -> Result<usize, String> {
        if self.is_mysql() {
            self.execute(mysql_sql, params)
        } else {
            self.execute(sqlite_sql, params)
        }
    }
    fn query_d(
        &mut self,
        sqlite_sql: &str,
        mysql_sql: &str,
        params: Vec<SqlVal>,
    ) -> Result<Vec<DbRow>, String> {
        if self.is_mysql() {
            self.query(mysql_sql, params)
        } else {
            self.query(sqlite_sql, params)
        }
    }
    fn query_one_d(
        &mut self,
        sqlite_sql: &str,
        mysql_sql: &str,
        params: Vec<SqlVal>,
    ) -> Result<Option<DbRow>, String> {
        if self.is_mysql() {
            self.query_one(mysql_sql, params)
        } else {
            self.query_one(sqlite_sql, params)
        }
    }
    fn begin(&mut self) -> Result<(), String>;
    fn commit(&mut self) -> Result<(), String>;
    fn rollback(&mut self) -> Result<(), String>;
    fn last_insert_id(&mut self) -> Result<i64, String>;
}

struct SqliteSession<'a> {
    conn: &'a mut Connection,
}

impl<'a> SqlSession for SqliteSession<'a> {
    fn is_mysql(&self) -> bool {
        false
    }

    fn execute(&mut self, sql: &str, params: Vec<SqlVal>) -> Result<usize, String> {
        let (sql, values) = expand_placeholders(sql, &params)?;
        let values: Vec<rusqlite::types::Value> =
            values.iter().map(sql_val_to_sqlite).collect();
        self.conn
            .execute(&sql, rusqlite::params_from_iter(values.iter().cloned()))
            .map_err(|e| e.to_string())
    }

    fn query(&mut self, sql: &str, params: Vec<SqlVal>) -> Result<Vec<DbRow>, String> {
        let (sql, values) = expand_placeholders(sql, &params)?;
        let values: Vec<rusqlite::types::Value> =
            values.iter().map(sql_val_to_sqlite).collect();
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values.iter().cloned()), |row| {
                let count = row.as_ref().column_count();
                let mut values = Vec::with_capacity(count);
                for index in 0..count {
                    let value: rusqlite::types::Value = row.get(index)?;
                    values.push(sqlite_to_sql_val(value));
                }
                Ok(DbRow { values })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    fn begin(&mut self) -> Result<(), String> {
        self.conn
            .execute_batch("BEGIN")
            .map_err(|e| e.to_string())
    }

    fn commit(&mut self) -> Result<(), String> {
        self.conn
            .execute_batch("COMMIT")
            .map_err(|e| e.to_string())
    }

    fn rollback(&mut self) -> Result<(), String> {
        self.conn
            .execute_batch("ROLLBACK")
            .map_err(|e| e.to_string())
    }

    fn last_insert_id(&mut self) -> Result<i64, String> {
        Ok(self.conn.last_insert_rowid())
    }
}

struct MysqlSession<'a> {
    conn: &'a mut mysql::PooledConn,
}

impl<'a> SqlSession for MysqlSession<'a> {
    fn is_mysql(&self) -> bool {
        true
    }

    fn execute(&mut self, sql: &str, params: Vec<SqlVal>) -> Result<usize, String> {
        let (sql, values) = expand_placeholders(sql, &params)?;
        let params = mysql::Params::Positional(values.into_iter().map(sql_val_to_mysql).collect());
        let result = self.conn.exec_iter(&sql, params).map_err(|e| e.to_string())?;
        Ok(result.affected_rows() as usize)
    }

    fn query(&mut self, sql: &str, params: Vec<SqlVal>) -> Result<Vec<DbRow>, String> {
        let (sql, values) = expand_placeholders(sql, &params)?;
        let params = mysql::Params::Positional(values.into_iter().map(sql_val_to_mysql).collect());
        let result = self
            .conn
            .exec_iter(&sql, params)
            .map_err(|e| e.to_string())?;
        let mut rows = Vec::new();
        for row in result {
            let row = row.map_err(|e| e.to_string())?;
            let values = row
                .unwrap()
                .into_iter()
                .map(mysql_to_sql_val)
                .collect::<Vec<_>>();
            rows.push(DbRow { values });
        }
        Ok(rows)
    }

    fn begin(&mut self) -> Result<(), String> {
        self.conn
            .query_drop("START TRANSACTION")
            .map_err(|e| e.to_string())
    }

    fn commit(&mut self) -> Result<(), String> {
        self.conn.query_drop("COMMIT").map_err(|e| e.to_string())
    }

    fn rollback(&mut self) -> Result<(), String> {
        self.conn
            .query_drop("ROLLBACK")
            .map_err(|e| e.to_string())
    }

    fn last_insert_id(&mut self) -> Result<i64, String> {
        Ok(self.conn.last_insert_id() as i64)
    }
}

// ---------------------------------------------------------------------------
// 数据库配置持久化与 MySQL 建表 DDL
// ---------------------------------------------------------------------------

const MYSQL_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS stocks (
    secid VARCHAR(191) NOT NULL,
    row_id BIGINT NOT NULL AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    price DOUBLE,
    open DOUBLE,
    high DOUBLE,
    low DOUBLE,
    pre_close DOUBLE,
    price_diff DOUBLE,
    ratio DOUBLE,
    amount DOUBLE,
    turnover_ratio DOUBLE,
    industry1 VARCHAR(255),
    industry2 VARCHAR(255),
    ths_industry VARCHAR(255),
    industry_updated_at BIGINT,
    zx TINYINT NOT NULL DEFAULT 0,
    updated_at BIGINT,
    PRIMARY KEY (secid),
    UNIQUE KEY ux_stocks_row_id (row_id),
    KEY ix_stocks_zx (zx)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notions (
    id BIGINT NOT NULL,
    name VARCHAR(191) NOT NULL,
    pid BIGINT NULL,
    sort_order BIGINT NOT NULL DEFAULT 0,
    top_name VARCHAR(191) GENERATED ALWAYS AS (IF(pid IS NULL, name, NULL)) VIRTUAL,
    PRIMARY KEY (id),
    UNIQUE KEY ux_notions_top_name (top_name),
    UNIQUE KEY ux_notions_sub_name (pid, name),
    CONSTRAINT fk_notions_pid FOREIGN KEY (pid) REFERENCES notions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notion_stocks (
    notion_id BIGINT NOT NULL,
    secid VARCHAR(191) NOT NULL,
    sort_order BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (notion_id, secid),
    CONSTRAINT fk_notion_stocks_notion FOREIGN KEY (notion_id) REFERENCES notions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS histories (
    secid VARCHAR(191) NOT NULL,
    date VARCHAR(16) NOT NULL,
    open DOUBLE,
    close DOUBLE,
    high DOUBLE,
    low DOUBLE,
    volume DOUBLE,
    amount DOUBLE,
    ratio DOUBLE,
    turnover_ratio DOUBLE,
    PRIMARY KEY (secid, date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS boards (
    board_key VARCHAR(191) NOT NULL,
    source VARCHAR(32) NOT NULL,
    type VARCHAR(32) NOT NULL,
    level BIGINT,
    code VARCHAR(64),
    name VARCHAR(255) NOT NULL,
    parent_key VARCHAR(191),
    updated_at BIGINT,
    PRIMARY KEY (board_key),
    KEY ix_boards_source (source, type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_boards (
    secid VARCHAR(191) NOT NULL,
    board_key VARCHAR(191) NOT NULL,
    updated_at BIGINT,
    PRIMARY KEY (secid, board_key),
    KEY ix_stock_boards_key (board_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS board_histories (
    board_key VARCHAR(191) NOT NULL,
    date VARCHAR(16) NOT NULL,
    close DOUBLE,
    pct DOUBLE,
    amount DOUBLE,
    members BIGINT,
    PRIMARY KEY (board_key, date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sckd (
    trade_date VARCHAR(16) NOT NULL,
    industry_code VARCHAR(32) NOT NULL,
    industry_name VARCHAR(255) NOT NULL,
    value20 DOUBLE,
    sort_order BIGINT NOT NULL DEFAULT 0,
    updated_at BIGINT,
    PRIMARY KEY (trade_date, industry_code),
    KEY ix_sckd_date (trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS calendar_events (
    id BIGINT NOT NULL AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    start_date VARCHAR(16) NOT NULL,
    end_date VARCHAR(16) NOT NULL,
    repeat_type VARCHAR(16) NOT NULL DEFAULT 'none',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    KEY ix_calendar_events_start (start_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS app_settings (
    `key` VARCHAR(191) NOT NULL,
    value LONGTEXT NOT NULL,
    updated_at BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS symbol_configs (
    secid VARCHAR(191) NOT NULL,
    config LONGTEXT NOT NULL,
    updated_at BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (secid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS non_trading_days (
    `date` VARCHAR(16) NOT NULL,
    source VARCHAR(32) NOT NULL,
    confirmed_at BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS meta (
    `key` VARCHAR(191) NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"#;

const MYSQL_VERSION_SQL: &str =
    "INSERT INTO meta (`key`, value) VALUES ('schema_version', '19') \
     ON DUPLICATE KEY UPDATE value = '19'";

#[derive(Serialize, Deserialize, Clone, Default)]
struct SqliteSettings {
    #[serde(default)]
    path: String,
}

fn default_mysql_port() -> u16 {
    3306
}

#[derive(Deserialize, Clone, Default)]
struct MysqlInput {
    #[serde(default)]
    host: String,
    #[serde(default = "default_mysql_port")]
    port: u16,
    #[serde(default)]
    database: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct StoredMysqlSettings {
    #[serde(default)]
    host: String,
    #[serde(default = "default_mysql_port")]
    port: u16,
    #[serde(default)]
    database: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password_enc: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct StoredDbConfig {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    sqlite: Option<SqliteSettings>,
    #[serde(default)]
    mysql: Option<StoredMysqlSettings>,
}

#[derive(Deserialize)]
struct SetupPayload {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    sqlite: Option<SqliteSettings>,
    #[serde(default)]
    mysql: Option<MysqlInput>,
}

#[derive(Clone)]
struct MysqlConnSettings {
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
}

impl MysqlInput {
    fn to_conn_settings(&self) -> Result<MysqlConnSettings, String> {
        if self.host.trim().is_empty() {
            return Err("MySQL 主机不能为空".into());
        }
        if self.port == 0 {
            return Err("MySQL 端口无效".into());
        }
        if self.database.trim().is_empty() {
            return Err("MySQL 数据库名不能为空".into());
        }
        // 用户名留空默认 root；密码留空即使用空密码（或由调用方复用已保存密码）
        let username = match self.username.trim() {
            "" => "root".to_string(),
            value => value.to_string(),
        };
        Ok(MysqlConnSettings {
            host: self.host.trim().to_string(),
            port: self.port,
            database: self.database.trim().to_string(),
            username,
            password: self.password.clone().unwrap_or_default(),
        })
    }
}

fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("db_config.json"))
}

fn key_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("db.key"))
}

fn default_sqlite_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("data")
        .join("stocks.db"))
}

fn load_stored_config(app: &tauri::AppHandle) -> Result<Option<StoredDbConfig>, String> {
    let path = config_file_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取数据库配置失败: {e}"))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("解析数据库配置失败: {e}"))
}

fn save_stored_config(app: &tauri::AppHandle, config: &StoredDbConfig) -> Result<(), String> {
    let path = config_file_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(config)
        .map_err(|e| format!("序列化数据库配置失败: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("保存数据库配置失败: {e}"))
}

fn load_or_create_key(app: &tauri::AppHandle) -> Result<[u8; 32], String> {
    let path = key_file_path(app)?;
    if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| format!("读取密钥失败: {e}"))?;
        let bytes = BASE64
            .decode(text.trim())
            .map_err(|e| format!("解析密钥失败: {e}"))?;
        if bytes.len() != 32 {
            return Err("数据库密钥长度无效".into());
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        return Ok(key);
    }
    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    std::fs::write(&path, BASE64.encode(key)).map_err(|e| format!("保存密钥失败: {e}"))?;
    Ok(key)
}

fn encrypt_password(app: &tauri::AppHandle, password: &str) -> Result<String, String> {
    let key = load_or_create_key(app)?;
    encrypt_with_key(&key, password)
}

fn decrypt_password(app: &tauri::AppHandle, encoded: &str) -> Result<String, String> {
    let key = load_or_create_key(app)?;
    decrypt_with_key(&key, encoded)
}

fn encrypt_with_key(key: &[u8; 32], password: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| format!("初始化加密器失败: {e}"))?;
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), password.as_bytes())
        .map_err(|e| format!("加密密码失败: {e}"))?;
    let mut blob = Vec::with_capacity(12 + ciphertext.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    Ok(BASE64.encode(blob))
}

fn decrypt_with_key(key: &[u8; 32], encoded: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| format!("初始化加密器失败: {e}"))?;
    let blob = BASE64
        .decode(encoded)
        .map_err(|e| format!("解析加密密码失败: {e}"))?;
    if blob.len() <= 12 {
        return Err("加密密码数据无效".into());
    }
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&blob[..12]), &blob[12..])
        .map_err(|_| "MySQL 密码解密失败".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "MySQL 密码解密失败".to_string())
}

fn validate_database_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
    {
        return Err("MySQL 数据库名只能包含字母、数字、下划线或 $".into());
    }
    Ok(())
}

fn mysql_opts(config: &MysqlConnSettings, database: Option<&str>) -> mysql::Opts {
    let mut builder = mysql::OptsBuilder::default()
        .ip_or_hostname(Some(config.host.clone()))
        .tcp_port(config.port)
        .user(Some(config.username.clone()))
        .pass(Some(config.password.clone()));
    if let Some(database) = database {
        builder = builder.db_name(Some(database.to_string()));
    }
    mysql::Opts::from(builder)
}

fn open_mysql_pool(config: &MysqlConnSettings) -> Result<mysql::Pool, String> {
    let pool = mysql::Pool::new(mysql_opts(config, Some(&config.database)))
        .map_err(|e| format!("MySQL 连接失败: {e}"))?;
    let mut conn = pool
        .get_conn()
        .map_err(|e| format!("MySQL 连接失败: {e}"))?;
    conn.query_drop("SELECT 1")
        .map_err(|e| format!("MySQL 连接测试失败: {e}"))?;
    Ok(pool)
}

/// 设置 SQLite 运行参数。部分目录（云同步盘、受限文件夹）不支持 WAL，
/// 此时退回默认回滚日志模式，避免整个配置流程直接失败。
fn apply_sqlite_pragmas(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("SQLite 初始化失败: {e}"))?;
    match conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get::<_, String>(0)) {
        Ok(_) => Ok(()),
        Err(wal_error) => match conn.query_row(
            "PRAGMA journal_mode = DELETE",
            [],
            |row| row.get::<_, String>(0),
        ) {
            Ok(_) => Ok(()),
            Err(fallback_error) => Err(format!(
                "SQLite 初始化失败: {wal_error}（改用默认日志模式也失败: {fallback_error}）"
            )),
        },
    }
}

fn test_sqlite_connection(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("SQLite 文件路径不能为空".into());
    }
    let target = Path::new(path);
    if target.is_dir() {
        return Err("该路径是文件夹，请指定数据库文件名（如 stocks.db）".into());
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建 SQLite 目录失败: {e}"))?;
        }
    }
    let conn = Connection::open(target).map_err(|e| format!("SQLite 打开失败: {e}"))?;
    apply_sqlite_pragmas(&conn)?;
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS qs_conn_test (id INTEGER PRIMARY KEY, value TEXT);
         INSERT OR REPLACE INTO qs_conn_test (id, value) VALUES (1, 'ok');",
    )
    .map_err(|e| format!("SQLite 读写测试失败: {e}"))?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM qs_conn_test", [], |row| row.get(0))
        .map_err(|e| format!("SQLite 读写测试失败: {e}"))?;
    if count != 1 {
        return Err("SQLite 读写测试失败".into());
    }
    Ok("SQLite 连接成功".to_string())
}

fn test_mysql_connection(config: &MysqlConnSettings) -> Result<String, String> {
    validate_database_name(&config.database)?;
    let mut conn = mysql::Conn::new(mysql_opts(config, None))
        .map_err(|e| format!("MySQL 连接失败: {e}"))?;
    conn.query_drop("SELECT 1")
        .map_err(|e| format!("MySQL 连接测试失败: {e}"))?;
    Ok("MySQL 连接成功".to_string())
}

fn init_mysql(config: &MysqlConnSettings) -> Result<mysql::Pool, String> {
    validate_database_name(&config.database)?;
    let mut server = mysql::Conn::new(mysql_opts(config, None))
        .map_err(|e| format!("MySQL 连接失败: {e}"))?;
    server
        .query_drop(format!(
            "CREATE DATABASE IF NOT EXISTS `{}` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
            config.database.replace('`', "``")
        ))
        .map_err(|e| format!("创建 MySQL 数据库失败: {e}"))?;
    drop(server);

    let mut conn = mysql::Conn::new(mysql_opts(config, Some(&config.database)))
        .map_err(|e| format!("MySQL 连接数据库失败: {e}"))?;
    conn.query_drop(MYSQL_SCHEMA_SQL)
        .map_err(|e| format!("MySQL 建表失败: {e}"))?;
    // 兼容旧库：stocks 补 pre_close / price_diff。MySQL 无 ADD COLUMN IF NOT EXISTS，
    // 已存在时报 1060（Duplicate column name），忽略即可
    for column in ["pre_close", "price_diff"] {
        let sql = format!("ALTER TABLE stocks ADD COLUMN {column} DOUBLE");
        if let Err(err) = conn.query_drop(&sql) {
            match &err {
                mysql::Error::MySqlError(e) if e.code == 1060 => {}
                _ => return Err(format!("MySQL 补列失败: {err}")),
            }
        }
    }
    conn.query_drop(MYSQL_VERSION_SQL)
        .map_err(|e| format!("MySQL 写入版本失败: {e}"))?;
    drop(conn);
    open_mysql_pool(config)
}

fn config_view(app: &tauri::AppHandle, saved: Option<&StoredDbConfig>) -> Result<Value, String> {
    let default_path = default_sqlite_path(app)?
        .to_string_lossy()
        .into_owned();
    let kind = saved
        .map(|config| config.kind.as_str())
        .filter(|kind| *kind == "mysql" || *kind == "sqlite")
        .unwrap_or("sqlite");
    let sqlite_path = saved
        .and_then(|config| config.sqlite.as_ref())
        .map(|sqlite| sqlite.path.clone())
        .filter(|path| !path.trim().is_empty())
        .unwrap_or(default_path);
    let mysql = saved
        .and_then(|config| config.mysql.as_ref())
        .map(|mysql| {
            json!({
                "host": mysql.host,
                "port": mysql.port,
                "database": mysql.database,
                "username": mysql.username,
            })
        })
        .unwrap_or_else(|| {
            json!({
                "host": "127.0.0.1",
                "port": 3306,
                "database": "qushi",
                "username": "root",
            })
        });
    Ok(json!({
        "type": kind,
        "sqlite": { "path": sqlite_path },
        "mysql": mysql,
    }))
}

fn mysql_settings_for(
    app: &tauri::AppHandle,
    mysql: &MysqlInput,
) -> Result<MysqlConnSettings, String> {
    // 用户名留空默认 root；密码留空时优先沿用已保存的同一目标密码
    let settings = mysql.to_conn_settings()?;
    if !settings.password.is_empty() {
        return Ok(settings);
    }
    if let Some(saved) = load_stored_config(app)
        .ok()
        .flatten()
        .filter(|config| config.kind == "mysql")
        .and_then(|config| config.mysql)
    {
        if saved.host.trim().eq_ignore_ascii_case(settings.host.trim())
            && saved.port == settings.port
            && saved.database.trim() == settings.database.trim()
            && saved.username.trim() == settings.username.trim()
        {
            if let Some(encoded) = saved.password_enc.as_ref() {
                let password = decrypt_password(app, encoded)?;
                return Ok(MysqlConnSettings {
                    password,
                    ..settings
                });
            }
        }
    }
    Ok(settings)
}

fn test_connection_value(app: &tauri::AppHandle, input: &SetupPayload) -> Value {
    let result = match input.kind.as_str() {
        "sqlite" => input
            .sqlite
            .as_ref()
            .ok_or_else(|| "缺少 SQLite 配置".to_string())
            .and_then(|sqlite| test_sqlite_connection(&sqlite.path)),
        "mysql" => input
            .mysql
            .as_ref()
            .ok_or_else(|| "缺少 MySQL 配置".to_string())
            .and_then(|mysql| mysql_settings_for(app, mysql))
            .and_then(|settings| test_mysql_connection(&settings)),
        _ => Err("数据库类型必须是 sqlite 或 mysql".to_string()),
    };
    match result {
        Ok(message) => json!({ "ok": true, "message": message }),
        Err(message) => json!({ "ok": false, "message": message }),
    }
}

fn configure_database(
    app: &tauri::AppHandle,
    state: &Db,
    payload: &str,
) -> Result<(), String> {
    let input: SetupPayload =
        serde_json::from_str(payload).map_err(|e| format!("解析数据库配置失败: {e}"))?;

    let test = test_connection_value(app, &input);
    if test.get("ok").and_then(|value| value.as_bool()) != Some(true) {
        return Err(test
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("连接测试失败")
            .to_string());
    }

    match input.kind.as_str() {
        "sqlite" => {
            let sqlite = input
                .sqlite
                .as_ref()
                .ok_or_else(|| "缺少 SQLite 配置".to_string())?;
            let path = sqlite.path.trim();
            if path.is_empty() {
                return Err("SQLite 文件路径不能为空".into());
            }
            let conn = init_sqlite(Path::new(path))?;
            let stored = StoredDbConfig {
                kind: "sqlite".into(),
                sqlite: Some(SqliteSettings {
                    path: path.to_string(),
                }),
                mysql: None,
            };
            save_stored_config(app, &stored)?;
            state.replace_backend(Backend::Sqlite(conn))
        }
        "mysql" => {
            let mysql = input
                .mysql
                .as_ref()
                .ok_or_else(|| "缺少 MySQL 配置".to_string())?;
            let settings = mysql_settings_for(app, mysql)?;
            let pool = init_mysql(&settings)?;
            let password_enc = encrypt_password(app, &settings.password)?;
            let stored = StoredDbConfig {
                kind: "mysql".into(),
                sqlite: None,
                mysql: Some(StoredMysqlSettings {
                    host: settings.host.clone(),
                    port: settings.port,
                    database: settings.database.clone(),
                    username: settings.username.clone(),
                    password_enc: Some(password_enc),
                }),
            };
            save_stored_config(app, &stored)?;
            state.replace_backend(Backend::Mysql(pool))
        }
        _ => Err("数据库类型必须是 sqlite 或 mysql".into()),
    }
}

#[tauri::command]
fn db_setup_state(
    app: tauri::AppHandle,
    state: State<'_, Db>,
) -> Result<Value, String> {
    let saved_file = config_file_path(&app)?.exists();
    let stored = load_stored_config(&app).ok().flatten();
    let config = config_view(&app, stored.as_ref())?;
    let default_path = default_sqlite_path(&app)?
        .to_string_lossy()
        .into_owned();
    Ok(json!({
        "configured": state.configured(),
        "saved": saved_file,
        "error": state.last_error(),
        "default_sqlite_path": default_path,
        "config": config,
    }))
}

#[tauri::command]
fn db_test_connection(app: tauri::AppHandle, payload: String) -> Result<Value, String> {
    match serde_json::from_str::<SetupPayload>(&payload) {
        Ok(input) => Ok(test_connection_value(&app, &input)),
        Err(error) => Ok(json!({
            "ok": false,
            "message": format!("解析数据库配置失败: {error}"),
        })),
    }
}

#[tauri::command]
fn db_configure(
    app: tauri::AppHandle,
    state: State<'_, Db>,
    payload: String,
) -> Result<Value, String> {
    match configure_database(&app, &state, &payload) {
        Ok(()) => {
            state.set_error(None);
            Ok(json!({ "ok": true, "message": "数据库配置成功" }))
        }
        Err(error) => {
            state.set_error(Some(error.clone()));
            Ok(json!({ "ok": false, "message": error }))
        }
    }
}

/// 选择目录后立即准备数据库文件：目录不存在则创建，文件不存在则新建（含全部表结构）。
#[tauri::command]
fn db_prepare_sqlite(path: String) -> Result<Value, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("SQLite 文件路径不能为空".into());
    }
    let target = Path::new(path);
    if target.is_dir() {
        return Err("该路径是文件夹，请指定数据库文件名（如 stocks.db）".into());
    }
    init_sqlite(target)?;
    Ok(json!({ "ok": true, "message": "数据库已就绪" }))
}

/// 列出目录下的 SQLite 数据库文件名（不含完整路径），供向导选择目录后自动识别。
#[tauri::command]
fn db_sqlite_files(dir: String) -> Result<Value, String> {
    let dir = dir.trim();
    if dir.is_empty() {
        return Err("目录不能为空".into());
    }
    let target = Path::new(dir);
    if !target.is_dir() {
        return Err("该路径不是文件夹".into());
    }
    let mut files: Vec<String> = std::fs::read_dir(target)
        .map_err(|e| format!("读取目录失败: {e}"))?
        .flatten()
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let path = entry.path();
            let ext = path.extension()?.to_str()?.to_ascii_lowercase();
            if !matches!(ext.as_str(), "db" | "sqlite" | "sqlite3") {
                return None;
            }
            path.file_name()?.to_str().map(|name| name.to_string())
        })
        .collect();
    files.sort();
    Ok(json!({ "files": files }))
}

fn init_sqlite(path: &Path) -> Result<Connection, String> {
    (|| -> Result<Connection, Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let conn = Connection::open(path)?;
    apply_sqlite_pragmas(&conn).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
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
    // 兼容 v18 及更早：stocks 补存昨收与涨跌额，库优先展示时不再反推
    for column in ["pre_close", "price_diff"] {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('stocks') WHERE name = ?1",
                [column],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if exists == 0 {
            conn.execute_batch(&format!("ALTER TABLE stocks ADD COLUMN {column} REAL;"))?;
        }
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
                rusqlite::params![column],
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
            rusqlite::params![HISTORY_MIN_DATE],
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
    // v15 -> v16：新增 calendar_events（日历事件），表由 SCHEMA_SQL 幂等创建
    // v16 -> v17：新增 app_settings / symbol_configs（设置与持仓提醒改为数据库唯一来源），
    // 表由 SCHEMA_SQL 幂等创建
    // v17 -> v18：新增 non_trading_days（非交易日日历），表由 SCHEMA_SQL 幂等创建
    // v18 -> v19：stocks 补 pre_close / price_diff（上面已幂等 ALTER），行情可纯读库展示
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '19')",
        [],
    )?;
    Ok(conn)
    })()
    .map_err(|e| e.to_string())
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
    conn: &mut dyn SqlSession,
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
    conn.execute_d(
        "INSERT INTO stocks (secid, name, zx, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(secid) DO UPDATE SET
             name = CASE WHEN excluded.name = '' THEN stocks.name ELSE excluded.name END,
             zx = MAX(stocks.zx, excluded.zx),
             updated_at = MAX(COALESCE(stocks.updated_at, 0), excluded.updated_at)",
        "INSERT INTO stocks (secid, name, zx, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON DUPLICATE KEY UPDATE
             name = CASE WHEN VALUES(name) = '' THEN stocks.name ELSE VALUES(name) END,
             zx = GREATEST(stocks.zx, VALUES(zx)),
             updated_at = GREATEST(COALESCE(stocks.updated_at, 0), VALUES(updated_at))",
        // 新增自选/概念成分不是行情刷新，updated_at 用 0（未知）；
        // 否则非交易日盘中会被 db_load_today_candle 误判为「今天有成交」并合成假当日K线。
        p![secid, name, zx as i64, 0i64],
    )?;
    Ok(())
}

fn insert_notion(
    conn: &mut dyn SqlSession,
    id: i64,
    name: &str,
    pid: Option<i64>,
    sort_order: i64,
) -> Result<(), String> {
    conn.execute_d(
        "INSERT INTO notions (id, name, pid, sort_order)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             pid = excluded.pid,
             sort_order = excluded.sort_order",
        "INSERT INTO notions (id, name, pid, sort_order)
         VALUES (?1, ?2, ?3, ?4)
         ON DUPLICATE KEY UPDATE
             name = VALUES(name),
             pid = VALUES(pid),
             sort_order = VALUES(sort_order)",
        p![id, name, pid, sort_order],
    )?;
    Ok(())
}

fn link_member(
    conn: &mut dyn SqlSession,
    notion_id: i64,
    secid: &str,
    sort_order: i64,
) -> Result<(), String> {
    conn.execute_d(
        "INSERT OR IGNORE INTO notion_stocks (notion_id, secid, sort_order)
         VALUES (?1, ?2, ?3)",
        "INSERT IGNORE INTO notion_stocks (notion_id, secid, sort_order)
         VALUES (?1, ?2, ?3)",
        p![notion_id, secid, sort_order],
    )?;
    Ok(())
}

/// 板块实体：board_key 一旦确定不再变化，名称/代码可以随抓取结果更新
fn upsert_board(
    conn: &mut dyn SqlSession,
    board_key: &str,
    source: &str,
    kind: &str,
    level: Option<i64>,
    code: Option<&str>,
    name: &str,
    parent_key: Option<&str>,
) -> Result<(), String> {
    conn.execute_d(
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
        "INSERT INTO boards (board_key, source, type, level, code, name, parent_key, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON DUPLICATE KEY UPDATE
             source = VALUES(source),
             type = VALUES(type),
             level = VALUES(level),
             code = COALESCE(VALUES(code), boards.code),
             name = VALUES(name),
             parent_key = COALESCE(VALUES(parent_key), boards.parent_key),
             updated_at = VALUES(updated_at)",
        p![board_key, source, kind, level, code, name, parent_key, now_ms()],
    )?;
    Ok(())
}

fn link_board(
    conn: &mut dyn SqlSession,
    secid: &str,
    board_key: &str,
    updated_at: i64,
) -> Result<(), String> {
    conn.execute_d(
        "INSERT INTO stock_boards (secid, board_key, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(secid, board_key) DO UPDATE SET updated_at = excluded.updated_at",
        "INSERT INTO stock_boards (secid, board_key, updated_at)
         VALUES (?1, ?2, ?3)
         ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)",
        p![secid, board_key, updated_at],
    )?;
    Ok(())
}

/// 自建概念（notions/notion_stocks）同步到 boards/stock_boards（source='self'），
/// 让自建概念与官方概念、申万行业共用同一套板块日K 聚合逻辑
fn sync_self_boards(conn: &mut dyn SqlSession) -> Result<(), String> {
    conn.execute("DELETE FROM stock_boards WHERE board_key LIKE 'self:%'", vec![])?;
    conn.execute("DELETE FROM boards WHERE source = 'self'", vec![])?;
    let now = now_ms();
    conn.execute_d(
        "INSERT INTO boards (board_key, source, type, level, code, name, parent_key, updated_at)
         SELECT 'self:' || id, 'self', 'concept',
                CASE WHEN pid IS NULL THEN 1 ELSE 2 END, NULL, name,
                CASE WHEN pid IS NULL THEN NULL ELSE 'self:' || pid END, ?1
         FROM notions",
        "INSERT INTO boards (board_key, source, type, level, code, name, parent_key, updated_at)
         SELECT CONCAT('self:', id), 'self', 'concept',
                CASE WHEN pid IS NULL THEN 1 ELSE 2 END, NULL, name,
                CASE WHEN pid IS NULL THEN NULL ELSE CONCAT('self:', pid) END, ?1
         FROM notions",
        p![now],
    )?;
    conn.execute_d(
        "INSERT INTO stock_boards (secid, board_key, updated_at)
         SELECT secid, 'self:' || notion_id, ?1 FROM notion_stocks",
        "INSERT INTO stock_boards (secid, board_key, updated_at)
         SELECT secid, CONCAT('self:', notion_id), ?1 FROM notion_stocks",
        p![now],
    )?;
    Ok(())
}

fn count_table(conn: &mut dyn SqlSession, table: &str) -> Result<i64, String> {
    conn.query_one(&format!("SELECT COUNT(*) FROM {table}"), vec![])?
        .ok_or_else(|| "统计查询失败".to_string())?
        .get::<_, i64>(0)
        .map_err(|e| e.to_string())
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
    conn: &mut dyn SqlSession,
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
                upsert_stock(conn, symbol, true)?;
                stock_count += 1;
            }
            continue;
        }

        // 一级概念 sort_order 即其在看板中的顺序（自选 id=0 不入表，不占位）
        insert_notion(conn, gid, gname, None, index as i64)?;
        notion_count += 1;
        for (order, symbol) in symbols.iter().enumerate() {
            upsert_stock(conn, symbol, false)?;
            if let Some(secid) = symbol.get("secid").and_then(|v| v.as_str()) {
                link_member(conn, gid, secid, order as i64)?;
                member_count += 1;
            }
        }

        if let Some(children) = group.get("children").and_then(|v| v.as_array()) {
            for (child_index, child) in children.iter().enumerate() {
                let cid = child.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                let cname = child.get("name").and_then(|v| v.as_str()).unwrap_or("");
                insert_notion(conn, cid, cname, Some(gid), child_index as i64)?;
                notion_count += 1;

                let child_symbols = child
                    .get("symbols")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                for (order, symbol) in child_symbols.iter().enumerate() {
                    upsert_stock(conn, symbol, false)?;
                    if let Some(secid) = symbol.get("secid").and_then(|v| v.as_str()) {
                        link_member(conn, cid, secid, order as i64)?;
                        member_count += 1;
                    }
                }
            }
        }
    }
    Ok((stock_count, notion_count, member_count))
}

/// 读取软件设置；数据库为唯一来源，无记录时返回 null
#[tauri::command]
fn db_load_settings(state: State<'_, Db>) -> Result<Value, String> {
    let text = state.with_conn(|conn| {
        Ok(conn
            .query_one_d(
                "SELECT value FROM app_settings WHERE key = 'setting'",
                "SELECT value FROM app_settings WHERE `key` = 'setting'",
                vec![],
            )?
            .map(|row| row.get::<_, String>(0).map_err(|e| e.to_string()))
            .transpose()?)
    })?;
    let settings = match text {
        Some(text) => serde_json::from_str(&text).map_err(|e| format!("解析设置失败: {e}"))?,
        None => Value::Null,
    };
    Ok(json!({ "settings": settings }))
}

/// 保存整份软件设置
#[tauri::command]
fn db_save_settings(state: State<'_, Db>, payload: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&payload).map_err(|e| format!("解析设置失败: {e}"))?;
    state.with_tx(|conn| {
        conn.execute_d(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('setting', ?1, ?2)",
            "INSERT INTO app_settings (`key`, value, updated_at) VALUES ('setting', ?1, ?2)
             ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)",
            p![payload.to_string(), now_ms()],
        )?;
        Ok(())
    })?;
    Ok(json!({ "saved": true }))
}

/// 读取全部个股持仓/提醒配置
#[tauri::command]
fn db_load_symbol_configs(state: State<'_, Db>) -> Result<Value, String> {
    let rows = state.with_conn(|conn| {
        conn.query_d(
            "SELECT secid, config FROM symbol_configs",
            "SELECT secid, config FROM symbol_configs",
            vec![],
        )
    })?;
    let mut configs = serde_json::Map::new();
    for row in rows {
        let secid: String = row.get(0).map_err(|e| e.to_string())?;
        let text: String = row.get(1).map_err(|e| e.to_string())?;
        let config: Value =
            serde_json::from_str(&text).map_err(|e| format!("解析持仓配置失败: {e}"))?;
        configs.insert(secid, config);
    }
    Ok(json!({ "configs": Value::Object(configs) }))
}

/// 整份覆盖保存个股持仓/提醒配置
#[tauri::command]
fn db_save_symbol_configs(state: State<'_, Db>, payload: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&payload).map_err(|e| format!("解析持仓配置失败: {e}"))?;
    let configs = payload.as_object().cloned().unwrap_or_default();
    state.with_tx(|conn| {
        conn.execute_d(
            "DELETE FROM symbol_configs",
            "DELETE FROM symbol_configs",
            vec![],
        )?;
        let now = now_ms();
        for (secid, config) in configs.iter() {
            conn.execute_d(
                "INSERT INTO symbol_configs (secid, config, updated_at) VALUES (?1, ?2, ?3)",
                "INSERT INTO symbol_configs (secid, config, updated_at) VALUES (?1, ?2, ?3)",
                p![secid.clone(), config.to_string(), now],
            )?;
        }
        Ok(())
    })?;
    Ok(json!({ "saved": true }))
}

/// 旧版数据导入的事务内逻辑；已导入过时返回 None。
/// 返回 (settings 条数, symbol 条数, (股票数, 概念数, 成员数))
#[allow(clippy::type_complexity)]
fn import_legacy_data(
    conn: &mut dyn SqlSession,
    payload: &Value,
) -> Result<Option<(i64, i64, (i64, i64, i64))>, String> {
    let imported = conn
        .query_one_d(
            "SELECT value FROM meta WHERE key = 'legacy_imported'",
            "SELECT value FROM meta WHERE `key` = 'legacy_imported'",
            vec![],
        )?
        .is_some();
    if imported {
        return Ok(None);
    }

    let mut settings_count = 0;
    let mut symbol_count = 0;
    let mut watch_counts = (0i64, 0i64, 0i64);

    if let Some(settings) = payload.get("settings").filter(|value| !value.is_null()) {
        let exists = conn
            .query_one_d(
                "SELECT value FROM app_settings WHERE key = 'setting'",
                "SELECT value FROM app_settings WHERE `key` = 'setting'",
                vec![],
            )?
            .is_some();
        if !exists {
            conn.execute_d(
                "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('setting', ?1, ?2)",
                "INSERT INTO app_settings (`key`, value, updated_at) VALUES ('setting', ?1, ?2)
                 ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)",
                p![settings.to_string(), now_ms()],
            )?;
            settings_count = 1;
        }
    }

    if let Some(configs) = payload.get("symbol_configs").and_then(|value| value.as_object()) {
        let exists = count_table(conn, "symbol_configs")?;
        if exists == 0 && !configs.is_empty() {
            let now = now_ms();
            for (secid, config) in configs.iter() {
                conn.execute_d(
                    "INSERT INTO symbol_configs (secid, config, updated_at) VALUES (?1, ?2, ?3)",
                    "INSERT INTO symbol_configs (secid, config, updated_at) VALUES (?1, ?2, ?3)",
                    p![secid.clone(), config.to_string(), now],
                )?;
                symbol_count += 1;
            }
        }
    }

    if let Some(groups) = payload.get("groups").and_then(|value| value.as_array()) {
        let watched = conn
            .query_one("SELECT COUNT(*) FROM stocks WHERE zx = 1", vec![])?
            .map(|row| row.get::<_, i64>(0).unwrap_or(0))
            .unwrap_or(0);
        let notions = count_table(conn, "notions")?;
        if watched == 0 && notions == 0 && !groups.is_empty() {
            watch_counts = fill_watchgroup(conn, &Value::Array(groups.clone()))?;
            sync_self_boards(conn)?;
        }
    }

    conn.execute_d(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_imported', ?1)",
        "INSERT INTO meta (`key`, value) VALUES ('legacy_imported', ?1)
         ON DUPLICATE KEY UPDATE value = VALUES(value)",
        p![now_ms().to_string()],
    )?;
    Ok(Some((settings_count, symbol_count, watch_counts)))
}

/// 旧版 profile 文件（settings.json / symbol.dat / monitor.dat）一次性迁入数据库。
/// 各来源仅在库内为空时导入，成功后写 meta.legacy_imported 保证只执行一次；
/// 前端在命令成功后删除旧文件。
#[tauri::command]
fn db_import_legacy(state: State<'_, Db>, payload: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&payload).map_err(|e| format!("解析旧版数据失败: {e}"))?;

    let outcome = state.with_tx(|conn| import_legacy_data(conn, &payload))?;

    let Some((settings_count, symbol_count, (stock_count, notion_count, member_count))) = outcome
    else {
        return Ok(json!({ "imported": false, "skipped": true }));
    };

    // 旧自选/概念导入相当于成分变化，提交后整段重算自建板块历史
    let (board_count, board_rows) = if stock_count > 0 || notion_count > 0 {
        state
            .with_conn(|conn| refresh_board_histories(conn, &["self:"]))
            .unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    Ok(json!({
        "imported": true,
        "settings": settings_count,
        "symbols": symbol_count,
        "stocks": stock_count,
        "notions": notion_count,
        "members": member_count,
        "boards": board_count,
        "board_rows": board_rows,
    }))
}

// ---------------------------------------------------------------------------
// 非交易日日历：历史由 histories 日期集合回填，盘中由前端探测结论落库
// ---------------------------------------------------------------------------

/// 某年某月的天数
fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// 日期（YYYY-MM-DD）加一天；用于逐日回填，不引入日期库依赖
fn next_date(date: &str) -> Option<String> {
    let mut parts = date.split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    let mut year = year;
    let mut month = month;
    let mut day = day + 1;
    if day > days_in_month(year, month) {
        day = 1;
        month += 1;
    }
    if month > 12 {
        month = 1;
        year += 1;
    }
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

/// 历史非交易日回填：
/// 1. 区间内 histories 中一只股票都没有的日期（含周末）写入非交易日；
/// 2. 已写成非交易日但当天现在已有数据的记录自动删除（漏同步补齐后的自愈）。
/// 返回 (新增数, 删除数)
fn sync_non_trading_days(
    conn: &mut dyn SqlSession,
    start: &str,
    end: &str,
) -> Result<(usize, usize), String> {
    let mut existing = HashSet::new();
    for row in conn.query("SELECT date FROM non_trading_days", vec![])? {
        existing.insert(row.get::<_, String>(0).map_err(|e| e.to_string())?);
    }

    let mut trading = HashSet::new();
    for row in conn.query(
        "SELECT DISTINCT date FROM histories WHERE date >= ?1 AND date <= ?2",
        p![start.to_string(), end.to_string()],
    )? {
        trading.insert(row.get::<_, String>(0).map_err(|e| e.to_string())?);
    }

    let mut add_rows: Vec<String> = Vec::new();
    let mut remove_rows: Vec<String> = Vec::new();
    let mut day = start.to_string();
    loop {
        if day.as_str() > end {
            break;
        }
        if trading.contains(&day) {
            // 有数据说明是交易日；此前若误判为休市，这里顺手纠正
            if existing.contains(&day) {
                remove_rows.push(day.clone());
            }
        } else if !existing.contains(&day) {
            add_rows.push(day.clone());
        }
        match next_date(&day) {
            Some(next) if next.as_str() > day.as_str() => day = next,
            _ => break,
        }
    }

    let now = now_ms();
    for date in &add_rows {
        conn.execute_d(
            "INSERT OR IGNORE INTO non_trading_days (date, source, confirmed_at) VALUES (?1, 'history', ?2)",
            "INSERT IGNORE INTO non_trading_days (date, source, confirmed_at) VALUES (?1, 'history', ?2)",
            p![date.clone(), now],
        )?;
    }
    for date in &remove_rows {
        conn.execute_d(
            "DELETE FROM non_trading_days WHERE date = ?1",
            "DELETE FROM non_trading_days WHERE date = ?1",
            p![date.clone()],
        )?;
    }
    Ok((add_rows.len(), remove_rows.len()))
}

/// 历史非交易日回填：区间内 histories 全无数据的日期写入非交易日，已有数据的记录自动删除
#[tauri::command]
fn db_sync_non_trading_days(
    state: State<'_, Db>,
    start: String,
    end: String,
) -> Result<Value, String> {
    let (added, removed) = state.with_tx(|conn| sync_non_trading_days(conn, &start, &end))?;
    Ok(json!({ "added": added, "removed": removed }))
}

/// 盘中探测结论落库：non_trading=true 写入非交易日；false 删除当天误记（自愈）
#[tauri::command]
fn db_set_non_trading_day(
    state: State<'_, Db>,
    date: String,
    non_trading: bool,
    source: String,
) -> Result<Value, String> {
    state.with_conn(|conn| {
        if non_trading {
            conn.execute_d(
                "INSERT OR REPLACE INTO non_trading_days (date, source, confirmed_at) VALUES (?1, ?2, ?3)",
                "INSERT INTO non_trading_days (date, source, confirmed_at) VALUES (?1, ?2, ?3)
                 ON DUPLICATE KEY UPDATE source = VALUES(source), confirmed_at = VALUES(confirmed_at)",
                p![date.clone(), source.clone(), now_ms()],
            )?;
        } else {
            conn.execute_d(
                "DELETE FROM non_trading_days WHERE date = ?1",
                "DELETE FROM non_trading_days WHERE date = ?1",
                p![date.clone()],
            )?;
        }
        Ok(())
    })?;
    Ok(json!({ "ok": true, "date": date, "non_trading": non_trading }))
}

// ---------------------------------------------------------------------------
// 行情来源判定（库优先展示）：9:15–15:15 必须走接口；
// 其余时段只要库已覆盖「最近一个已收盘交易日」，就直接读库、不发请求
// ---------------------------------------------------------------------------

/// 行情可纯读库的盘中窗口：9:15–15:15
const QUOTE_LIVE_START_MINUTES: u32 = 9 * 60 + 15;
const QUOTE_LIVE_END_MINUTES: u32 = 15 * 60 + 15;

/// 日期（YYYY-MM-DD）减一天
fn prev_date(date: &str) -> Option<String> {
    let mut parts = date.split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    let (year, month, day) = if day > 1 {
        (year, month, day - 1)
    } else if month > 1 {
        (year, month - 1, days_in_month(year, month - 1))
    } else {
        (year - 1, 12, 31)
    };
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

/// 公历年月日 -> 1970-01-01 起的天数（Howard Hinnant 算法，避免引入日期库）
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = year as i64 - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// 1970-01-01 起的天数 -> 公历年月日
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((if m <= 2 { y + 1 } else { y }) as i32, m, d)
}

/// 毫秒时间戳 -> 北京时间的日期与当日分钟数（固定 UTC+8，中国无夏令时）
fn cst_date_minutes(now_ms: i64) -> (String, u32) {
    let secs = now_ms / 1000 + 8 * 3600;
    let days = secs.div_euclid(86400);
    let minutes = (secs.rem_euclid(86400) / 60) as u32;
    let (year, month, day) = civil_from_days(days);
    (format!("{year:04}-{month:02}-{day:02}"), minutes)
}

/// 日期对应星期几：0=周日 … 6=周六
fn weekday_index(date: &str) -> Option<i64> {
    let mut parts = date.split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    // 1970-01-01 是周四，索引 4
    Some((days_from_civil(year, month, day) + 4).rem_euclid(7))
}

fn is_weekday_date(date: &str) -> bool {
    matches!(weekday_index(date), Some(index) if index != 0 && index != 6)
}

/// 最近一个已收盘的交易日：
/// 今天本身是交易日且已过 15:15 → 今天；否则往前找最近的工作日（跳过非交易日表）
fn latest_completed_trading_day(
    today: &str,
    today_trading: bool,
    after_close: bool,
    non_trading: &HashSet<String>,
) -> Option<String> {
    if today_trading && after_close {
        return Some(today.to_string());
    }
    let mut cursor = prev_date(today)?;
    for _ in 0..400 {
        if is_weekday_date(&cursor) && !non_trading.contains(&cursor) {
            return Some(cursor);
        }
        cursor = prev_date(&cursor)?;
    }
    None
}

/// 读取 meta 表里的单个键
fn meta_get(conn: &mut dyn SqlSession, key: &str) -> Result<Option<String>, String> {
    let rows = conn.query("SELECT value FROM meta WHERE key = ?1", p![key.to_string()])?;
    Ok(rows.first().and_then(|row| row.get::<_, String>(0).ok()))
}

/// 写入 meta 表（存在则覆盖）
fn meta_set(conn: &mut dyn SqlSession, key: &str, value: &str) -> Result<(), String> {
    conn.execute_d(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        "INSERT INTO meta (`key`, value) VALUES (?1, ?2) ON DUPLICATE KEY UPDATE value = VALUES(value)",
        p![key.to_string(), value.to_string()],
    )?;
    Ok(())
}

/// 行情来源判定结果：前端据此决定接口轮询还是读库，以及轮询间隔。
/// 传入 secids 时额外校验窗口内标的是否都已刷新到最近已收盘交易日：
/// 全局同步日期只能说明「有标的刷新过」，不能保证当前窗口的标的都在库里。
fn quote_market_status(
    conn: &mut dyn SqlSession,
    now: i64,
    secids: Option<&[String]>,
) -> Result<Value, String> {
    let (today, minutes) = cst_date_minutes(now);
    let mut non_trading = HashSet::new();
    for row in conn.query("SELECT date FROM non_trading_days", vec![])? {
        if let Ok(date) = row.get::<_, String>(0) {
            non_trading.insert(date);
        }
    }
    let synced = meta_get(conn, "quotes_synced_date")?.filter(|value| !value.trim().is_empty());
    let today_trading = is_weekday_date(&today) && !non_trading.contains(&today);
    let live_window = (QUOTE_LIVE_START_MINUTES..=QUOTE_LIVE_END_MINUTES).contains(&minutes);
    let latest = latest_completed_trading_day(
        &today,
        today_trading,
        minutes > QUOTE_LIVE_END_MINUTES,
        &non_trading,
    );
    // 库内最近一次行情所属交易日 >= 最近已收盘交易日，说明再请求接口也拿不到更新的数据
    let covered = match (&synced, &latest) {
        (Some(synced_date), Some(latest_day)) => synced_date.as_str() >= latest_day.as_str(),
        _ => false,
    };
    let base_use_db = !(live_window && today_trading) && covered;
    // 窗口内标的必须全部刷新到最近交易日才读库，否则先补一次接口（60 秒后重试）
    let window_covered = match (base_use_db, secids, latest.as_deref()) {
        (true, Some(list), Some(latest_day)) if !list.is_empty() => {
            Some(quotes_covered(conn, list, latest_day)?)
        }
        _ => None,
    };
    let use_db = base_use_db && window_covered.unwrap_or(true);
    Ok(json!({
        "today": today,
        "todayTrading": today_trading,
        "liveWindow": live_window,
        "latestTradingDay": latest,
        "syncedDate": synced,
        "useDb": use_db,
        "windowCovered": window_covered,
    }))
}

/// 窗口内标的是否都已刷新到最近已收盘交易日：
/// 以该交易日北京时间 0 点作为门槛，缺行（不在 stocks）或 updated_at 更早都算未覆盖。
fn quotes_covered(
    conn: &mut dyn SqlSession,
    secids: &[String],
    latest: &str,
) -> Result<bool, String> {
    let mut unique: Vec<&str> = secids.iter().map(|secid| secid.as_str()).collect();
    unique.sort_unstable();
    unique.dedup();
    if unique.is_empty() {
        return Ok(true);
    }

    let mut parts = latest.split('-');
    let parsed = (|| {
        let year: i32 = parts.next()?.parse().ok()?;
        let month: u32 = parts.next()?.parse().ok()?;
        let day: u32 = parts.next()?.parse().ok()?;
        Some((year, month, day))
    })();
    let Some((year, month, day)) = parsed else {
        return Ok(false);
    };
    let day_start_ms = (days_from_civil(year, month, day) * 86400 - 8 * 3600) * 1000;

    let mut sql = String::from(
        "SELECT COUNT(DISTINCT secid) FROM stocks WHERE updated_at >= ?1 AND secid IN (",
    );
    let mut params = vec![SqlVal::Int(day_start_ms)];
    for (index, secid) in unique.iter().enumerate() {
        if index > 0 {
            sql.push(',');
        }
        sql.push_str(&format!("?{}", index + 2));
        params.push(SqlVal::Text((*secid).to_string()));
    }
    sql.push(')');
    let found = conn
        .query_one(&sql, params)?
        .and_then(|row| row.get::<_, i64>(0).ok())
        .unwrap_or(0);
    Ok(found as usize >= unique.len())
}

/// 行情时段判定：给前端主/子表决定「调接口还是读库」
#[tauri::command]
fn db_quote_market_status(
    state: State<'_, Db>,
    secids: Option<Vec<String>>,
) -> Result<Value, String> {
    state.with_conn(|conn| quote_market_status(conn, now_ms(), secids.as_deref()))
}

/// 按 secid 批量读取库内行情快照，字段与实时行情对齐（供库优先展示）
fn load_quotes_rows(conn: &mut dyn SqlSession, secids: &[String]) -> Result<Vec<Value>, String> {
    if secids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (1..=secids.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT secid, name, price, ratio, price_diff, turnover_ratio, high, low, open, pre_close, amount, updated_at \
         FROM stocks WHERE secid IN ({placeholders})"
    );
    let params: Vec<SqlVal> = secids
        .iter()
        .map(|secid| SqlVal::Text(secid.clone()))
        .collect();
    let rows = conn.query(&sql, params)?;
    Ok(rows
        .iter()
        .map(|row| {
            let updated_at = row.get::<_, Option<i64>>(11).ok().flatten();
            json!({
                "secid": row.get::<_, String>(0).unwrap_or_default(),
                "name": row.get::<_, String>(1).unwrap_or_default(),
                "price": row.get::<_, Option<f64>>(2).ok().flatten(),
                "range": row.get::<_, Option<f64>>(3).ok().flatten(),
                "price_diff": row.get::<_, Option<f64>>(4).ok().flatten(),
                "turn": row.get::<_, Option<f64>>(5).ok().flatten(),
                "high": row.get::<_, Option<f64>>(6).ok().flatten(),
                "low": row.get::<_, Option<f64>>(7).ok().flatten(),
                "open": row.get::<_, Option<f64>>(8).ok().flatten(),
                "pre_close": row.get::<_, Option<f64>>(9).ok().flatten(),
                "amount": row.get::<_, Option<f64>>(10).ok().flatten(),
                // 与实时行情一致，时间单位为秒（东财 f124）
                "time": updated_at.map(|stamp| stamp / 1000),
            })
        })
        .collect())
}

/// 批量读取库内行情快照
#[tauri::command]
fn db_load_quotes(state: State<'_, Db>, secids: Vec<String>) -> Result<Value, String> {
    let rows = state.with_conn(|conn| load_quotes_rows(conn, &secids))?;
    Ok(json!(rows))
}


/// 保存前记录当前自选（zx=1）的股票，用于判断本次保存移除了谁
fn collect_watched_secids(conn: &mut dyn SqlSession) -> Result<HashSet<String>, String> {
    Ok(conn
        .query("SELECT secid FROM stocks WHERE zx = 1", vec![])?
        .iter()
        .map(|row| row.get::<_, String>(0).map_err(|e| e.to_string()))
        .collect::<Result<HashSet<String>, String>>()?)
}

/// 删除本次移出自选、且不再属于任何概念的股票。
/// 概念/概念成员删除不会走到这里：概念侧删除只动概念数据，股票保留给「数据校验」统一清理。
fn prune_deleted_watch_stocks(
    conn: &mut dyn SqlSession,
    prev_watched: &HashSet<String>,
) -> Result<usize, String> {
    let mut removed = 0;
    for secid in prev_watched {
        removed += conn.execute(
            "DELETE FROM stocks
             WHERE secid = ?1 AND zx = 0 AND name <> ''
               AND secid NOT IN (SELECT secid FROM notion_stocks)",
            params![secid],
        )?;
    }
    Ok(removed)
}

/// 数据校验修复：按 secid 删除已失去全部引用的孤儿股票（zx=0、有名称、不属于任何概念）。
/// 仍被自选或概念引用的行会被 SQL 条件挡住，不会误删。
fn delete_orphan_stocks(conn: &mut dyn SqlSession, secids: &[String]) -> Result<usize, String> {
    let mut removed = 0;
    for secid in secids {
        removed += conn.execute(
            "DELETE FROM stocks
             WHERE secid = ?1 AND zx = 0 AND name <> ''
               AND secid NOT IN (SELECT secid FROM notion_stocks)",
            params![secid],
        )?;
    }
    Ok(removed)
}

/// 数据校验修复：清理孤儿股票，并连带删除其日K、板块成分与板块日线残留
#[tauri::command]
fn db_clean_orphan_stocks(state: State<'_, Db>, secids: String) -> Result<Value, String> {
    let list: Vec<String> =
        serde_json::from_str(&secids).map_err(|e| format!("解析待清理股票失败: {e}"))?;

    let removed = state.with_tx(|tx| {
        let removed = delete_orphan_stocks(tx, &list)?;
        if removed > 0 {
            tx.execute(
                "DELETE FROM histories WHERE secid NOT IN (SELECT secid FROM stocks)",
                vec![],
            )?;
            tx.execute(
                "DELETE FROM stock_boards WHERE secid NOT IN (SELECT secid FROM stocks)",
                vec![],
            )?;
        }
        Ok(removed)
    })?;

    // 官方板块成分变化后整段重算；self 板块由概念树决定，不受孤儿清理影响
    let (board_count, board_rows) = state
        .with_conn(|conn| {
            refresh_board_histories(conn, &["sw1:", "sw2:", "ths_hy:", "ths_gn:"])
        })
        .unwrap_or((0, 0));

    Ok(json!({
        "removed": removed,
        "boards": board_count,
        "board_rows": board_rows,
    }))
}

/// 全量保存 watchGroup：重建概念与成员，并按 zx 标记自选
#[tauri::command]
fn db_save_watchgroup(state: State<'_, Db>, groups: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&groups).map_err(|e| format!("解析自选数据失败: {e}"))?;

    let (
        stock_count,
        notion_count,
        member_count,
        removed_stocks,
        removed_histories,
        removed_links,
    ) = state.with_tx(|tx| {
        let prev_watched = collect_watched_secids(tx)?;
        tx.execute("DELETE FROM notion_stocks", vec![])?;
        tx.execute("DELETE FROM notions", vec![])?;
        // 自选由当前快照重建，先全部降级再按快照置回
        tx.execute("UPDATE stocks SET zx = 0", vec![])?;

        let (stock_count, notion_count, member_count) = fill_watchgroup(tx, &payload)?;
        // 自建概念同步为板块实体，供板块日K 统一聚合
        sync_self_boards(tx)?;

        // 只清理本次移出自选的股票；概念侧删除保留股票与日K，交由「数据校验」统一清理孤儿
        let removed_stocks = prune_deleted_watch_stocks(tx, &prev_watched)?;
        let removed_histories = tx.execute(
            "DELETE FROM histories WHERE secid NOT IN (SELECT secid FROM stocks)",
            vec![],
        )?;
        // 股票被移除后同步清理其板块成分关系
        let removed_links = tx.execute(
            "DELETE FROM stock_boards WHERE secid NOT IN (SELECT secid FROM stocks)",
            vec![],
        )?;

        Ok((
            stock_count,
            notion_count,
            member_count,
            removed_stocks,
            removed_histories,
            removed_links,
        ))
    })?;

    // 增删改自选/概念后整段重算：删除自选会连带删除股票及其全部板块成分关系，
    // 因此官方行业/行业板块/概念板块的成分也可能变化，一并重算
    let (board_count, board_rows) = state
        .with_conn(|conn| {
            refresh_board_histories(
                conn,
                &["self:", "sw1:", "sw2:", "ths_hy:", "ths_gn:"],
            )
        })
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
    state.with_conn(|conn| {
        let stocks: Vec<Value> = conn
            .query_d(
                "SELECT secid, name, zx, price, ratio, turnover_ratio
                 FROM stocks ORDER BY zx DESC, rowid",
                "SELECT secid, name, zx, price, ratio, turnover_ratio
                 FROM stocks ORDER BY zx DESC, row_id",
                vec![],
            )?
            .iter()
            .map(|row| {
                Ok(json!({
                    "secid": row.get::<_, String>(0).map_err(|e| e.to_string())?,
                    "name": row.get::<_, String>(1).map_err(|e| e.to_string())?,
                    "zx": row.get::<_, i64>(2).map_err(|e| e.to_string())? == 1,
                    "price": row.get::<_, Option<f64>>(3).map_err(|e| e.to_string())?,
                    "ratio": row.get::<_, Option<f64>>(4).map_err(|e| e.to_string())?,
                    "turnover_ratio": row.get::<_, Option<f64>>(5).map_err(|e| e.to_string())?,
                }))
            })
            .collect::<Result<Vec<_>, String>>()?;

        let notions: Vec<Value> = conn
            .query("SELECT id, name, pid, sort_order FROM notions ORDER BY sort_order, id", vec![])?
            .iter()
            .map(|row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0).map_err(|e| e.to_string())?,
                    "name": row.get::<_, String>(1).map_err(|e| e.to_string())?,
                    "pid": row.get::<_, Option<i64>>(2).map_err(|e| e.to_string())?,
                    "sort_order": row.get::<_, i64>(3).map_err(|e| e.to_string())?,
                }))
            })
            .collect::<Result<Vec<_>, String>>()?;

        let members: Vec<Value> = conn
            .query(
                "SELECT notion_id, secid, sort_order FROM notion_stocks
                 ORDER BY notion_id, sort_order",
                vec![],
            )?
            .iter()
            .map(|row| {
                Ok(json!({
                    "notion_id": row.get::<_, i64>(0).map_err(|e| e.to_string())?,
                    "secid": row.get::<_, String>(1).map_err(|e| e.to_string())?,
                    "sort_order": row.get::<_, i64>(2).map_err(|e| e.to_string())?,
                }))
            })
            .collect::<Result<Vec<_>, String>>()?;

        Ok(json!({ "stocks": stocks, "notions": notions, "members": members }))
    })
}

/// 行情快照时间（毫秒）。东财 f124 为交易所最后成交时间（秒），缺失/非法时返回 0（未知）。
/// 绝不回退本地当前时间：非交易日（尤其工作日节假日）或停牌股若用本地时间，
/// db_load_today_candle 会误判「今天刷新过行情」并合成一根假当日K线。
fn quote_stamp_ms(quote: &Value) -> i64 {
    num_of(quote.get("time"))
        .map(|secs| (secs * 1000.0) as i64)
        .filter(|stamp| *stamp > 0)
        .unwrap_or(0)
}

/// 本轮行情属于哪个交易日：取交易所成交时间的最大值的北京日期（固定 UTC+8）
fn quotes_synced_date(list: &[Value]) -> Option<String> {
    let max_stamp = list
        .iter()
        .map(quote_stamp_ms)
        .filter(|stamp| *stamp > 0)
        .max()?;
    Some(cst_date_minutes(max_stamp).0)
}

/// 实时行情批量写入 stocks（每轮刷新一个事务），并记录库级同步交易日。
/// 停牌/缺值字段沿用库内旧值，避免用 NULL 覆盖上一次的有效行情。
#[tauri::command]
fn db_save_quotes(state: State<'_, Db>, quotes: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&quotes).map_err(|e| format!("解析行情失败: {e}"))?;
    let list = payload.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        return Ok(json!({ "updated": 0 }));
    }

    let (updated, synced_date) = state.with_tx(|tx| {
        let mut updated = 0i64;
        let previous_synced = meta_get(tx, "quotes_synced_date")?;

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
            let stamp = quote_stamp_ms(quote);

            tx.execute_d(
                "INSERT INTO stocks (secid, name, open, high, low, pre_close, price_diff, price, ratio, amount, turnover_ratio, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(secid) DO UPDATE SET
                     name = CASE WHEN excluded.name = '' THEN stocks.name ELSE excluded.name END,
                     open = COALESCE(excluded.open, stocks.open),
                     high = COALESCE(excluded.high, stocks.high),
                     low = COALESCE(excluded.low, stocks.low),
                     pre_close = COALESCE(excluded.pre_close, stocks.pre_close),
                     price_diff = COALESCE(excluded.price_diff, stocks.price_diff),
                     price = COALESCE(excluded.price, stocks.price),
                     ratio = COALESCE(excluded.ratio, stocks.ratio),
                     amount = COALESCE(excluded.amount, stocks.amount),
                     turnover_ratio = COALESCE(excluded.turnover_ratio, stocks.turnover_ratio),
                     updated_at = CASE WHEN excluded.updated_at > 0 THEN excluded.updated_at ELSE stocks.updated_at END",
                "INSERT INTO stocks (secid, name, open, high, low, pre_close, price_diff, price, ratio, amount, turnover_ratio, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON DUPLICATE KEY UPDATE
                     name = CASE WHEN VALUES(name) = '' THEN stocks.name ELSE VALUES(name) END,
                     open = COALESCE(VALUES(open), stocks.open),
                     high = COALESCE(VALUES(high), stocks.high),
                     low = COALESCE(VALUES(low), stocks.low),
                     pre_close = COALESCE(VALUES(pre_close), stocks.pre_close),
                     price_diff = COALESCE(VALUES(price_diff), stocks.price_diff),
                     price = COALESCE(VALUES(price), stocks.price),
                     ratio = COALESCE(VALUES(ratio), stocks.ratio),
                     amount = COALESCE(VALUES(amount), stocks.amount),
                     turnover_ratio = COALESCE(VALUES(turnover_ratio), stocks.turnover_ratio),
                     updated_at = IF(VALUES(updated_at) > 0, VALUES(updated_at), stocks.updated_at)",
                p![
                    secid,
                    name,
                    num_of(quote.get("open")),
                    num_of(quote.get("high")),
                    num_of(quote.get("low")),
                    num_of(quote.get("pre_close")),
                    num_of(quote.get("price_diff")),
                    num_of(quote.get("price")),
                    num_of(quote.get("range")),
                    round2(num_of(quote.get("amount"))),
                    num_of(quote.get("turn")),
                    stamp
                ],
            )?;
            updated += 1;
        }

        // 库级同步交易日只前进不后退：避免盘中开盘前返回旧时间把标记改回去
        let current = quotes_synced_date(&list);
        let synced = match (&previous_synced, &current) {
            (Some(prev), Some(new)) if new.as_str() < prev.as_str() => Some(prev.clone()),
            (_, Some(new)) => Some(new.clone()),
            (Some(prev), None) => Some(prev.clone()),
            (None, None) => None,
        };
        if let Some(date) = &synced {
            if previous_synced.as_deref() != Some(date.as_str()) {
                meta_set(tx, "quotes_synced_date", date)?;
            }
        }
        Ok((updated, synced))
    })?;

    Ok(json!({ "updated": updated, "syncedDate": synced_date }))
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
    state.with_conn(|conn| {
        let row = conn.query_one(
            "SELECT price, open, high, low, updated_at, ratio, turnover_ratio FROM stocks WHERE secid = ?1",
            p![secid],
        )?;

        let Some(row) = row else {
            return Ok(json!({ "candle": null }));
        };
        let price: Option<f64> = row.get(0).map_err(|e| e.to_string())?;
        let open: Option<f64> = row.get(1).map_err(|e| e.to_string())?;
        let high: Option<f64> = row.get(2).map_err(|e| e.to_string())?;
        let low: Option<f64> = row.get(3).map_err(|e| e.to_string())?;
        let updated: Option<i64> = row.get(4).map_err(|e| e.to_string())?;
        let ratio: Option<f64> = row.get(5).map_err(|e| e.to_string())?;
        let turnover: Option<f64> = row.get(6).map_err(|e| e.to_string())?;

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
    })
}

/// 申万一级/二级、同花顺行业字段写回 stocks，并同步 boards/stock_boards 的成分关系。
/// 只更新库内已存在的股票：搜索预热会带回一批用户没添加的代码，不得凭空在 stocks
/// 里建空名占位行，也不得为未入库标的写板块成分，否则一次搜索会带进十几只「其它股票」。
fn save_industries(conn: &mut dyn SqlSession, list: &[Value]) -> Result<i64, String> {
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

        // 以库里真实 secid 为准：搜到的 6 位代码可能属于沪市基金/沪B 等，
        // 不能用首字符猜市场前缀，否则会写出 0.510300 这类错误标的
        let Some(row) = conn.query_one_d(
            "SELECT secid FROM stocks
             WHERE substr(secid, instr(secid, '.') + 1) = ?1 LIMIT 1",
            "SELECT secid FROM stocks
             WHERE SUBSTRING(secid, LOCATE('.', secid) + 1) = ?1 LIMIT 1",
            params![code],
        )?
        else {
            continue;
        };
        let secid = row.get::<_, String>(0).map_err(|e| e.to_string())?;

        conn.execute_d(
            "UPDATE stocks SET industry1 = ?2, industry2 = ?3, ths_industry = ?4,
                 industry_updated_at = ?5
             WHERE secid = ?1",
            "UPDATE stocks SET industry1 = ?2, industry2 = ?3, ths_industry = ?4,
                 industry_updated_at = ?5
             WHERE secid = ?1",
            params![secid, l1, l2, ths, now],
        )?;
        updated += 1;

        // 行业变了就换板块：先清掉这只股票旧的申万关系
        conn.execute(
            "DELETE FROM stock_boards
             WHERE secid = ?1 AND (board_key LIKE 'sw1:%' OR board_key LIKE 'sw2:%')",
            params![secid],
        )?;
        if !l1.is_empty() {
            let key = format!("sw1:{l1}");
            upsert_board(conn, &key, "sw", "industry", Some(1), None, l1, None)?;
            link_board(conn, &secid, &key, now)?;
        }
        if !l2.is_empty() {
            let key = format!("sw2:{l2}");
            let parent = if l1.is_empty() {
                None
            } else {
                Some(format!("sw1:{l1}"))
            };
            upsert_board(
                conn,
                &key,
                "sw",
                "industry",
                Some(2),
                None,
                l2,
                parent.as_deref(),
            )?;
            link_board(conn, &secid, &key, now)?;
        }
        // 同花顺行业只存板块名，需要从板块全表换成 board_key（全表还没抓到时先跳过）
        conn.execute(
            "DELETE FROM stock_boards WHERE secid = ?1 AND board_key LIKE 'ths_hy:%'",
            params![secid],
        )?;
        if !ths.is_empty() {
            let key_row = conn.query_one(
                "SELECT board_key FROM boards
                 WHERE source = 'ths' AND type = 'industry' AND name = ?1 LIMIT 1",
                params![ths],
            )?;
            let key = match key_row {
                Some(row) => Some(row.get::<_, String>(0).map_err(|e| e.to_string())?),
                None => None,
            };
            if let Some(key) = key {
                link_board(conn, &secid, &key, now)?;
            }
        }
    }
    Ok(updated)
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

    let updated = state.with_tx(|tx| save_industries(tx, &list))?;

    // 行业归属变化即板块成分变化：申万一级/二级与同花顺行业的板块历史整段重算
    let (board_count, board_rows) = state
        .with_conn(|conn| refresh_board_histories(conn, &["sw1:", "sw2:", "ths_hy:"]))
        .unwrap_or((0, 0));

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
    state.with_conn(|conn| {
        let mut items = Vec::new();
        for code in list {
            let code = code.trim().to_string();
            if code.is_empty() {
                continue;
            }
            let row = conn.query_one_d(
                "SELECT substr(secid, instr(secid, '.') + 1), industry1, industry2,
                        ths_industry, industry_updated_at
                 FROM stocks
                 WHERE substr(secid, instr(secid, '.') + 1) = ?1",
                "SELECT SUBSTRING(secid, LOCATE('.', secid) + 1), industry1, industry2,
                        ths_industry, industry_updated_at
                 FROM stocks
                 WHERE SUBSTRING(secid, LOCATE('.', secid) + 1) = ?1",
                params![code],
            )?;
            if let Some(row) = row {
                items.push(json!({
                    "code": row.get::<_, String>(0).map_err(|e| e.to_string())?,
                    "l1": row.get::<_, Option<String>>(1).map_err(|e| e.to_string())?,
                    "l2": row.get::<_, Option<String>>(2).map_err(|e| e.to_string())?,
                    "ths": row.get::<_, Option<String>>(3).map_err(|e| e.to_string())?,
                    "updated_at": row.get::<_, Option<i64>>(4).map_err(|e| e.to_string())?,
                }));
            }
        }
        Ok(json!(items))
    })
}

/// 读取同花顺行业板块全表，返回 { boards: {代码: 名称}, updated_at }
#[tauri::command]
fn db_load_boards(state: State<'_, Db>) -> Result<Value, String> {
    state.with_conn(|conn| {
        let rows = conn.query(
            "SELECT code, name, updated_at FROM boards
             WHERE source = 'ths' AND type = 'industry' AND code IS NOT NULL",
            vec![],
        )?;

        let mut boards = serde_json::Map::new();
        let mut updated_at = 0i64;
        for row in rows {
            let code: String = row.get(0).map_err(|e| e.to_string())?;
            let name: String = row.get(1).map_err(|e| e.to_string())?;
            let t: Option<i64> = row.get(2).map_err(|e| e.to_string())?;
            boards.insert(code, Value::String(name));
            if let Some(t) = t {
                updated_at = updated_at.max(t);
            }
        }
        Ok(json!({ "boards": boards, "updated_at": updated_at }))
    })
}

/// 全量替换同花顺行业板块（只重建 source='ths' 的行业板块，概念/申万/自建板块不受影响）
#[tauri::command]
fn db_save_boards(state: State<'_, Db>, boards: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&boards).map_err(|e| format!("解析板块数据失败: {e}"))?;
    let now = now_ms();
    let count = state.with_tx(|tx| {
        // 旧板块的成分为 881xxx 行业，整批重建
        tx.execute(
            "DELETE FROM stock_boards WHERE board_key LIKE 'ths_hy:%'",
            vec![],
        )?;
        tx.execute(
            "DELETE FROM boards WHERE source = 'ths' AND type = 'industry'",
            vec![],
        )?;

        let mut count = 0i64;
        if let Some(map) = payload.as_object() {
            for (code, name) in map {
                let name = name.as_str().unwrap_or("").trim();
                if code.is_empty() || name.is_empty() {
                    continue;
                }
                let key = format!("ths_hy:{code}");
                upsert_board(tx, &key, "ths", "industry", Some(1), Some(code), name, None)?;
                count += 1;
            }
        }
        // 板块名更新后补建成分关系：个股只存同花顺行业名称，行业抓取可能早于板块全表
        tx.execute_d(
            "INSERT OR IGNORE INTO stock_boards (secid, board_key, updated_at)
             SELECT s.secid, b.board_key, ?1
             FROM stocks s JOIN boards b
                  ON b.source = 'ths' AND b.type = 'industry' AND b.name = s.ths_industry
             WHERE s.ths_industry IS NOT NULL AND s.ths_industry <> ''",
            "INSERT IGNORE INTO stock_boards (secid, board_key, updated_at)
             SELECT s.secid, b.board_key, ?1
             FROM stocks s JOIN boards b
                  ON b.source = 'ths' AND b.type = 'industry' AND b.name = s.ths_industry
             WHERE s.ths_industry IS NOT NULL AND s.ths_industry <> ''",
            params![now],
        )?;
        Ok(count)
    })?;

    // 同花顺行业板块全表重建后成分关系可能整体变化，板块历史整段重算
    let (board_count, board_rows) = state
        .with_conn(|conn| refresh_board_histories(conn, &["ths_hy:"]))
        .unwrap_or((0, 0));

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
    state.with_conn(|conn| {
        // days 为空或 <=0 时返回全部历史（2024-01-01 起），正数表示只取最近 N 个交易日
        let limit = days.filter(|days| *days > 0).unwrap_or(i64::MAX);
        // 库内完整覆盖区间（不受展示窗口限制），前端据此决定整段补齐还是增量更新
        let range_row = conn
            .query_one(
                "SELECT MIN(trade_date), MAX(trade_date) FROM sckd WHERE trade_date >= ?1",
                params![MARKET_WIDTH_MIN_DATE],
            )?
            .ok_or_else(|| "市场宽度统计失败".to_string())?;
        let range_first: Option<String> = range_row.get(0).map_err(|e| e.to_string())?;
        let range_last: Option<String> = range_row.get(1).map_err(|e| e.to_string())?;

        let mut dates: Vec<String> = conn
            .query(
                "SELECT DISTINCT trade_date FROM sckd
                 WHERE trade_date >= ?2
                 ORDER BY trade_date DESC LIMIT ?1",
                params![limit, MARKET_WIDTH_MIN_DATE],
            )?
            .iter()
            .map(|row| row.get::<_, String>(0).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, String>>()?;
        if dates.is_empty() {
            return Ok(json!({
                "dates": [],
                "rows": [],
                "range": { "first": range_first, "last": range_last },
            }));
        }
        dates.reverse();
        let first = dates.first().cloned().unwrap_or_default();

        let industries: Vec<(String, String)> = conn
            .query(
                "SELECT industry_code, MAX(industry_name), MAX(sort_order)
                 FROM sckd WHERE trade_date >= ?1
                 GROUP BY industry_code
                 ORDER BY MAX(sort_order), industry_code",
                params![first],
            )?
            .iter()
            .map(|row| {
                Ok((
                    row.get::<_, String>(0).map_err(|e| e.to_string())?,
                    row.get::<_, String>(1).map_err(|e| e.to_string())?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;

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

        let values: Vec<(String, String, f64)> = conn
            .query(
                "SELECT trade_date, industry_code, value20 FROM sckd
                 WHERE trade_date >= ?1 AND value20 IS NOT NULL",
                params![first],
            )?
            .iter()
            .map(|row| {
                Ok((
                    row.get::<_, String>(0).map_err(|e| e.to_string())?,
                    row.get::<_, String>(1).map_err(|e| e.to_string())?,
                    row.get::<_, f64>(2).map_err(|e| e.to_string())?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        for (date, code, value) in values {
            let (Some(&row_index), Some(&col_index)) =
                (position.get(&code), date_index.get(date.as_str()))
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
    })
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

    let now = now_ms();
    let saved = state.with_tx(|tx| {
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
                tx.execute_d(
                    "INSERT INTO sckd (trade_date, industry_code, industry_name, value20, sort_order, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(trade_date, industry_code) DO UPDATE SET
                         industry_name = excluded.industry_name,
                         value20 = excluded.value20,
                         sort_order = excluded.sort_order,
                         updated_at = excluded.updated_at",
                    "INSERT INTO sckd (trade_date, industry_code, industry_name, value20, sort_order, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON DUPLICATE KEY UPDATE
                         industry_name = VALUES(industry_name),
                         value20 = VALUES(value20),
                         sort_order = VALUES(sort_order),
                         updated_at = VALUES(updated_at)",
                    params![date, code, name, value, order as i64, now],
                )?;
                saved += 1;
            }
        }
        Ok(saved)
    })?;
    Ok(json!({ "saved": saved, "dates": dates.len(), "updated_at": now }))
}

/// 官方概念成分写入 boards/stock_boards（source='ths', type='concept'）。
/// 入参：[{ code: "600519", concepts: [{ code: "885761", name: "白酒" }] }]
/// 只处理库内已存在的股票：搜索预热不得为未添加的代码建空名占位行与概念成分。
fn save_stock_concepts(
    conn: &mut dyn SqlSession,
    list: &[Value],
) -> Result<(i64, i64), String> {
    let now = now_ms();
    let mut updated = 0i64;
    let mut relations = 0i64;

    for item in list.iter() {
        let code = item.get("code").and_then(|v| v.as_str()).unwrap_or("").trim();
        if code.is_empty() {
            continue;
        }
        // 以库里真实 secid 为准，未入库的代码直接跳过（不建行、不写板块成分）
        let Some(row) = conn.query_one_d(
            "SELECT secid FROM stocks
             WHERE substr(secid, instr(secid, '.') + 1) = ?1 LIMIT 1",
            "SELECT secid FROM stocks
             WHERE SUBSTRING(secid, LOCATE('.', secid) + 1) = ?1 LIMIT 1",
            params![code],
        )?
        else {
            continue;
        };
        let secid = row.get::<_, String>(0).map_err(|e| e.to_string())?;

        // 概念归属会变化：先清掉这只股票旧的官方概念关系
        conn.execute(
            "DELETE FROM stock_boards WHERE secid = ?1 AND board_key LIKE 'ths_gn:%'",
            params![secid],
        )?;

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
            upsert_board(conn, &key, "ths", "concept", Some(1), code_value, name, None)?;
            link_board(conn, &secid, &key, now)?;
            relations += 1;
        }
        updated += 1;
    }
    Ok((updated, relations))
}

/// 官方概念成分写入 boards/stock_boards（source='ths', type='concept'）
#[tauri::command]
fn db_save_stock_concepts(state: State<'_, Db>, rows: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&rows).map_err(|e| format!("解析概念数据失败: {e}"))?;
    let list = payload.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        return Ok(json!({ "updated": 0, "relations": 0 }));
    }

    let (updated, relations) = state.with_tx(|tx| save_stock_concepts(tx, &list))?;

    // 官方概念归属变化：概念板块历史整段重算
    let (board_count, board_rows) = state
        .with_conn(|conn| refresh_board_histories(conn, &["ths_gn:"]))
        .unwrap_or((0, 0));

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
/// limit 为 None 取全部历史；否则只取最近 limit 个交易日。
/// 停牌处理：成分股在某交易日无成交时按 0% 计入分母（成交额计 0），
/// 复牌首日用停牌前最后一个收盘价作为前收，避免把停牌期间的变动算成单日涨跌。
fn accumulate_board_days(
    conn: &mut dyn SqlSession,
    board_key: &str,
    limit: Option<i64>,
) -> Result<BTreeMap<String, DayAgg>, String> {
    let members: Vec<String> = conn
        .query(
            "SELECT secid FROM stock_boards WHERE board_key = ?1",
            params![board_key],
        )?
        .iter()
        .map(|row| row.get::<_, String>(0).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, String>>()?;
    if members.is_empty() {
        return Ok(BTreeMap::new());
    }

    // 交易日轴 = 板块成分股有效收盘日期的并集（停牌日由各股按 0% 补入分母）
    let take = limit.unwrap_or(i64::MAX);
    let mut dates: Vec<String> = conn
        .query(
            "SELECT DISTINCT date FROM histories
             WHERE secid IN (SELECT secid FROM stock_boards WHERE board_key = ?1)
               AND close IS NOT NULL AND close > 0
             ORDER BY date DESC LIMIT ?2",
            params![board_key, take],
        )?
        .iter()
        .map(|row| row.get::<_, String>(0).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, String>>()?;
    dates.reverse();
    let Some(window_start) = dates.first().cloned() else {
        return Ok(BTreeMap::new());
    };

    let mut acc: BTreeMap<String, DayAgg> = BTreeMap::new();
    for secid in members.iter() {
        let rows: Vec<(String, f64, Option<f64>)> = conn
            .query(
                "SELECT date, close, amount FROM histories
                 WHERE secid = ?1 AND close IS NOT NULL AND close > 0 AND date >= ?2
                 ORDER BY date ASC",
                params![secid, window_start],
            )?
            .iter()
            .map(|row| {
                Ok((
                    row.get::<_, String>(0).map_err(|e| e.to_string())?,
                    row.get::<_, f64>(1).map_err(|e| e.to_string())?,
                    row.get::<_, Option<f64>>(2).map_err(|e| e.to_string())?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut by_date: HashMap<String, (f64, Option<f64>)> = HashMap::new();
        for (date, close, amount) in rows {
            by_date.insert(date, (close, amount));
        }

        // 窗口起点之前的最后收盘价：作为窗口首日/停牌期间的前收
        let carry = conn.query_one(
            "SELECT close FROM histories
             WHERE secid = ?1 AND close IS NOT NULL AND close > 0 AND date < ?2
             ORDER BY date DESC LIMIT 1",
            params![secid, window_start],
        )?;
        let mut prev_close = match carry {
            Some(row) => Some(row.get::<_, f64>(0).map_err(|e| e.to_string())?),
            None => None,
        };

        for date in dates.iter() {
            match by_date.get(date) {
                Some((close, amount)) => {
                    if let Some(prev) = prev_close {
                        let entry = acc.entry(date.clone()).or_default();
                        entry.sum_pct += close / prev - 1.0;
                        entry.count += 1;
                        if let Some(amount) = amount {
                            entry.sum_amount += *amount;
                        }
                    }
                    prev_close = Some(*close);
                }
                // 停牌/无成交：按 0% 计入分母（未上市时没有前收，不参与）
                None => {
                    if prev_close.is_some() {
                        acc.entry(date.clone()).or_default().count += 1;
                    }
                }
            }
        }
    }

    // 整天没有任何可参与计算的成分股（板块首个交易日等）不落库
    acc.retain(|_, agg| agg.count > 0);
    Ok(acc)
}

/// 整段重算板块日线：以最早一天 100 为基准，逐日累乘等权涨跌幅后落库。
/// 成分股或复权基准变化后历史涨跌幅会整体变化，必须走整段重算。
fn full_rebuild_board_history(conn: &mut dyn SqlSession, board_key: &str) -> Result<i64, String> {
    let acc = accumulate_board_days(conn, board_key, None)?;
    conn.execute(
        "DELETE FROM board_histories WHERE board_key = ?1",
        params![board_key],
    )?;

    let mut index = 100.0f64;
    let mut rows = 0i64;
    for (date, agg) in acc.iter() {
        let day_pct = day_pct_of(agg);
        index *= 1.0 + day_pct;
        conn.execute_d(
            "INSERT OR REPLACE INTO board_histories (board_key, date, close, pct, amount, members)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            "REPLACE INTO board_histories (board_key, date, close, pct, amount, members)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                board_key,
                date,
                index,
                day_pct * 100.0,
                agg.sum_amount,
                agg.count
            ],
        )?;
        rows += 1;
    }
    Ok(rows)
}

/// 增量刷新最近 days 个交易日：以首个增量日之前已存的收盘指数为基准向后累乘。
/// 没有基准（首次计算或窗口超出已有历史）时退回整段重算，保证结果与整段重算一致。
fn incremental_update_board_history(
    conn: &mut dyn SqlSession,
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
    let base_row = conn.query_one(
        "SELECT close FROM board_histories
         WHERE board_key = ?1 AND date < ?2
         ORDER BY date DESC LIMIT 1",
        params![board_key, first],
    )?;
    let base = match base_row {
        Some(row) => Some(row.get::<_, f64>(0).map_err(|e| e.to_string())?),
        None => None,
    };
    let Some(mut index) = base else {
        return full_rebuild_board_history(conn, board_key);
    };

    conn.execute(
        "DELETE FROM board_histories WHERE board_key = ?1 AND date >= ?2",
        params![board_key, first],
    )?;
    let mut rows = 0i64;
    for date in dates[start..].iter() {
        let agg = &acc[date];
        let day_pct = day_pct_of(agg);
        index *= 1.0 + day_pct;
        conn.execute_d(
            "INSERT OR REPLACE INTO board_histories (board_key, date, close, pct, amount, members)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            "REPLACE INTO board_histories (board_key, date, close, pct, amount, members)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                board_key,
                date,
                index,
                day_pct * 100.0,
                agg.sum_amount,
                agg.count
            ],
        )?;
        rows += 1;
    }
    Ok(rows)
}

/// 从指定日期起重算板块尾段：该日之前的落库数据保持不动，
/// 以该日之前最近一条已存收盘指数为基准向后累乘。
/// 若中间缺行（数据被整体改写）则退回整段重算，保证与整段结果一致。
fn rebuild_board_history_from(
    conn: &mut dyn SqlSession,
    board_key: &str,
    from_date: &str,
) -> Result<i64, String> {
    let tail_count: i64 = conn
        .query_one(
            "SELECT COUNT(*) FROM board_histories WHERE board_key = ?1 AND date >= ?2",
            params![board_key, from_date],
        )?
        .ok_or_else(|| "板块历史查询失败".to_string())?
        .get(0)
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
        .query_one(
            "SELECT COUNT(*) FROM board_histories
             WHERE board_key = ?1 AND date >= ?2 AND date < ?3",
            params![board_key, from_date, first],
        )?
        .ok_or_else(|| "板块历史查询失败".to_string())?
        .get(0)
        .map_err(|e| e.to_string())?;
    if gap > 0 {
        return full_rebuild_board_history(conn, board_key);
    }

    let base_row = conn.query_one(
        "SELECT close FROM board_histories
         WHERE board_key = ?1 AND date < ?2
         ORDER BY date DESC LIMIT 1",
        params![board_key, first],
    )?;
    let base = match base_row {
        Some(row) => Some(row.get::<_, f64>(0).map_err(|e| e.to_string())?),
        None => None,
    };
    let Some(mut index) = base else {
        return full_rebuild_board_history(conn, board_key);
    };

    conn.execute(
        "DELETE FROM board_histories WHERE board_key = ?1 AND date >= ?2",
        params![board_key, first],
    )?;
    let mut rows = 0i64;
    for date in dates.iter() {
        let agg = &acc[date];
        let day_pct = day_pct_of(agg);
        index *= 1.0 + day_pct;
        conn.execute_d(
            "INSERT OR REPLACE INTO board_histories (board_key, date, close, pct, amount, members)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            "REPLACE INTO board_histories (board_key, date, close, pct, amount, members)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                board_key,
                date,
                index,
                day_pct * 100.0,
                agg.sum_amount,
                agg.count
            ],
        )?;
        rows += 1;
    }
    Ok(rows)
}

/// 某只成分股日线被改写后，重算包含它的板块历史。
/// from_date 为改写的起始日期：None 表示复权基准变动（整段重算），
/// Some(d) 表示只从该日（含）向后重算尾段。
fn refresh_boards_for_secid(
    conn: &mut dyn SqlSession,
    secid: &str,
    from_date: Option<&str>,
) -> Result<(i64, i64), String> {
    let keys: Vec<String> = conn
        .query(
            "SELECT board_key FROM stock_boards WHERE secid = ?1",
            params![secid],
        )?
        .iter()
        .map(|row| row.get::<_, String>(0).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, String>>()?;

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
fn clean_orphan_board_histories(conn: &mut dyn SqlSession) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM board_histories WHERE board_key NOT IN (SELECT board_key FROM boards)",
        vec![],
    )
}

/// 指定前缀（如 self:/ths_gn:）的板块在成分变化后整段重算，返回 (板块数, 写入行数)
fn refresh_board_histories(
    conn: &mut dyn SqlSession,
    prefixes: &[&str],
) -> Result<(i64, i64), String> {
    let mut keys: Vec<String> = Vec::new();
    for prefix in prefixes {
        let pattern = format!("{prefix}%");
        let list: Vec<String> = conn
            .query(
                "SELECT board_key FROM boards WHERE board_key LIKE ?1",
                params![pattern],
            )?
            .iter()
            .map(|row| row.get::<_, String>(0).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, String>>()?;
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
/// 聚合算法升级（停牌日按 0% 计入分母）后，首次启动对全部板块整段重算一次。
#[tauri::command]
fn db_refresh_board_history(state: State<'_, Db>, days: Option<i64>) -> Result<Value, String> {
    let days = days.unwrap_or(5).clamp(1, 60);
    state.with_conn(|conn| {
        let orphans = clean_orphan_board_histories(conn)?;

        let algo_version = conn
            .query_one_d(
                "SELECT value FROM meta WHERE key = 'board_algo_version'",
                "SELECT value FROM meta WHERE `key` = 'board_algo_version'",
                vec![],
            )?
            .map(|row| row.get::<_, String>(0))
            .transpose()
            .map_err(|e| e.to_string())?;
        let upgrade = algo_version.as_deref() != Some("2");

        let list: Vec<(String, i64)> = conn
            .query(
                "SELECT b.board_key,
                        (SELECT COUNT(*) FROM board_histories h WHERE h.board_key = b.board_key)
                 FROM boards b ORDER BY b.board_key",
                vec![],
            )?
            .iter()
            .map(|row| {
                Ok((
                    row.get::<_, String>(0).map_err(|e| e.to_string())?,
                    row.get::<_, i64>(1).map_err(|e| e.to_string())?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let board_count = list.len() as i64;

        let mut refreshed = 0i64;
        let mut rebuilt = 0i64;
        let mut rows = 0i64;
        for (key, stored) in list.iter() {
            if upgrade || *stored == 0 {
                rows += full_rebuild_board_history(conn, key)?;
                rebuilt += 1;
            } else {
                rows += incremental_update_board_history(conn, key, days)?;
                refreshed += 1;
            }
        }

        if upgrade {
            conn.execute_d(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('board_algo_version', ?1)",
                "INSERT INTO meta (`key`, value) VALUES ('board_algo_version', ?1)
                 ON DUPLICATE KEY UPDATE value = VALUES(value)",
                params!["2"],
            )?;
        }

        Ok(json!({
            "days": days,
            "boards": board_count,
            "refreshed": refreshed,
            "rebuilt": rebuilt,
            "rows": rows,
            "orphans": orphans,
            "algoUpgraded": upgrade,
        }))
    })
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
    state.with_conn(|conn| {
        let second_like = if scope == "sw" { "sw2:%" } else { "" };
        let list: Vec<(String, String, Option<i64>, Option<String>)> = conn
            .query(
                "SELECT board_key, name, level, parent_key FROM boards
                 WHERE board_key LIKE ?1 OR board_key LIKE ?2
                 ORDER BY name",
                params![if scope == "sw" { "sw1:%" } else { "ths_hy:%" }, second_like],
            )?
            .iter()
            .map(|row| {
                Ok((
                    row.get::<_, String>(0).map_err(|e| e.to_string())?,
                    row.get::<_, String>(1).map_err(|e| e.to_string())?,
                    row.get::<_, Option<i64>>(2).map_err(|e| e.to_string())?,
                    row.get::<_, Option<String>>(3).map_err(|e| e.to_string())?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;

        let mut boards = Vec::new();
        for (key, name, level, parent) in list {
            let members: Vec<String> = conn
                .query(
                    "SELECT secid FROM stock_boards WHERE board_key = ?1 ORDER BY secid",
                    params![key],
                )?
                .iter()
                .map(|row| row.get::<_, String>(0).map_err(|e| e.to_string()))
                .collect::<Result<Vec<_>, String>>()?;
            // 同花顺行业板块是全量目录，本地没有成分股的板块既算不出行情也没有 MACD，直接不列出
            if members.is_empty() {
                continue;
            }
            // 板块尚未计算过历史时先整段重算，保证 MACD 有数据
            let stored: i64 = conn
                .query_one(
                    "SELECT COUNT(*) FROM board_histories WHERE board_key = ?1",
                    params![key],
                )?
                .ok_or_else(|| "板块历史查询失败".to_string())?
                .get(0)
                .map_err(|e| e.to_string())?;
            if stored == 0 {
                full_rebuild_board_history(conn, &key)?;
            }
            let closes: Vec<f64> = conn
                .query(
                    "SELECT close FROM board_histories
                     WHERE board_key = ?1 AND close IS NOT NULL ORDER BY date",
                    params![key],
                )?
                .iter()
                .map(|row| row.get::<_, f64>(0).map_err(|e| e.to_string()))
                .collect::<Result<Vec<_>, String>>()?;
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
    })
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
    state.with_conn(|conn| {
        let board = conn.query_one(
            "SELECT name, source, type, level FROM boards WHERE board_key = ?1",
            params![board_key],
        )?;
        let Some(board) = board else {
            return Ok(json!({
                "board": null, "dates": [], "close": [], "pct": [], "amount": [], "members": 0
            }));
        };
        let name: String = board.get(0).map_err(|e| e.to_string())?;
        let source: String = board.get(1).map_err(|e| e.to_string())?;
        let kind: String = board.get(2).map_err(|e| e.to_string())?;
        let level: Option<i64> = board.get(3).map_err(|e| e.to_string())?;

        let limit = limit.unwrap_or(250).clamp(1, 2000);
        let stored: i64 = conn
            .query_one(
                "SELECT COUNT(*) FROM board_histories WHERE board_key = ?1",
                params![board_key],
            )?
            .ok_or_else(|| "板块历史查询失败".to_string())?
            .get(0)
            .map_err(|e| e.to_string())?;
        if stored == 0 {
            full_rebuild_board_history(conn, &board_key)?;
        }

        let members: i64 = conn
            .query_one(
                "SELECT COUNT(*) FROM stock_boards WHERE board_key = ?1",
                params![board_key],
            )?
            .ok_or_else(|| "板块成分查询失败".to_string())?
            .get(0)
            .map_err(|e| e.to_string())?;

        let rows: Vec<(String, Option<f64>, Option<f64>, Option<f64>)> = conn
            .query(
                "SELECT date, close, pct, amount FROM board_histories
                 WHERE board_key = ?1 ORDER BY date DESC LIMIT ?2",
                params![board_key, limit],
            )?
            .iter()
            .map(|row| {
                Ok((
                    row.get::<_, String>(0).map_err(|e| e.to_string())?,
                    row.get::<_, Option<f64>>(1).map_err(|e| e.to_string())?,
                    row.get::<_, Option<f64>>(2).map_err(|e| e.to_string())?,
                    row.get::<_, Option<f64>>(3).map_err(|e| e.to_string())?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;

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
    })
}

/// 写入一批日K（同一 secid + date 覆盖），amount 由元换算为亿，不做小数舍入
fn write_candles(
    conn: &mut dyn SqlSession,
    secid: &str,
    list: &[Value],
) -> Result<i64, String> {
    let mut saved = 0i64;
    for candle in list.iter() {
        let date = candle.get("date").and_then(|v| v.as_str()).unwrap_or("");
        // 早于统一起点的K线（腾讯兜底可能返回 beg 之前的远古数据）一律不入库
        if date.is_empty() || date < HISTORY_MIN_DATE {
            continue;
        }
        conn.execute_d(
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
            "INSERT INTO histories (secid, date, open, close, high, low, volume, amount, ratio, turnover_ratio)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON DUPLICATE KEY UPDATE
                 open = VALUES(open),
                 close = VALUES(close),
                 high = VALUES(high),
                 low = VALUES(low),
                 volume = VALUES(volume),
                 amount = VALUES(amount),
                 ratio = VALUES(ratio),
                 turnover_ratio = VALUES(turnover_ratio)",
            params![
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
            ],
        )?;
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

    let saved = state.with_tx(|tx| write_candles(tx, &secid, &list))?;

    // 成分股日线被改写：从最早写入日向后重算相关板块的尾段历史
    let first_date = list
        .iter()
        .filter_map(|c| c.get("date").and_then(|v| v.as_str()))
        .filter(|d| !d.is_empty())
        .min()
        .map(|d| d.to_string());
    let (board_count, board_rows) = match first_date.as_deref() {
        Some(date) => state
            .with_conn(|conn| refresh_boards_for_secid(conn, &secid, Some(date)))
            .unwrap_or((0, 0)),
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

    let (removed, saved) = state.with_tx(|tx| {
        let removed = tx.execute("DELETE FROM histories WHERE secid = ?1", params![secid])?;
        let saved = write_candles(tx, &secid, &list)?;
        Ok((removed, saved))
    })?;

    // 整段重拉（复权基准变动）会改写已有历史涨跌幅，包含该股的板块必须整段重算
    let (board_count, board_rows) = state
        .with_conn(|conn| refresh_boards_for_secid(conn, &secid, None))
        .unwrap_or((0, 0));

    Ok(json!({
        "removed": removed,
        "saved": saved,
        "boards": board_count,
        "board_rows": board_rows,
    }))
}

/// 删除指定日期（全部股票）的日K，用于未收盘时清理当天残留
fn prune_history_date(conn: &mut dyn SqlSession, date: &str) -> Result<usize, String> {
    conn.execute("DELETE FROM histories WHERE date = ?1", params![date])
}

/// 区间替换：先删除 [beg, end] 区间内的行，再写入
fn delete_and_write_history_range(
    conn: &mut dyn SqlSession,
    secid: &str,
    beg: &str,
    end: &str,
    list: &[Value],
) -> Result<(usize, i64), String> {
    let removed = conn.execute(
        "DELETE FROM histories WHERE secid = ?1 AND date >= ?2 AND date <= ?3",
        params![secid, beg, end],
    )?;
    let saved = write_candles(conn, secid, list)?;
    Ok((removed, saved))
}

/// 未收盘时清理当天残留的K线：15:15 前当天K线必然不完整，删除后由补齐链路重新拉取
#[tauri::command]
fn db_prune_today_history(state: State<'_, Db>, date: String) -> Result<Value, String> {
    if !is_valid_date(&date) {
        return Err("日期格式应为 yyyy-MM-dd".to_string());
    }
    let removed = state.with_conn(|conn| prune_history_date(conn, &date))?;
    Ok(json!({ "removed": removed }))
}

/// 区间替换某股票的日K：先删除 [beg, end] 区间内的行，再写入；
/// 用于全量重拉时清理源端已不存在的日期（避免合并写入残留陈旧行）
#[tauri::command]
fn db_replace_history_range(
    state: State<'_, Db>,
    secid: String,
    beg: String,
    end: String,
    candles: String,
) -> Result<Value, String> {
    if !is_valid_date(&beg) || !is_valid_date(&end) {
        return Err("日期格式应为 yyyy-MM-dd".to_string());
    }
    if secid.is_empty() || beg > end {
        return Err("区间参数无效".to_string());
    }
    let payload: Value =
        serde_json::from_str(&candles).map_err(|e| format!("解析K线数据失败: {e}"))?;
    let list = payload.as_array().cloned().unwrap_or_default();

    let (removed, saved) = state.with_tx(|tx| {
        delete_and_write_history_range(tx, &secid, &beg, &end, &list)
    })?;

    let (board_count, board_rows) = state
        .with_conn(|conn| refresh_boards_for_secid(conn, &secid, Some(&beg)))
        .unwrap_or((0, 0));

    Ok(json!({
        "removed": removed,
        "saved": saved,
        "boards": board_count,
        "board_rows": board_rows,
    }))
}

/// 需要补齐的股票：自选股，或仍属于某个概念且已有历史的股票；孤儿股票不参与每日补齐
fn list_history_targets(conn: &mut dyn SqlSession) -> Result<Vec<Value>, String> {
    conn.query_d(
        "SELECT s.secid,
                (SELECT MAX(h.date) FROM histories h WHERE h.secid = s.secid),
                (SELECT COUNT(*) FROM histories h WHERE h.secid = s.secid
                 AND (h.volume IS NULL OR h.ratio IS NULL OR h.turnover_ratio IS NULL))
         FROM stocks s
         WHERE s.zx = 1
            OR (EXISTS (SELECT 1 FROM histories h2 WHERE h2.secid = s.secid)
                AND EXISTS (SELECT 1 FROM notion_stocks ns WHERE ns.secid = s.secid))
         ORDER BY s.rowid",
        "SELECT s.secid,
                (SELECT MAX(h.date) FROM histories h WHERE h.secid = s.secid),
                (SELECT COUNT(*) FROM histories h WHERE h.secid = s.secid
                 AND (h.volume IS NULL OR h.ratio IS NULL OR h.turnover_ratio IS NULL))
         FROM stocks s
         WHERE s.zx = 1
            OR (EXISTS (SELECT 1 FROM histories h2 WHERE h2.secid = s.secid)
                AND EXISTS (SELECT 1 FROM notion_stocks ns WHERE ns.secid = s.secid))
         ORDER BY s.row_id",
        vec![],
    )?
    .iter()
    .map(|row| {
        Ok(json!({
            "secid": row.get::<_, String>(0).map_err(|e| e.to_string())?,
            "last_date": row.get::<_, Option<String>>(1).map_err(|e| e.to_string())?,
            "missing_fields": row.get::<_, i64>(2).map_err(|e| e.to_string())?,
        }))
    })
    .collect::<Result<Vec<_>, String>>()
}

/// 自选股票（zx=1）及其本地日K最新日期、缺字段行数，供启动时补齐
#[tauri::command]
fn db_history_targets(state: State<'_, Db>) -> Result<Value, String> {
    state.with_conn(|conn| {
        let targets = list_history_targets(conn)?;
        Ok(json!({ "targets": targets }))
    })
}

/// 读取本地日 K（升序），接口不可用时作为兜底；amount 单位仍为亿
#[tauri::command]
fn db_load_history(
    state: State<'_, Db>,
    secid: String,
    limit: i64,
) -> Result<Value, String> {
    state.with_conn(|conn| {
        let limit = if limit <= 0 { 400 } else { limit.min(5000) };
        let mut list: Vec<Value> = conn
            .query(
                "SELECT date, open, close, high, low, volume, amount, ratio, turnover_ratio FROM histories
                 WHERE secid = ?1
                 ORDER BY date DESC LIMIT ?2",
                params![secid, limit],
            )?
            .iter()
            .map(|row| {
                Ok(json!({
                    "date": row.get::<_, String>(0).map_err(|e| e.to_string())?,
                    "open": row.get::<_, Option<f64>>(1).map_err(|e| e.to_string())?,
                    "close": row.get::<_, Option<f64>>(2).map_err(|e| e.to_string())?,
                    "high": row.get::<_, Option<f64>>(3).map_err(|e| e.to_string())?,
                    "low": row.get::<_, Option<f64>>(4).map_err(|e| e.to_string())?,
                    "volume": row.get::<_, Option<f64>>(5).map_err(|e| e.to_string())?,
                    "amount": row.get::<_, Option<f64>>(6).map_err(|e| e.to_string())?,
                    "ratio": row.get::<_, Option<f64>>(7).map_err(|e| e.to_string())?,
                    "turnover_ratio": row.get::<_, Option<f64>>(8).map_err(|e| e.to_string())?,
                }))
            })
            .collect::<Result<Vec<_>, String>>()?;
        list.reverse();

        Ok(json!({ "candles": list }))
    })
}

/// 校验 yyyy-MM-dd 日期（含闰年判断）
fn is_valid_date(value: &str) -> bool {
    if value.len() != 10 {
        return false;
    }
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        parts[0].parse::<i32>(),
        parts[1].parse::<u32>(),
        parts[2].parse::<u32>(),
    ) else {
        return false;
    };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    day >= 1 && day <= max_day
}

/// 清理已经结束的非重复事件（结束日期早于今天；当天结束仍视为进行中）
fn prune_ended_calendar_events(conn: &mut dyn SqlSession) -> Result<usize, String> {
    conn.execute_d(
        "DELETE FROM calendar_events
         WHERE repeat_type = 'none' AND end_date < date('now', 'localtime')",
        "DELETE FROM calendar_events
         WHERE repeat_type = 'none' AND end_date < CURDATE()",
        vec![],
    )
}

/// 读取全部日历事件（按开始日期升序）
#[tauri::command]
fn db_load_calendar_events(state: State<'_, Db>) -> Result<Value, String> {
    state.with_conn(|conn| {
        prune_ended_calendar_events(conn)?;
        let events: Vec<Value> = conn
            .query(
                "SELECT id, name, start_date, end_date, repeat_type, created_at, updated_at
                 FROM calendar_events ORDER BY start_date ASC, id ASC",
                vec![],
            )?
            .iter()
            .map(|row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0).map_err(|e| e.to_string())?,
                    "name": row.get::<_, String>(1).map_err(|e| e.to_string())?,
                    "start_date": row.get::<_, String>(2).map_err(|e| e.to_string())?,
                    "end_date": row.get::<_, String>(3).map_err(|e| e.to_string())?,
                    "repeat_type": row.get::<_, String>(4).map_err(|e| e.to_string())?,
                    "created_at": row.get::<_, i64>(5).map_err(|e| e.to_string())?,
                    "updated_at": row.get::<_, i64>(6).map_err(|e| e.to_string())?,
                }))
            })
            .collect::<Result<Vec<_>, String>>()?;

        Ok(json!({ "events": events }))
    })
}

/// 新增或修改日历事件（payload 含 id 时为修改）
#[tauri::command]
fn db_save_calendar_event(state: State<'_, Db>, payload: String) -> Result<Value, String> {
    let data: Value =
        serde_json::from_str(&payload).map_err(|e| format!("解析事件数据失败: {e}"))?;
    let name = data
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let start_date = data
        .get("start_date")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let end_date = data
        .get("end_date")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let repeat_type = match data.get("repeat_type").and_then(|v| v.as_str()) {
        Some("monthly") => "monthly",
        Some("yearly") => "yearly",
        _ => "none",
    };

    if name.is_empty() {
        return Err("事件名称不能为空".into());
    }
    if !is_valid_date(&start_date) || !is_valid_date(&end_date) {
        return Err("日期格式应为 yyyy-MM-dd".into());
    }
    if end_date < start_date {
        return Err("结束日期不能早于开始日期".into());
    }

    state.with_conn(|conn| {
        let now = now_ms();
        if let Some(id) = data.get("id").and_then(|v| v.as_i64()) {
            let updated = conn.execute(
                "UPDATE calendar_events
                 SET name = ?1, start_date = ?2, end_date = ?3, repeat_type = ?4, updated_at = ?5
                 WHERE id = ?6",
                params![name, start_date, end_date, repeat_type, now, id],
            )?;
            if updated == 0 {
                return Err("事件不存在".into());
            }
            return Ok(json!({ "id": id }));
        }

        conn.execute(
            "INSERT INTO calendar_events (name, start_date, end_date, repeat_type, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![name, start_date, end_date, repeat_type, now, now],
        )?;
        Ok(json!({ "id": conn.last_insert_id()? }))
    })
}

/// 删除日历事件
#[tauri::command]
fn db_delete_calendar_event(state: State<'_, Db>, id: i64) -> Result<Value, String> {
    state.with_conn(|conn| {
        let removed = conn.execute("DELETE FROM calendar_events WHERE id = ?1", params![id])?;
        Ok(json!({ "removed": removed }))
    })
}

/// 迁移结果概览，便于调试与验证
#[tauri::command]
fn db_stats(state: State<'_, Db>) -> Result<Value, String> {
    state.with_conn(|conn| {
        let count = |conn: &mut dyn SqlSession, table: &str| -> Result<i64, String> {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            conn.query_one(&sql, vec![])?
                .ok_or_else(|| "统计查询失败".to_string())?
                .get(0)
                .map_err(|e| e.to_string())
        };
        let stocks = count(conn, "stocks")?;
        let notions = count(conn, "notions")?;
        let members = count(conn, "notion_stocks")?;
        let histories = count(conn, "histories")?;
        let boards = count(conn, "boards")?;
        let links = count(conn, "stock_boards")?;
        let migrated = conn
            .query_one_d(
                "SELECT value FROM meta WHERE key = 'legacy_imported'",
                "SELECT value FROM meta WHERE `key` = 'legacy_imported'",
                vec![],
            )?
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
    })
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_info,
            db_setup_state,
            db_test_connection,
            db_configure,
            db_sqlite_files,
            db_prepare_sqlite,
            db_import_legacy,
            db_sync_non_trading_days,
            db_set_non_trading_day,
            db_quote_market_status,
            db_load_quotes,
            db_load_settings,
            db_save_settings,
            db_load_symbol_configs,
            db_save_symbol_configs,
            db_save_watchgroup,
            db_clean_orphan_stocks,
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
            db_prune_today_history,
            db_replace_history_range,
            db_history_targets,
            db_load_history,
            db_load_calendar_events,
            db_save_calendar_event,
            db_delete_calendar_event,
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
            // 每次启动都由前端向导重新选择数据库，这里不再自动打开上次配置
            app.manage(Db::new(None, None));

            // 每 5 分钟广播一次探测信号：主窗口在 9:30–15:15 收到后请求行情判定非交易日
            let probe_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(300));
                let _ = probe_handle.emit("trading-day-probe", now_ms());
            });

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

#[cfg(test)]
mod calendar_tests {
    use super::prune_ended_calendar_events;
    use super::to_sql_val;
    use super::SqlSession;
    use super::Value;

    fn conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE calendar_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                repeat_type TEXT NOT NULL DEFAULT 'none',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn 行情时间戳优先使用交易所时间() {
        let quote = serde_json::json!({ "time": 1762300200 });
        assert_eq!(super::quote_stamp_ms(&quote), 1762300200_000);
    }

    /// 回归：f86 缺失时不得回退本地时间。否则非交易日（尤其工作日节假日）或停牌股
    /// 会在盘中把「今天」误判为已成交，db_load_today_candle 会合成一根假当日K线。
    #[test]
    fn 行情时间戳缺失时不回退本地时间() {
        assert_eq!(super::quote_stamp_ms(&serde_json::json!({})), 0);
        assert_eq!(super::quote_stamp_ms(&serde_json::json!({ "time": "-" })), 0);
        assert_eq!(super::quote_stamp_ms(&serde_json::json!({ "time": 0 })), 0);
    }

    /// 回归：加入自选/概念成分不是行情刷新，不得把 updated_at 写成当前时间，
    /// 否则非交易日盘中会被 db_load_today_candle 误判为「今天有成交」。
    #[test]
    fn 新增标的不会伪造行情刷新时间() {
        let dir = std::env::temp_dir().join(format!("qushi_upsert_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data").join("stocks.db");
        let mut conn = super::init_sqlite(&path).unwrap();
        let mut session = super::SqliteSession { conn: &mut conn };
        let symbol = serde_json::json!({ "secid": "1.600519", "name": "贵州茅台" });

        super::upsert_stock(&mut session, &symbol, true).unwrap();
        let stamp = |session: &mut super::SqliteSession| -> i64 {
            session
                .query_one("SELECT updated_at FROM stocks WHERE secid = '1.600519'", vec![])
                .unwrap()
                .unwrap()
                .get::<_, i64>(0)
                .unwrap()
        };
        assert_eq!(stamp(&mut session), 0);

        // 行情刷新写入交易所时间后，重复加入自选不得回退/覆盖该时间
        session
            .execute(
                "UPDATE stocks SET updated_at = 1762300200000 WHERE secid = '1.600519'",
                vec![],
            )
            .unwrap();
        super::upsert_stock(&mut session, &symbol, true).unwrap();
        assert_eq!(stamp(&mut session), 1762300200000);

        drop(session);
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 回归：搜索面板会给全部搜索结果预热行业/概念，写入时只能回写库内已存在的股票，
    /// 不得把其它搜索结果的代码建成 stocks 空名占位行，也不得为未入库标的写板块成分。
    #[test]
    fn 行业预热不为未入库股票建占位行() {
        let dir = std::env::temp_dir().join(format!("qushi_industry_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data").join("stocks.db");
        let mut conn = super::init_sqlite(&path).unwrap();
        let mut session = super::SqliteSession { conn: &mut conn };

        super::upsert_stock(
            &mut session,
            &serde_json::json!({ "secid": "1.600519", "name": "贵州茅台" }),
            true,
        )
        .unwrap();

        let rows = vec![
            serde_json::json!({ "code": "600519", "l1": "食品饮料", "l2": "白酒", "ths": "白酒" }),
            serde_json::json!({ "code": "300750", "l1": "电力设备", "l2": "电池", "ths": "电池" }),
        ];
        let updated = super::save_industries(&mut session, &rows).unwrap();
        assert_eq!(updated, 1, "只应更新库内已存在的股票");

        let stocks: i64 = session
            .query_one("SELECT COUNT(*) FROM stocks", vec![])
            .unwrap()
            .unwrap()
            .get(0)
            .unwrap();
        assert_eq!(stocks, 1, "不得为搜索结果里的其它股票建占位行");

        let l1: Option<String> = session
            .query_one(
                "SELECT industry1 FROM stocks WHERE secid = '1.600519'",
                vec![],
            )
            .unwrap()
            .unwrap()
            .get(0)
            .unwrap();
        assert_eq!(l1.as_deref(), Some("食品饮料"));

        let links: i64 = session
            .query_one(
                "SELECT COUNT(*) FROM stock_boards WHERE secid = '0.300750'",
                vec![],
            )
            .unwrap()
            .unwrap()
            .get(0)
            .unwrap();
        assert_eq!(links, 0, "未入库标的不得建立板块成分关系");

        drop(session);
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 回归：概念预热同样只为库内已有股票写官方概念成分，不得带进其它搜索结果的股票。
    #[test]
    fn 概念预热不为未入库股票建占位行() {
        let dir = std::env::temp_dir().join(format!("qushi_gn_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data").join("stocks.db");
        let mut conn = super::init_sqlite(&path).unwrap();
        let mut session = super::SqliteSession { conn: &mut conn };

        super::upsert_stock(
            &mut session,
            &serde_json::json!({ "secid": "1.600519", "name": "贵州茅台" }),
            true,
        )
        .unwrap();

        let rows = vec![
            serde_json::json!({
                "code": "600519",
                "concepts": [{ "code": "885761", "name": "白酒" }]
            }),
            serde_json::json!({
                "code": "300750",
                "concepts": [{ "code": "885800", "name": "锂电池" }]
            }),
        ];
        let (updated, relations) = super::save_stock_concepts(&mut session, &rows).unwrap();
        assert_eq!(updated, 1, "只应处理库内已存在的股票");
        assert_eq!(relations, 1);

        let stocks: i64 = session
            .query_one("SELECT COUNT(*) FROM stocks", vec![])
            .unwrap()
            .unwrap()
            .get(0)
            .unwrap();
        assert_eq!(stocks, 1, "不得为搜索结果里的其它股票建占位行");

        let linked: i64 = session
            .query_one(
                "SELECT COUNT(*) FROM stock_boards WHERE secid = '1.600519' AND board_key LIKE 'ths_gn:%'",
                vec![],
            )
            .unwrap()
            .unwrap()
            .get(0)
            .unwrap();
        assert_eq!(linked, 1);

        let orphan_links: i64 = session
            .query_one(
                "SELECT COUNT(*) FROM stock_boards WHERE secid = '0.300750'",
                vec![],
            )
            .unwrap()
            .unwrap()
            .get(0)
            .unwrap();
        assert_eq!(orphan_links, 0, "未入库标的不得写入概念成分关系");

        drop(session);
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 旧版数据导入只执行一次且空库才写入() {
        let dir = std::env::temp_dir().join(format!("qushi_legacy_import_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stocks.db");
        let mut conn = super::init_sqlite(&path).unwrap();
        let payload = serde_json::json!({
            "settings": { "tableSize": "small" },
            "symbol_configs": { "1.600519": { "secid": "1.600519", "position": { "num": 10 } } },
            "groups": [{
                "id": 0,
                "name": "自选",
                "symbols": [{ "secid": "1.600519", "symbol": "600519", "name": "贵州茅台" }]
            }]
        });

        let first = {
            let mut session = super::SqliteSession { conn: &mut conn };
            super::import_legacy_data(&mut session, &payload)
                .unwrap()
                .unwrap()
        };
        assert_eq!(first.0, 1, "设置应导入一条");
        assert_eq!(first.1, 1, "持仓配置应导入一条");
        assert_eq!(first.2, (1, 0, 0), "自选应导入一只股票");

        {
            let mut session = super::SqliteSession { conn: &mut conn };
            // meta.legacy_imported 已写入，重复调用直接跳过
            assert!(super::import_legacy_data(&mut session, &payload)
                .unwrap()
                .is_none());
            let settings: String = session
                .query_one(
                    "SELECT value FROM app_settings WHERE key = 'setting'",
                    vec![],
                )
                .unwrap()
                .unwrap()
                .get::<_, String>(0)
                .unwrap();
            assert!(settings.contains("small"));
            let symbols: i64 = session
                .query_one("SELECT COUNT(*) FROM symbol_configs", vec![])
                .unwrap()
                .unwrap()
                .get::<_, i64>(0)
                .unwrap();
            assert_eq!(symbols, 1);
            let watched: i64 = session
                .query_one("SELECT COUNT(*) FROM stocks WHERE zx = 1", vec![])
                .unwrap()
                .unwrap()
                .get::<_, i64>(0)
                .unwrap();
            assert_eq!(watched, 1);
        }

        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 旧版数据导入不覆盖库内已有自选() {
        let dir = std::env::temp_dir().join(format!("qushi_legacy_watch_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stocks.db");
        let mut conn = super::init_sqlite(&path).unwrap();
        {
            let mut session = super::SqliteSession { conn: &mut conn };
            session
                .execute(
                    "INSERT INTO stocks (secid, name, zx) VALUES ('1.000001', '平安银行', 1)",
                    vec![],
                )
                .unwrap();
        }
        let payload = serde_json::json!({
            "groups": [{
                "id": 0,
                "name": "自选",
                "symbols": [{ "secid": "1.600519", "symbol": "600519", "name": "贵州茅台" }]
            }]
        });
        {
            let mut session = super::SqliteSession { conn: &mut conn };
            let result = super::import_legacy_data(&mut session, &payload)
                .unwrap()
                .unwrap();
            assert_eq!(result.2, (0, 0, 0), "库内已有自选时不再导入旧自选");
            let secids: Vec<String> = session
                .query("SELECT secid FROM stocks WHERE zx = 1", vec![])
                .unwrap()
                .iter()
                .map(|row| row.get::<_, String>(0).unwrap())
                .collect();
            assert_eq!(secids, vec!["1.000001".to_string()]);
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 密码加解密往返() {
        let key = [7u8; 32];
        let encoded = super::encrypt_with_key(&key, "secret-password").unwrap();
        assert_ne!(encoded, "secret-password");
        let plaintext = super::decrypt_with_key(&key, &encoded).unwrap();
        assert_eq!(plaintext, "secret-password");
    }

    #[test]
    fn sqlite_configure_建库后版本为19() {
        let dir = std::env::temp_dir().join(format!("qushi_db_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data").join("stocks.db");
        let conn = super::init_sqlite(&path).unwrap();
        let version: String = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, "19");
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 建库后包含设置与持仓配置表() {
        let dir = std::env::temp_dir().join(format!("qushi_settings_table_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stocks.db");
        let conn = super::init_sqlite(&path).unwrap();
        for table in ["app_settings", "symbol_configs", "non_trading_days"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "{table} 应随建库创建");
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 日期加一天跨月跨年与闰年() {
        assert_eq!(super::next_date("2024-01-31").unwrap(), "2024-02-01");
        assert_eq!(super::next_date("2024-02-28").unwrap(), "2024-02-29");
        assert_eq!(super::next_date("2023-02-28").unwrap(), "2023-03-01");
        assert_eq!(super::next_date("2024-12-31").unwrap(), "2025-01-01");
        assert!(super::next_date("2024-13-01").is_none());
        assert!(super::next_date("2024-02-30").is_none());
    }

    #[test]
    fn 非交易日回填按histories日期集合写入并自愈() {
        let dir = std::env::temp_dir().join(format!("qushi_ntd_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stocks.db");
        let mut conn = super::init_sqlite(&path).unwrap();
        {
            let mut session = super::SqliteSession { conn: &mut conn };
            for date in ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"] {
                session
                    .execute(
                        "INSERT INTO histories (secid, date, close) VALUES (?1, ?2, 10)",
                        p!["1.600519".to_string(), date.to_string()],
                    )
                    .unwrap();
            }
        }
        {
            let mut session = super::SqliteSession { conn: &mut conn };
            let (added, removed) =
                super::sync_non_trading_days(&mut session, "2024-01-01", "2024-01-07").unwrap();
            assert_eq!((added, removed), (3, 0), "元旦与周末三天应为非交易日");
            let dates: Vec<String> = session
                .query("SELECT date FROM non_trading_days ORDER BY date", vec![])
                .unwrap()
                .iter()
                .map(|row| row.get::<_, String>(0).unwrap())
                .collect();
            assert_eq!(dates, vec!["2024-01-01", "2024-01-06", "2024-01-07"]);
        }
        // 补同步后该日已有数据：应自动删除此前误判的非交易日
        {
            let mut session = super::SqliteSession { conn: &mut conn };
            session
                .execute(
                    "INSERT INTO histories (secid, date, close) VALUES (?1, ?2, 10)",
                    p!["1.600519".to_string(), "2024-01-06".to_string()],
                )
                .unwrap();
            let (added, removed) =
                super::sync_non_trading_days(&mut session, "2024-01-01", "2024-01-07").unwrap();
            assert_eq!((added, removed), (0, 1));
            let dates: Vec<String> = session
                .query("SELECT date FROM non_trading_days ORDER BY date", vec![])
                .unwrap()
                .iter()
                .map(|row| row.get::<_, String>(0).unwrap())
                .collect();
            assert_eq!(dates, vec!["2024-01-01", "2024-01-07"]);
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mysql_用户名与密码可留空() {
        let input = super::MysqlInput {
            host: " 127.0.0.1 ".into(),
            port: 3306,
            database: " qushi ".into(),
            username: "   ".into(),
            password: None,
        };
        let settings = input.to_conn_settings().unwrap();
        assert_eq!(settings.host, "127.0.0.1");
        assert_eq!(settings.database, "qushi");
        assert_eq!(settings.username, "root");
        assert_eq!(settings.password, "");
    }

    #[test]
    fn sqlite_路径是文件夹时给出提示() {
        let dir = std::env::temp_dir().join("qs_sqlite_dir_check");
        std::fs::create_dir_all(&dir).unwrap();
        let error = super::test_sqlite_connection(&dir.to_string_lossy()).unwrap_err();
        assert!(error.contains("该路径是文件夹"), "实际错误: {error}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 准备数据库会创建文件与表结构() {
        let dir = std::env::temp_dir().join("qs_prepare_sqlite_check");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stocks.db");
        super::db_prepare_sqlite(path.to_string_lossy().into_owned()).unwrap();
        assert!(path.exists());
        let conn = rusqlite::Connection::open(&path).unwrap();
        let version: String = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, "19");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 列出目录中的数据库文件() {
        let dir = std::env::temp_dir().join("qs_sqlite_files_check");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("stocks.db"), b"").unwrap();
        std::fs::write(dir.join("old.sqlite3"), b"").unwrap();
        std::fs::write(dir.join("note.txt"), b"").unwrap();
        let value = super::db_sqlite_files(dir.to_string_lossy().into_owned()).unwrap();
        let files: Vec<String> = value["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_string())
            .collect();
        assert_eq!(files, vec!["old.sqlite3", "stocks.db"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 只清理已结束且不重复的事件() {
        let mut conn = conn();
        conn.execute(
            "INSERT INTO calendar_events (name, start_date, end_date, repeat_type, created_at, updated_at)
             VALUES
             ('昨天结束', date('now','localtime','-1 day'), date('now','localtime','-1 day'), 'none', 0, 0),
             ('今天结束', date('now','localtime'), date('now','localtime'), 'none', 0, 0),
             ('明天结束', date('now','localtime','+1 day'), date('now','localtime','+1 day'), 'none', 0, 0),
             ('每月重复', date('now','localtime','-40 day'), date('now','localtime','-1 day'), 'monthly', 0, 0),
             ('每年重复', date('now','localtime','-400 day'), date('now','localtime','-1 day'), 'yearly', 0, 0)",
            [],
        )
        .unwrap();

        let removed = {
            let mut session = super::SqliteSession { conn: &mut conn };
            prune_ended_calendar_events(&mut session).unwrap()
        };
        assert_eq!(removed, 1);

        let mut stmt = conn
            .prepare("SELECT name FROM calendar_events ORDER BY id")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(names, vec!["今天结束", "明天结束", "每月重复", "每年重复"]);
    }

    /// 仅含 histories / stock_boards 的内存库，用于板块聚合与K线清理用例
    fn histories_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE histories (
                secid TEXT NOT NULL, date TEXT NOT NULL, open REAL, close REAL, high REAL, low REAL,
                volume REAL, amount REAL, ratio REAL, turnover_ratio REAL,
                PRIMARY KEY (secid, date)
             ) WITHOUT ROWID;
             CREATE TABLE stock_boards (
                secid TEXT NOT NULL, board_key TEXT NOT NULL, updated_at INTEGER,
                PRIMARY KEY (secid, board_key)
             ) WITHOUT ROWID;",
        )
        .unwrap();
        conn
    }

    /// A 正常交易；B 在 01-07 停牌、01-08 复牌；C 01-07 才上市
    fn seed_suspended_board(conn: &rusqlite::Connection) {
        conn.execute_batch(
            "INSERT INTO stock_boards (secid, board_key) VALUES
                ('1.000001','test:b'), ('0.000002','test:b'), ('0.000003','test:b');
             INSERT INTO histories (secid, date, close, amount) VALUES
                ('1.000001','2026-01-05',9.9,100),
                ('1.000001','2026-01-06',10.0,110),
                ('1.000001','2026-01-07',10.5,120),
                ('1.000001','2026-01-08',10.5,130),
                ('0.000002','2026-01-05',20.0,50),
                ('0.000002','2026-01-06',20.0,55),
                ('0.000002','2026-01-08',22.0,60),
                ('0.000003','2026-01-07',5.0,10),
                ('0.000003','2026-01-08',5.05,20);",
        )
        .unwrap();
    }

    /// 回归：停牌日不能剔除分母。01-07 B 停牌应按 0% 计入，
    /// 否则板块涨跌幅会只剩 A 的 +5%（真实等权应为 +2.5%）。
    #[test]
    fn 板块聚合把停牌日按零涨跌计入分母() {
        let mut conn = histories_conn();
        seed_suspended_board(&conn);
        let mut session = super::SqliteSession { conn: &mut conn };
        let acc = super::accumulate_board_days(&mut session, "test:b", None).unwrap();

        let dates: Vec<&str> = acc.keys().map(|key| key.as_str()).collect();
        assert_eq!(dates, vec!["2026-01-06", "2026-01-07", "2026-01-08"]);

        // 01-06：A +1.01%，B 0%
        let day = &acc["2026-01-06"];
        assert_eq!(day.count, 2);
        assert!((super::day_pct_of(day) - (10.0 / 9.9 - 1.0) / 2.0).abs() < 1e-12);

        // 01-07：A +5%，B 停牌按 0%；C 当日上市无前收不参与
        let day = &acc["2026-01-07"];
        assert_eq!(day.count, 2);
        assert!((super::day_pct_of(day) - 0.025).abs() < 1e-12);
        assert!((day.sum_amount - 120.0).abs() < 1e-12);

        // 01-08：A 0%，B 复牌 +10%，C +1%
        let day = &acc["2026-01-08"];
        assert_eq!(day.count, 3);
        assert!((super::day_pct_of(day) - (0.0 + 0.1 + 0.01) / 3.0).abs() < 1e-12);
    }

    /// 回归：增量窗口的首日也必须用窗口前最后一个收盘价作为前收，
    /// 否则窗口首日会因缺少前收而少算一只成分股。
    #[test]
    fn 板块增量窗口用窗口前收盘作为前收() {
        let mut conn = histories_conn();
        seed_suspended_board(&conn);
        let mut session = super::SqliteSession { conn: &mut conn };
        let acc = super::accumulate_board_days(&mut session, "test:b", Some(2)).unwrap();

        let dates: Vec<&str> = acc.keys().map(|key| key.as_str()).collect();
        assert_eq!(dates, vec!["2026-01-07", "2026-01-08"]);
        assert_eq!(acc["2026-01-07"].count, 2);
        assert!((super::day_pct_of(&acc["2026-01-07"]) - 0.025).abs() < 1e-12);
        assert_eq!(acc["2026-01-08"].count, 3);
    }

    /// 回归：区间替换写入前先清空区间，源端已不存在的日期不能留在库里
    #[test]
    fn 区间替换清理源端已不存在的日期() {
        let mut conn = histories_conn();
        conn.execute_batch(
            "INSERT INTO histories (secid, date, close) VALUES
                ('1.600519','2026-01-05',10),
                ('1.600519','2026-01-06',11),
                ('1.600519','2026-01-07',12);",
        )
        .unwrap();
        let list = vec![serde_json::json!({
            "date": "2026-01-07", "open": 12, "close": 12, "high": 12, "low": 12,
            "volume": 1000, "amount": 120000000.0, "ratio": 0.0, "turnover_ratio": 0.5
        })];
        let mut session = super::SqliteSession { conn: &mut conn };
        let (removed, saved) = super::delete_and_write_history_range(
            &mut session,
            "1.600519",
            "2026-01-06",
            "2026-01-07",
            &list,
        )
        .unwrap();

        assert_eq!(removed, 2);
        assert_eq!(saved, 1);
        let dates: Vec<String> = session
            .query(
                "SELECT date FROM histories WHERE secid = '1.600519' ORDER BY date",
                vec![],
            )
            .unwrap()
            .iter()
            .map(|row| row.get::<_, String>(0).unwrap())
            .collect();
        assert_eq!(dates, vec!["2026-01-05", "2026-01-07"]);
    }

    /// 回归：15:15 前启动时只清理当天残留K线，不影响更早历史
    #[test]
    fn 未收盘清理只删除当天k线() {
        let mut conn = histories_conn();
        conn.execute_batch(
            "INSERT INTO histories (secid, date, close) VALUES
                ('1.600519','2026-01-07',10),
                ('1.600519','2026-01-08',11),
                ('0.000001','2026-01-08',12);",
        )
        .unwrap();
        let mut session = super::SqliteSession { conn: &mut conn };
        let removed = super::prune_history_date(&mut session, "2026-01-08").unwrap();

        assert_eq!(removed, 2);
        let left: i64 = session
            .query_one("SELECT COUNT(*) FROM histories", vec![])
            .unwrap()
            .unwrap()
            .get::<_, i64>(0)
            .unwrap();
        assert_eq!(left, 1);
    }

    /// 回归：字段回填不能只看最新一行，中间任何一行缺字段都需要整段重拉；
    /// 孤儿股票（不属于任何概念）即使有历史也不再纳入每日补齐
    #[test]
    fn 历史目标统计任意缺失字段行() {
        let mut conn = histories_conn();
        conn.execute_batch(
            "CREATE TABLE stocks (
                secid TEXT PRIMARY KEY, name TEXT NOT NULL, price REAL, open REAL, high REAL,
                low REAL, ratio REAL, amount REAL, turnover_ratio REAL, industry1 TEXT,
                industry2 TEXT, ths_industry TEXT, industry_updated_at INTEGER,
                zx INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
             );
             CREATE TABLE notion_stocks (notion_id INTEGER NOT NULL, secid TEXT NOT NULL);
             INSERT INTO stocks (secid, name, zx) VALUES
                ('1.600519','贵州茅台',1),
                ('0.000001','平安银行',0),
                ('0.000002','孤儿股票',0);
             INSERT INTO notion_stocks (notion_id, secid) VALUES (1,'0.000001');
             INSERT INTO histories (secid, date, close, volume, ratio, turnover_ratio) VALUES
                ('1.600519','2026-01-05',10,1000,0.0,0.5),
                ('1.600519','2026-01-06',11,NULL,NULL,NULL),
                ('1.600519','2026-01-07',12,1000,1.0,0.5),
                ('0.000001','2024-06-01',8,NULL,0.0,0.5),
                ('0.000002','2024-06-01',9,1000,0.0,0.5);",
        )
        .unwrap();
        let mut session = super::SqliteSession { conn: &mut conn };
        let targets = super::list_history_targets(&mut session).unwrap();

        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0]["secid"], "1.600519");
        assert_eq!(targets[0]["last_date"], "2026-01-07");
        // 最新一行完整，但 01-06 缺字段 → 仍统计为待回填
        assert_eq!(targets[0]["missing_fields"].as_i64(), Some(1));
        // 非自选但仍是概念成员且有历史，同样纳入补齐目标
        assert_eq!(targets[1]["secid"], "0.000001");
        assert_eq!(targets[1]["missing_fields"].as_i64(), Some(1));
    }

    /// 仅含 stocks / notion_stocks 的最小库，用于股票清理用例
    fn watch_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE stocks (
                secid TEXT PRIMARY KEY, name TEXT NOT NULL, zx INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE notion_stocks (notion_id INTEGER NOT NULL, secid TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    /// 回归：保存自选时只清理「本次移出自选且不属于任何概念」的股票；
    /// 概念删除遗留的孤儿股票保留，等「数据校验」统一清理。
    #[test]
    fn 保存只清理移出自选的股票() {
        let mut conn = watch_conn();
        conn.execute_batch(
            "INSERT INTO stocks (secid, name, zx) VALUES
                ('1.600519','贵州茅台',0),
                ('0.000001','平安银行',0),
                ('0.000003','已删概念成员',0),
                ('0.000858','五粮液',1),
                ('0.000002','',0);
             INSERT INTO notion_stocks (notion_id, secid) VALUES (3,'1.600519');",
        )
        .unwrap();
        let mut session = super::SqliteSession { conn: &mut conn };
        let prev: std::collections::HashSet<String> = ["1.600519", "0.000001", "0.000858"]
            .iter()
            .map(|secid| secid.to_string())
            .collect();
        let removed = super::prune_deleted_watch_stocks(&mut session, &prev).unwrap();

        assert_eq!(removed, 1); // 仅平安银行：移出自选且无任何概念引用
        let left: Vec<String> = session
            .query("SELECT secid FROM stocks", vec![])
            .unwrap()
            .iter()
            .map(|row| row.get::<_, String>(0).unwrap())
            .collect();
        assert!(left.contains(&"1.600519".to_string())); // 移出自选但仍在概念中
        assert!(left.contains(&"0.000858".to_string())); // 仍在自选
        assert!(left.contains(&"0.000002".to_string())); // 行业缓存（name 为空）
        assert!(left.contains(&"0.000003".to_string())); // 概念删除遗留的孤儿
        assert!(!left.contains(&"0.000001".to_string()));
    }

    /// 回归：数据校验修复删除孤儿股票，仍被自选/概念引用或只有缓存的行不受影响。
    #[test]
    fn 校验修复删除孤儿股票() {
        let mut conn = watch_conn();
        conn.execute_batch(
            "INSERT INTO stocks (secid, name, zx) VALUES
                ('1.600519','贵州茅台',0),
                ('0.000001','平安银行',0),
                ('0.000002','',0),
                ('0.000858','五粮液',1);
             INSERT INTO notion_stocks (notion_id, secid) VALUES (3,'1.600519');",
        )
        .unwrap();
        let mut session = super::SqliteSession { conn: &mut conn };
        let secids = vec![
            "1.600519".to_string(),
            "0.000001".to_string(),
            "0.000002".to_string(),
            "0.000858".to_string(),
        ];
        let removed = super::delete_orphan_stocks(&mut session, &secids).unwrap();

        assert_eq!(removed, 1); // 只有平安银行是孤儿
        let left: Vec<String> = session
            .query("SELECT secid FROM stocks", vec![])
            .unwrap()
            .iter()
            .map(|row| row.get::<_, String>(0).unwrap())
            .collect();
        assert!(left.contains(&"1.600519".to_string()));
        assert!(left.contains(&"0.000858".to_string()));
        assert!(left.contains(&"0.000002".to_string()));
        assert!(!left.contains(&"0.000001".to_string()));
    }

    /// 仅含 meta / non_trading_days / stocks 的内存库，用于行情来源判定与快照读取
    fn quotes_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE non_trading_days (
                date TEXT PRIMARY KEY, source TEXT NOT NULL, confirmed_at INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE stocks (
                secid TEXT PRIMARY KEY, name TEXT NOT NULL, price REAL, open REAL, high REAL, low REAL,
                pre_close REAL, price_diff REAL, ratio REAL, amount REAL, turnover_ratio REAL,
                industry1 TEXT, industry2 TEXT, ths_industry TEXT, industry_updated_at INTEGER,
                zx INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
             );",
        )
        .unwrap();
        conn
    }

    /// 构造北京时间（UTC+8）的毫秒时间戳
    fn cst_ms(year: i32, month: u32, day: u32, minutes: u32) -> i64 {
        (super::days_from_civil(year, month, day) * 86400 + minutes as i64 * 60 - 8 * 3600) * 1000
    }

    #[test]
    fn 日期减一天跨月跨年与闰年() {
        assert_eq!(super::prev_date("2024-01-01").unwrap(), "2023-12-31");
        assert_eq!(super::prev_date("2024-03-01").unwrap(), "2024-02-29");
        assert_eq!(super::prev_date("2023-03-01").unwrap(), "2023-02-28");
        assert!(super::prev_date("2024-13-01").is_none());
        assert!(super::prev_date("2024-02-30").is_none());
    }

    #[test]
    fn 北京时间日期与分钟固定按utc加8换算() {
        let morning = cst_ms(2026, 11, 9, 10 * 60);
        assert_eq!(
            super::cst_date_minutes(morning),
            ("2026-11-09".to_string(), 600)
        );
        // UTC 20:00 = 北京次日 04:00
        let late = (super::days_from_civil(2026, 11, 9) * 86400 + 20 * 3600) * 1000;
        assert_eq!(
            super::cst_date_minutes(late),
            ("2026-11-10".to_string(), 240)
        );
        // 2026-11-08 是周日
        assert_eq!(super::weekday_index("2026-11-08"), Some(0));
        assert!(super::is_weekday_date("2026-11-09"));
        assert!(!super::is_weekday_date("2026-11-08"));
    }

    #[test]
    fn 最近已收盘交易日跳过周末与非交易日() {
        let non: std::collections::HashSet<String> = ["2026-10-01", "2026-10-02", "2026-10-05"]
            .iter()
            .map(|date| date.to_string())
            .collect();
        // 周一开盘前 → 上周五
        assert_eq!(
            super::latest_completed_trading_day("2026-11-09", true, false, &non).as_deref(),
            Some("2026-11-06")
        );
        // 周一收盘后 → 今天
        assert_eq!(
            super::latest_completed_trading_day("2026-11-09", true, true, &non).as_deref(),
            Some("2026-11-09")
        );
        // 周日 → 上周五
        assert_eq!(
            super::latest_completed_trading_day("2026-11-08", false, true, &non).as_deref(),
            Some("2026-11-06")
        );
        // 工作日节假日（10-05 周一休市）→ 09-30
        assert_eq!(
            super::latest_completed_trading_day("2026-10-05", true, false, &non).as_deref(),
            Some("2026-09-30")
        );
    }

    fn status_json(now_ms: i64, synced: Option<&str>, non_days: &[&str]) -> Value {
        let mut conn = quotes_conn();
        if let Some(date) = synced {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('quotes_synced_date', ?1)",
                [date],
            )
            .unwrap();
        }
        for date in non_days {
            conn.execute(
                "INSERT INTO non_trading_days (date, source) VALUES (?1, 'history')",
                [date],
            )
            .unwrap();
        }
        let mut session = super::SqliteSession { conn: &mut conn };
        super::quote_market_status(&mut session, now_ms, None).unwrap()
    }

    #[test]
    fn 行情来源判定盘中走接口其余时段按库是否覆盖交易日() {
        // 周一盘中：即使库已是上周五也必须走接口
        let live = status_json(cst_ms(2026, 11, 9, 10 * 60), Some("2026-11-06"), &[]);
        assert_eq!(live["todayTrading"], true);
        assert_eq!(live["liveWindow"], true);
        assert_eq!(live["latestTradingDay"], "2026-11-06");
        assert_eq!(live["useDb"], false);

        // 周一开盘前：库是上周五 → 直接读库
        let before = status_json(cst_ms(2026, 11, 9, 8 * 60), Some("2026-11-06"), &[]);
        assert_eq!(before["liveWindow"], false);
        assert_eq!(before["useDb"], true);

        // 库落后（只有上周四）→ 需要补接口
        let behind = status_json(cst_ms(2026, 11, 9, 8 * 60), Some("2026-11-05"), &[]);
        assert_eq!(behind["useDb"], false);

        // 周一收盘后：库是上周五 → 落后；库已是周一 → 读库
        let after = status_json(cst_ms(2026, 11, 9, 16 * 60), Some("2026-11-06"), &[]);
        assert_eq!(after["latestTradingDay"], "2026-11-09");
        assert_eq!(after["useDb"], false);
        let after_fresh = status_json(cst_ms(2026, 11, 9, 16 * 60), Some("2026-11-09"), &[]);
        assert_eq!(after_fresh["useDb"], true);

        // 工作日节假日：盘中也不请求接口
        let holiday = status_json(
            cst_ms(2026, 11, 9, 10 * 60),
            Some("2026-11-06"),
            &["2026-11-09"],
        );
        assert_eq!(holiday["todayTrading"], false);
        assert_eq!(holiday["latestTradingDay"], "2026-11-06");
        assert_eq!(holiday["useDb"], true);
    }

    #[test]
    fn 窗口内标的全部刷新到最近交易日后才读库() {
        // 周一开盘前，最近已收盘交易日 = 上周五
        let now = cst_ms(2026, 11, 9, 8 * 60);
        let friday = cst_ms(2026, 11, 6, 10 * 60);
        let thursday = cst_ms(2026, 11, 5, 10 * 60);
        let mut conn = quotes_conn();
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('quotes_synced_date', '2026-11-06')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO stocks (secid, name, updated_at) VALUES ('1.600519','贵州茅台',?1)",
            [friday],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO stocks (secid, name, updated_at) VALUES ('0.000858','五粮液',?1)",
            [thursday],
        )
        .unwrap();

        let mut session = super::SqliteSession { conn: &mut conn };
        let both = ["1.600519".to_string(), "0.000858".to_string()];
        // 五粮液还停在周四 → 当前窗口不能直接读库
        let status = super::quote_market_status(&mut session, now, Some(&both)).unwrap();
        assert_eq!(status["useDb"], false);
        assert_eq!(status["windowCovered"], false);

        // 补一次接口后两只都刷新到周五 → 读库
        session
            .execute("UPDATE stocks SET updated_at = ?1", p![friday])
            .unwrap();
        let status = super::quote_market_status(&mut session, now, Some(&both)).unwrap();
        assert_eq!(status["useDb"], true);
        assert_eq!(status["windowCovered"], true);

        // 窗口里有库里没有的标的（新加自选）→ 未覆盖
        let with_new = [
            "1.600519".to_string(),
            "0.000858".to_string(),
            "9.999999".to_string(),
        ];
        let status = super::quote_market_status(&mut session, now, Some(&with_new)).unwrap();
        assert_eq!(status["useDb"], false);

        // 不传窗口标的时保持全局判定
        let global = super::quote_market_status(&mut session, now, None).unwrap();
        assert_eq!(global["useDb"], true);
        assert_eq!(global["windowCovered"], Value::Null);
    }

    #[test]
    fn 批量读取行情快照字段与实时行情对齐() {
        let mut conn = quotes_conn();
        conn.execute(
            "INSERT INTO stocks (secid, name, price, ratio, price_diff, turnover_ratio, high, low, open, pre_close, amount, updated_at)
             VALUES ('1.600519','贵州茅台',1500,1.5,22.18,0.6,1510,1490,1495,1480,12.3,1762316400000)",
            [],
        )
        .unwrap();
        let mut session = super::SqliteSession { conn: &mut conn };
        let rows = super::load_quotes_rows(&mut session, &["1.600519".to_string()]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["secid"], "1.600519");
        assert_eq!(rows[0]["price"], 1500.0);
        assert_eq!(rows[0]["range"], 1.5);
        assert_eq!(rows[0]["price_diff"], 22.18);
        assert_eq!(rows[0]["turn"], 0.6);
        assert_eq!(rows[0]["pre_close"], 1480.0);
        // 库里 updated_at 是毫秒，输出与东财 f124 一致按秒
        assert_eq!(rows[0]["time"], 1762316400);

        // 库内没有的 secid 不返回，前端保持占位
        let rows = super::load_quotes_rows(
            &mut session,
            &["1.600519".to_string(), "9.999999".to_string()],
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn 行情同步日期取本轮最大交易所时间() {
        let early = cst_ms(2026, 11, 5, 10 * 60) / 1000;
        let late = cst_ms(2026, 11, 6, 14 * 60) / 1000;
        let list = vec![
            serde_json::json!({ "time": early }),
            serde_json::json!({ "time": late }),
            serde_json::json!({ "time": 0 }),
        ];
        assert_eq!(
            super::quotes_synced_date(&list).as_deref(),
            Some("2026-11-06")
        );
        assert_eq!(super::quotes_synced_date(&[serde_json::json!({})]), None);
    }

    #[test]
    fn 旧库升级补列后可存取昨收涨跌额() {
        let dir = std::env::temp_dir().join(format!("qushi_quote_migrate_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data").join("stocks.db");
        {
            let conn = super::init_sqlite(&path).unwrap();
            // 模拟 v18：去掉 v19 新增的两列后重新初始化，验证幂等补列
            conn.execute_batch(
                "ALTER TABLE stocks DROP COLUMN pre_close;
                 ALTER TABLE stocks DROP COLUMN price_diff;",
            )
            .unwrap();
        }
        let mut conn = super::init_sqlite(&path).unwrap();
        let mut session = super::SqliteSession { conn: &mut conn };
        session
            .execute(
                "INSERT INTO stocks (secid, name, pre_close, price_diff)
                 VALUES ('1.600519','贵州茅台',1478,22)",
                vec![],
            )
            .unwrap();
        let row = session
            .query_one(
                "SELECT pre_close, price_diff FROM stocks WHERE secid = '1.600519'",
                vec![],
            )
            .unwrap()
            .unwrap();
        assert_eq!(row.get::<_, f64>(0).unwrap(), 1478.0);
        assert_eq!(row.get::<_, f64>(1).unwrap(), 22.0);

        let version = session
            .query_one("SELECT value FROM meta WHERE key = 'schema_version'", vec![])
            .unwrap()
            .unwrap()
            .get::<_, String>(0)
            .unwrap();
        assert_eq!(version, "19");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn meta读写可覆盖更新() {
        let mut conn = quotes_conn();
        let mut session = super::SqliteSession { conn: &mut conn };
        assert_eq!(
            super::meta_get(&mut session, "quotes_synced_date").unwrap(),
            None
        );
        super::meta_set(&mut session, "quotes_synced_date", "2026-11-06").unwrap();
        assert_eq!(
            super::meta_get(&mut session, "quotes_synced_date")
                .unwrap()
                .as_deref(),
            Some("2026-11-06")
        );
        super::meta_set(&mut session, "quotes_synced_date", "2026-11-09").unwrap();
        assert_eq!(
            super::meta_get(&mut session, "quotes_synced_date")
                .unwrap()
                .as_deref(),
            Some("2026-11-09")
        );
    }
}
