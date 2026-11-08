import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './env';

/**
 * stocks.db 访问层。
 * 表结构与连接由 Rust 侧启动时创建（src-tauri/src/main.rs），这里只封装命令调用。
 * 浏览器环境没有数据库，统一返回空结果，便于纯前端调试与单测。
 */

/** 读取软件设置（数据库为唯一来源），无记录返回 null */
export async function loadSettings() {
  if (!isTauri()) return null;
  try {
    const data = await invoke('db_load_settings');
    return data ? data.settings : null;
  } catch (e) {
    console.error('[db] 读取设置失败', e);
    return null;
  }
}

/** 保存整份软件设置 */
export async function saveSettings(settings) {
  if (!isTauri()) return null;
  try {
    return await invoke('db_save_settings', { payload: JSON.stringify(settings || {}) });
  } catch (e) {
    console.error('[db] 保存设置失败', e);
    return null;
  }
}

/** 读取全部个股持仓/提醒配置 */
export async function loadSymbolConfigs() {
  if (!isTauri()) return {};
  try {
    const data = await invoke('db_load_symbol_configs');
    return (data && data.configs) || {};
  } catch (e) {
    console.error('[db] 读取持仓配置失败', e);
    return {};
  }
}

/** 整份覆盖保存个股持仓/提醒配置 */
export async function saveSymbolConfigs(configs) {
  if (!isTauri()) return null;
  try {
    return await invoke('db_save_symbol_configs', { payload: JSON.stringify(configs || {}) });
  } catch (e) {
    console.error('[db] 保存持仓配置失败', e);
    return null;
  }
}

/** 旧版 profile 文件一次性迁入数据库；成功返回结果，失败返回 null（调用方据此决定是否删除旧文件） */
export async function importLegacy({ settings, symbolConfigs, groups }) {
  if (!isTauri()) return null;
  try {
    return await invoke('db_import_legacy', {
      payload: JSON.stringify({
        settings: settings ?? null,
        symbol_configs: symbolConfigs ?? {},
        groups: groups ?? [],
      }),
    });
  } catch (e) {
    console.error('[db] 旧版数据迁移失败', e);
    return null;
  }
}

/** 读取全部股票、概念树与概念成员 */
export async function loadWatchlist() {
  if (!isTauri()) return { stocks: [], notions: [], members: [] };
  try {
    return await invoke('db_load_watchlist');
  } catch (e) {
    console.error('[db] 读取自选数据失败', e);
    return { stocks: [], notions: [], members: [] };
  }
}

/** 全量保存自选与概念结构（Rust 侧单事务重建） */
export async function saveWatchGroup(groups) {
  if (!isTauri()) return null;
  try {
    return await invoke('db_save_watchgroup', { groups: JSON.stringify(groups || []) });
  } catch (e) {
    console.error('[db] 保存自选数据失败', e);
    return null;
  }
}

/** 成交额单位为亿：接口返回的是元，入库前换算 */
function toYi(value) {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num / 1e8 : null;
}

/** 数据校验修复：删除失去全部引用的孤儿股票，并连带清理日K、板块成分与板块日线 */
export async function cleanOrphanStocks(secids = []) {
  const list = (secids || []).filter(Boolean);
  if (!isTauri() || !list.length) return { removed: 0 };
  try {
    return await invoke('db_clean_orphan_stocks', { secids: JSON.stringify(list) });
  } catch (e) {
    console.error('[db] 清理孤儿股票失败', e);
    return null;
  }
}

/** 每轮实时行情批量写回 stocks（停牌缺值沿用库内旧值） */
export async function saveQuotes(quotes) {
  if (!isTauri()) return null;
  const list = (quotes || [])
    .filter((q) => q && q.secid)
    .map((q) => ({ ...q, amount: toYi(q.amount) }));
  if (!list.length) return null;
  try {
    return await invoke('db_save_quotes', { quotes: JSON.stringify(list) });
  } catch (e) {
    console.error('[db] 保存行情失败', e);
    return null;
  }
}

