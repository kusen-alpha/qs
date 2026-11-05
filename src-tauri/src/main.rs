#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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
    Manager, State, WindowEvent,
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

CREATE TABLE IF NOT EXISTS meta (
    `key` VARCHAR(191) NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"#;

const MYSQL_VERSION_SQL: &str =
    "INSERT INTO meta (`key`, value) VALUES ('schema_version', '16') \
     ON DUPLICATE KEY UPDATE value = '16'";

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
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '16')",
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
             updated_at = excluded.updated_at",
        "INSERT INTO stocks (secid, name, zx, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON DUPLICATE KEY UPDATE
             name = CASE WHEN VALUES(name) = '' THEN stocks.name ELSE VALUES(name) END,
             zx = GREATEST(stocks.zx, VALUES(zx)),
             updated_at = VALUES(updated_at)",
        p![secid, name, zx as i64, now_ms()],
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

/// 把旧版 monitor.dat 中的自选/概念一次性导入 stocks.db（幂等，只执行一次）
#[tauri::command]
fn db_migrate_watchgroup(state: State<'_, Db>, groups: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&groups).map_err(|e| format!("解析自选数据失败: {e}"))?;

    let outcome = state.with_tx(|conn| {
        let migrated = conn
            .query_one_d(
                "SELECT value FROM meta WHERE key = 'migrated_v1'",
                "SELECT value FROM meta WHERE `key` = 'migrated_v1'",
                vec![],
            )?
            .is_some();
        if migrated {
            return Ok(None);
        }

        let counts = fill_watchgroup(conn, &payload)?;
        sync_self_boards(conn)?;
        conn.execute_d(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_v1', ?1)",
            "INSERT INTO meta (`key`, value) VALUES ('migrated_v1', ?1)
             ON DUPLICATE KEY UPDATE value = VALUES(value)",
            p![now_ms().to_string()],
        )?;
        Ok(Some(counts))
    })?;

    let Some((stock_count, notion_count, member_count)) = outcome else {
        return Ok(json!({ "migrated": false, "skipped": true }));
    };

    // 自建概念成分入库后整段重算板块历史（成分变化会让历史涨跌幅整体变化）
    let (board_count, board_rows) = state
        .with_conn(|conn| refresh_board_histories(conn, &["self:"]))
        .unwrap_or((0, 0));

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

    let (
        stock_count,
        notion_count,
        member_count,
        removed_stocks,
        removed_histories,
        removed_links,
    ) = state.with_tx(|tx| {
        tx.execute("DELETE FROM notion_stocks", vec![])?;
        tx.execute("DELETE FROM notions", vec![])?;
        // 自选由当前快照重建，先全部降级再按快照置回
        tx.execute("UPDATE stocks SET zx = 0", vec![])?;

        let (stock_count, notion_count, member_count) = fill_watchgroup(tx, &payload)?;
        // 自建概念同步为板块实体，供板块日K 统一聚合
        sync_self_boards(tx)?;

        // 删除不再被自选或任何概念引用的股票，并连带清理其历史K线。
        // name 为空的行是添加弹窗/搜索时补录的行业缓存（非用户数据），保留不删。
        let removed_stocks = tx.execute(
            "DELETE FROM stocks
             WHERE zx = 0 AND name <> ''
               AND secid NOT IN (SELECT secid FROM notion_stocks)",
            vec![],
        )?;
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

/// 行情快照时间（毫秒）。东财 f86 为交易所最后成交时间（秒），缺失时才回退本地当前时间；
/// 非交易日/停牌时 f86 停留在上一个交易日，db_load_today_candle 才不会误判「今天刷新过行情」。
fn quote_stamp_ms(quote: &Value, now: i64) -> i64 {
    num_of(quote.get("time"))
        .map(|secs| (secs * 1000.0) as i64)
        .filter(|stamp| *stamp > 0)
        .unwrap_or(now)
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

    let updated = state.with_tx(|tx| {
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
            let stamp = quote_stamp_ms(quote, now);

            tx.execute_d(
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
                "INSERT INTO stocks (secid, name, open, high, low, price, ratio, amount, turnover_ratio, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON DUPLICATE KEY UPDATE
                     name = CASE WHEN VALUES(name) = '' THEN stocks.name ELSE VALUES(name) END,
                     open = COALESCE(VALUES(open), stocks.open),
                     high = COALESCE(VALUES(high), stocks.high),
                     low = COALESCE(VALUES(low), stocks.low),
                     price = COALESCE(VALUES(price), stocks.price),
                     ratio = COALESCE(VALUES(ratio), stocks.ratio),
                     amount = COALESCE(VALUES(amount), stocks.amount),
                     turnover_ratio = COALESCE(VALUES(turnover_ratio), stocks.turnover_ratio),
                     updated_at = VALUES(updated_at)",
                p![
                    secid,
                    name,
                    num_of(quote.get("open")),
                    num_of(quote.get("high")),
                    num_of(quote.get("low")),
                    num_of(quote.get("price")),
                    num_of(quote.get("range")),
                    round2(num_of(quote.get("amount"))),
                    num_of(quote.get("turn")),
                    stamp
                ],
            )?;
            updated += 1;
        }
        Ok(updated)
    })?;

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

/// 申万一级/二级、同花顺行业字段写回 stocks，并同步 boards/stock_boards 的成分关系
#[tauri::command]
fn db_save_industries(state: State<'_, Db>, rows: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&rows).map_err(|e| format!("解析行业数据失败: {e}"))?;
    let list = payload.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        return Ok(json!({ "updated": 0 }));
    }

    let updated = state.with_tx(|tx| {
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
            let changed = tx.execute_d(
                "UPDATE stocks SET industry1 = ?2, industry2 = ?3, ths_industry = ?4,
                     industry_updated_at = ?5
                 WHERE substr(secid, instr(secid, '.') + 1) = ?1",
                "UPDATE stocks SET industry1 = ?2, industry2 = ?3, ths_industry = ?4,
                     industry_updated_at = ?5
                 WHERE SUBSTRING(secid, LOCATE('.', secid) + 1) = ?1",
                params![code, l1, l2, ths, now],
            )?;
            if changed == 0 {
                // 库里还没有这只股票（非自选/非概念成员）时单独补一行，保证 7 天内不再重复抓取
                let secid = if code.starts_with('6') {
                    format!("1.{code}")
                } else {
                    format!("0.{code}")
                };
                tx.execute_d(
                    "INSERT OR IGNORE INTO stocks
                         (secid, name, industry1, industry2, ths_industry, industry_updated_at)
                     VALUES (?1, '', ?2, ?3, ?4, ?5)",
                    "INSERT IGNORE INTO stocks
                         (secid, name, industry1, industry2, ths_industry, industry_updated_at)
                     VALUES (?1, '', ?2, ?3, ?4, ?5)",
                    params![secid, l1, l2, ths, now],
                )?;
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
            )?;
            if !l1.is_empty() {
                let key = format!("sw1:{l1}");
                upsert_board(tx, &key, "sw", "industry", Some(1), None, l1, None)?;
                link_board(tx, &secid, &key, now)?;
            }
            if !l2.is_empty() {
                let key = format!("sw2:{l2}");
                let parent = if l1.is_empty() {
                    None
                } else {
                    Some(format!("sw1:{l1}"))
                };
                upsert_board(
                    tx,
                    &key,
                    "sw",
                    "industry",
                    Some(2),
                    None,
                    l2,
                    parent.as_deref(),
                )?;
                link_board(tx, &secid, &key, now)?;
            }
            // 同花顺行业只存板块名，需要从板块全表换成 board_key（全表还没抓到时先跳过）
            tx.execute(
                "DELETE FROM stock_boards WHERE secid = ?1 AND board_key LIKE 'ths_hy:%'",
                params![secid],
            )?;
            if !ths.is_empty() {
                let key_row = tx.query_one(
                    "SELECT board_key FROM boards
                     WHERE source = 'ths' AND type = 'industry' AND name = ?1 LIMIT 1",
                    params![ths],
                )?;
                let key = match key_row {
                    Some(row) => Some(row.get::<_, String>(0).map_err(|e| e.to_string())?),
                    None => None,
                };
                if let Some(key) = key {
                    link_board(tx, &secid, &key, now)?;
                }
            }
        }
        Ok(updated)
    })?;

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
#[tauri::command]
fn db_save_stock_concepts(state: State<'_, Db>, rows: String) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&rows).map_err(|e| format!("解析概念数据失败: {e}"))?;
    let list = payload.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        return Ok(json!({ "updated": 0, "relations": 0 }));
    }

    let now = now_ms();
    let (updated, relations) = state.with_tx(|tx| {
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
            tx.execute_d(
                "INSERT OR IGNORE INTO stocks (secid, name, updated_at) VALUES (?1, '', ?2)",
                "INSERT IGNORE INTO stocks (secid, name, updated_at) VALUES (?1, '', ?2)",
                params![secid, now],
            )?;
            // 概念归属会变化：先清掉这只股票旧的官方概念关系
            tx.execute(
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
                upsert_board(tx, &key, "ths", "concept", Some(1), code_value, name, None)?;
                link_board(tx, &secid, &key, now)?;
                relations += 1;
            }
            updated += 1;
        }
        Ok((updated, relations))
    })?;

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
/// limit 为 None 取全部历史；否则每只成分股只取最近 limit+1 根（多取一根用于首日分母）。
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

    // 取一个极大 LIMIT 表示不限制（整段重算）
    let take = limit.map(|n| n + 1).unwrap_or(i64::MAX);

    let mut acc: BTreeMap<String, DayAgg> = BTreeMap::new();
    for secid in members.iter() {
        let rows: Vec<(String, f64, Option<f64>)> = conn
            .query(
                "SELECT date, close, amount FROM histories
                 WHERE secid = ?1 AND close IS NOT NULL AND close > 0
                 ORDER BY date DESC LIMIT ?2",
                params![secid, take],
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
#[tauri::command]
fn db_refresh_board_history(state: State<'_, Db>, days: Option<i64>) -> Result<Value, String> {
    let days = days.unwrap_or(5).clamp(1, 60);
    state.with_conn(|conn| {
        let orphans = clean_orphan_board_histories(conn)?;

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
            if *stored == 0 {
                rows += full_rebuild_board_history(conn, key)?;
                rebuilt += 1;
            } else {
                rows += incremental_update_board_history(conn, key, days)?;
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

/// 自选股票（zx=1）及其本地日K最新日期，供启动时补齐
#[tauri::command]
fn db_history_targets(state: State<'_, Db>) -> Result<Value, String> {
    state.with_conn(|conn| {
        let targets: Vec<Value> = conn
            .query_d(
                "SELECT s.secid,
                        (SELECT MAX(h.date) FROM histories h WHERE h.secid = s.secid),
                        (SELECT h.turnover_ratio FROM histories h
                         WHERE h.secid = s.secid ORDER BY h.date DESC LIMIT 1),
                        (SELECT h.volume FROM histories h
                         WHERE h.secid = s.secid ORDER BY h.date DESC LIMIT 1)
                 FROM stocks s
                 WHERE s.zx = 1 OR EXISTS (SELECT 1 FROM histories h2 WHERE h2.secid = s.secid)
                 ORDER BY s.rowid",
                "SELECT s.secid,
                        (SELECT MAX(h.date) FROM histories h WHERE h.secid = s.secid),
                        (SELECT h.turnover_ratio FROM histories h
                         WHERE h.secid = s.secid ORDER BY h.date DESC LIMIT 1),
                        (SELECT h.volume FROM histories h
                         WHERE h.secid = s.secid ORDER BY h.date DESC LIMIT 1)
                 FROM stocks s
                 WHERE s.zx = 1 OR EXISTS (SELECT 1 FROM histories h2 WHERE h2.secid = s.secid)
                 ORDER BY s.row_id",
                vec![],
            )?
            .iter()
            .map(|row| {
                Ok(json!({
                    "secid": row.get::<_, String>(0).map_err(|e| e.to_string())?,
                    "last_date": row.get::<_, Option<String>>(1).map_err(|e| e.to_string())?,
                    "latest_turnover": row.get::<_, Option<f64>>(2).map_err(|e| e.to_string())?,
                    "latest_volume": row.get::<_, Option<f64>>(3).map_err(|e| e.to_string())?,
                }))
            })
            .collect::<Result<Vec<_>, String>>()?;

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
                "SELECT value FROM meta WHERE key = 'migrated_v1'",
                "SELECT value FROM meta WHERE `key` = 'migrated_v1'",
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
        assert_eq!(super::quote_stamp_ms(&quote, 999), 1762300200_000);
    }

    #[test]
    fn 行情时间戳缺失或非法时回退本地时间() {
        assert_eq!(super::quote_stamp_ms(&serde_json::json!({}), 123), 123);
        assert_eq!(super::quote_stamp_ms(&serde_json::json!({ "time": "-" }), 123), 123);
        assert_eq!(super::quote_stamp_ms(&serde_json::json!({ "time": 0 }), 123), 123);
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
    fn sqlite_configure_建库后版本为16() {
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
        assert_eq!(version, "16");
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
        assert_eq!(version, "16");
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
}