/** 申万一级/二级行业与同花顺板块名写回 stocks（入参为 loadStockConcepts 的返回值） */
export async function saveIndustries(map) {
  if (!isTauri()) return null;
  const rows = Object.entries(map || {}).map(([code, value]) => ({
    code,
    l1: (value && value.l1) || '',
    l2: (value && value.l2) || '',
    ths: (value && value.ths) || '',
  }));
  if (!rows.length) return null;
  try {
    return await invoke('db_save_industries', { rows: JSON.stringify(rows) });
  } catch (e) {
    console.error('[db] 保存行业字段失败', e);
    return null;
  }
}

/** 按 6 位代码读取行业字段（含 industry_updated_at），库里没有则不在结果中 */
export async function loadIndustries(codes) {
  if (!isTauri()) return [];
  const list = (codes || []).map(String).filter(Boolean);
  if (!list.length) return [];
  try {
    return (await invoke('db_load_industries', { codes: JSON.stringify(list) })) || [];
  } catch (e) {
    console.error('[db] 读取行业字段失败', e);
    return [];
  }
}

/** 同花顺行业板块全表：返回 { boards: { 代码: 名称 }, updated_at } */
export async function loadBoards() {
  if (!isTauri()) return null;
  try {
    return await invoke('db_load_boards');
  } catch (e) {
    console.error('[db] 读取同花顺板块失败', e);
    return null;
  }
}

/** 全量替换同花顺行业板块全表 */
export async function saveBoards(boards) {
  if (!isTauri()) return null;
  try {
    return await invoke('db_save_boards', { boards: JSON.stringify(boards || {}) });
  } catch (e) {
    console.error('[db] 保存同花顺板块失败', e);
    return null;
  }
}

/** 官方概念成分写入 boards/stock_boards：[{ code: '600519', concepts: [{ code, name }] }] */
export async function saveStockConcepts(rows) {
  if (!isTauri()) return null;
  const list = (rows || []).filter((row) => row && row.code);
  if (!list.length) return null;
  try {
    return await invoke('db_save_stock_concepts', { rows: JSON.stringify(list) });
  } catch (e) {
    console.error('[db] 保存概念成分失败', e);
    return null;
  }
}

/**
 * 板块日K（成分股等权平均）：{ board, dates, close, pct, amount, members }
 * pct 为百分数（2.35 表示 +2.35%），close 为以 100 为基准累乘的等权指数。
 */
export async function loadBoardK(boardKey, limit = 250) {
  if (!isTauri() || !boardKey) return null;
  try {
    return await invoke('db_load_board_k', { boardKey, limit });
  } catch (e) {
    console.error('[db] 读取板块日K失败', e);
    return null;
  }
}

/** 市场宽度历史：默认返回库内全部交易日（2024-01-01 起），传正整数可只取最近 N 天；库内无数据时返回 null */
export async function loadMarketWidthDb(days = 0) {
  if (!isTauri()) return null;
  try {
    return await invoke('db_load_market_width', { days });
  } catch (e) {
    console.error('[db] 读取市场宽度失败', e);
    return null;
  }
}

/** 市场宽度写入 sckd（按 交易日+行业代码 幂等 upsert） */
export async function saveMarketWidthDb(data) {
  if (!isTauri()) return null;
  const dates = (data && data.dates) || [];
  const rows = (data && data.rows) || [];
  if (!dates.length || !rows.length) return null;
  try {
    return await invoke('db_save_market_width', {
      payload: JSON.stringify({ dates, rows }),
    });
  } catch (e) {
    console.error('[db] 保存市场宽度失败', e);
    return null;
  }
}

/** 读取全部日历事件；浏览器环境返回空数组 */
export async function loadCalendarEvents() {
  if (!isTauri()) return [];
  try {
    const data = await invoke('db_load_calendar_events');
    return (data && data.events) || [];
  } catch (e) {
    console.error('[db] 读取日历事件失败', e);
    return [];
  }
}

/** 新增/修改日历事件（event.id 存在时为修改），返回事件 id */
export async function saveCalendarEvent(event) {
  if (!isTauri()) return null;
  try {
    const data = await invoke('db_save_calendar_event', {
      payload: JSON.stringify(event || {}),
    });
    return data ? data.id : null;
  } catch (e) {
    console.error('[db] 保存日历事件失败', e);
    return null;
  }
}

/** 删除日历事件，返回删除行数 */
export async function deleteCalendarEvent(id) {
  if (!isTauri() || !id) return null;
  try {
    const data = await invoke('db_delete_calendar_event', { id });
    return data ? data.removed : null;
  } catch (e) {
    console.error('[db] 删除日历事件失败', e);
    return null;
  }
}

/**
 * 板块列表：scope 为 'sw'（申万一级/二级）或 'ths'（同花顺行业板块）。
 * 返回 [{ board_key, name, level, parent_key, members: [secid], macd }]，
 * members 供前端按实时行情计算板块涨跌幅与换手率，macd 为板块指数自身的连击天数。
 */
export async function loadBoardList(scope = 'ths') {
  if (!isTauri()) return [];
  try {
    const data = await invoke('db_load_board_list', { scope });
    return (data && data.boards) || [];
  } catch (e) {
    console.error('[db] 读取板块列表失败', e);
    return [];
  }
}

/**
 * 幂等刷新板块日线落库结果（board_histories）：
 * 启动时补齐最近 days 个交易日，未计算过的板块整段重算。
 * 板块成分股变动（增删改概念/行业/板块）后由 Rust 侧自动整段重算，前端无需手动调用。
 */
export async function refreshBoardHistory(days = 5) {
  if (!isTauri()) return null;
  try {
    return await invoke('db_refresh_board_history', { days });
  } catch (e) {
    console.error('[db] 刷新板块历史失败', e);
    return null;
  }
}

/** 日 K 线落库（固定前复权，入库时由 Rust 把 amount 元换算成亿） */
export async function saveHistory(secid, candles) {
  if (!isTauri() || !secid || !candles || !candles.length) return null;
  try {
    return await invoke('db_save_history', {
      secid,
      candles: JSON.stringify(candles),
    });
  } catch (e) {
    console.error('[db] 保存K线失败', e);
    return null;
  }
}

/** 数据库里的成交额单位为亿，读回时换算成元，与接口口径一致 */
function toYuan(value) {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num * 1e8 : null;
}

/** 读取本地日 K（升序），供接口不可用时兜底 */
export async function loadHistory(secid, limit = 400) {
  if (!isTauri() || !secid) return [];
  try {
    const data = await invoke('db_load_history', { secid, limit });
    const candles = ((data && data.candles) || []).map((candle) => ({
      ...candle,
      amount: toYuan(candle.amount),
    }));
    return await appendTodayCandle(secid, candles);
  } catch (e) {
    console.error('[db] 读取K线失败', e);
    return [];
  }
}

const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
/** 合成当天K线的时间窗：9:30–15:15 */
const OPEN_MINUTES = 9 * 60 + 30;
const CLOSE_MINUTES = 15 * 60 + 15;

/**
 * 当天K线尚未写入 histories（15:15 前或启动后未再补齐）时，
 * 用 stocks 里实时刷新过的 open/high/low/price 合成一根当日K线。
 * 只在交易日 9:30–15:15 之间合成、前端合成不落库，其余时间返回原列表。
 */
async function appendTodayCandle(secid, candles) {
  const now = new Date();
  if (now.getDay() === 0 || now.getDay() === 6) return candles;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < OPEN_MINUTES || minutes > CLOSE_MINUTES) return candles;
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const last = candles.length ? candles[candles.length - 1].date : '';
  if (last >= today) return candles;
  try {
    const dayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const data = await invoke('db_load_today_candle', { secid, today, dayStartMs });
    const candle = data && data.candle;
    return candle ? [...candles, candle] : candles;
  } catch (e) {
    return candles;
  }
}

/** 全量替换某股票的日K（先删后写），用于复权基准变动后的重拉 */
export async function replaceHistory(secid, candles) {
  if (!isTauri() || !secid || !candles || !candles.length) return null;
  try {
    return await invoke('db_replace_history', {
      secid,
      candles: JSON.stringify(candles),
    });
  } catch (e) {
    console.error('[db] 替换K线失败', e);
    return null;
  }
}

/** 区间替换某股票的日K：先删 [beg, end] 区间再写入，用于清理源端已不存在的日期 */
export async function replaceHistoryRange(secid, beg, end, candles) {
  if (!isTauri() || !secid || !beg || !end) return null;
  try {
    return await invoke('db_replace_history_range', {
      secid,
      beg,
      end,
      candles: JSON.stringify(candles || []),
    });
  } catch (e) {
    console.error('[db] 区间替换K线失败', e);
    return null;
  }
}

/** 未收盘时清理当天残留的K线（15:15 前当天K线必然不完整） */
export async function pruneTodayHistory(date) {
  if (!isTauri() || !date) return null;
  try {
    const data = await invoke('db_prune_today_history', { date });
    return data ? data.removed : null;
  } catch (e) {
    console.error('[db] 清理当天K线失败', e);
    return null;
  }
}

/** 需要校验日K的股票（自选 + 已有历史的股票）：{ secid, last_date, missing_fields }[] */
export async function loadHistoryTargets() {
  if (!isTauri()) return [];
  try {
    const data = await invoke('db_history_targets');
    return (data && data.targets) || [];
  } catch (e) {
    console.error('[db] 读取日K补齐目标失败', e);
    return [];
  }
}

/**
 * 把数据库行拼回 watchGroup 结构：
 * 自选 = stocks.zx=1（顺序由数据库返回顺序决定）；概念树 = notions(pid) + notion_stocks。
 * 股票代码由 secid 拆出，数据库不单独存 code。数据库为空时返回 []，调用方补空自选组。
 */
export function buildWatchGroup({ stocks = [], notions = [], members = [] } = {}) {
  if (!stocks.length && !notions.length) return [];

  const stockMap = new Map(stocks.map((item) => [item.secid, item]));
  const toSymbol = (secid) => {
    const item = stockMap.get(secid);
    if (!item) return null;
    const dot = item.secid.indexOf('.');
    return {
      symbol: dot === -1 ? item.secid : item.secid.slice(dot + 1),
      name: item.name,
      secid: item.secid,
      source: '1',
    };
  };

  const memberMap = new Map();
  for (const member of members) {
    if (!memberMap.has(member.notion_id)) memberMap.set(member.notion_id, []);
    memberMap.get(member.notion_id).push(member);
  }
  const symbolsOf = (notionId) => {
    const list = (memberMap.get(notionId) || [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order);
    return list.map((member) => toSymbol(member.secid)).filter(Boolean);
  };

  const watch = stocks
    .filter((item) => item.zx)
    .map((item) => toSymbol(item.secid))
    .filter(Boolean);

  const groups = [{ name: '自选', id: 0, symbols: watch }];
  const tops = notions
    .filter((notion) => notion.pid == null)
    .sort((a, b) => a.sort_order - b.sort_order);
  for (const notion of tops) {
    groups.push({
      name: notion.name,
      id: notion.id,
      symbols: symbolsOf(notion.id),
      children: notions
        .filter((child) => child.pid === notion.id)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((child) => ({
          name: child.name,
          id: child.id,
          symbols: symbolsOf(child.id),
        })),
    });
  }
  return groups;
}

/** 调试用：各表行数与迁移状态 */
export async function stats() {
  if (!isTauri()) return { stocks: 0, notions: 0, members: 0, migrated: false };
  try {
    return await invoke('db_stats');
  } catch (e) {
    console.error('[db] 读取数据库统计失败', e);
    return null;
  }
}

/** 历史非交易日回填：区间内 histories 全无数据的日期写入 non_trading_days，已有数据的自动删除 */
export async function syncNonTradingDays(start, end) {
  if (!isTauri() || !start || !end) return null;
  try {
    return await invoke('db_sync_non_trading_days', { start, end });
  } catch (e) {
    console.error('[db] 回填非交易日失败', e);
    return null;
  }
}

/** 标记/清除单日非交易日（盘中探测结论落库），source 缺省为 probe */
export async function setNonTradingDay(date, nonTrading, source = 'probe') {
  if (!isTauri() || !date) return null;
  try {
    return await invoke('db_set_non_trading_day', { date, nonTrading, source });
  } catch (e) {
    console.error('[db] 标记非交易日失败', e);
    return null;
  }
}

/** 行情来源判定：返回 today/todayTrading/liveWindow/latestTradingDay/syncedDate/useDb */
export async function loadQuoteMarketStatus(secids) {
  if (!isTauri()) return null;
  try {
    return await invoke('db_quote_market_status', { secids: secids || [] });
  } catch (e) {
    console.error('[db] 读取行情时段失败', e);
    return null;
  }
}

/** 批量读取库内行情快照（字段与实时行情对齐，供库优先展示） */
export async function loadQuotes(secids) {
  if (!isTauri() || !secids?.length) return [];
  try {
    return (await invoke('db_load_quotes', { secids })) || [];
  } catch (e) {
    console.error('[db] 读取行情快照失败', e);
    return [];
  }
}

/** 首次启动向导：读取数据库配置状态（浏览器模式视为已配置） */
export async function getDbSetupState() {
  if (!isTauri()) {
    return {
      configured: true,
      saved: true,
      error: null,
      default_sqlite_path: '',
      config: {
        type: 'sqlite',
        sqlite: { path: '' },
        mysql: { host: '127.0.0.1', port: 3306, database: 'qushi', username: 'root' },
      },
    };
  }
  try {
    return await invoke('db_setup_state');
  } catch (e) {
    return {
      configured: false,
      saved: false,
      error: String(e),
      default_sqlite_path: '',
      config: {
        type: 'sqlite',
        sqlite: { path: '' },
        mysql: { host: '127.0.0.1', port: 3306, database: 'qushi', username: 'root' },
      },
    };
  }
}

/** 准备 SQLite 数据库文件：不存在则新建（含表结构），用于选择目录后立即就绪 */
export async function prepareSqlite(path) {
  if (!isTauri() || !path) return { ok: false, message: '未指定数据库文件' };
  try {
    return await invoke('db_prepare_sqlite', { path });
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

/** 列出目录下的 SQLite 数据库文件名（向导选择目录后自动识别），浏览器环境返回空数组 */
export async function listSqliteFiles(dir) {
  if (!isTauri() || !dir) return [];
  try {
    const data = await invoke('db_sqlite_files', { dir });
    return (data && data.files) || [];
  } catch (e) {
    console.error('[db] 读取目录数据库文件失败', e);
    return [];
  }
}

/** 测试数据库连接（SQLite 文件或 MySQL 连接信息） */
export async function testDbConnection(config) {
  if (!isTauri()) return { ok: true, message: '浏览器模式无需配置数据库' };
  try {
    return await invoke('db_test_connection', { payload: JSON.stringify(config || {}) });
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

/** 保存配置并初始化数据库，成功后才允许进入主界面 */
export async function configureDb(config) {
  if (!isTauri()) return { ok: true, message: '浏览器模式无需配置数据库' };
  try {
    return await invoke('db_configure', { payload: JSON.stringify(config || {}) });
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}
