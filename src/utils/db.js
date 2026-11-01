import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './env';

/**
 * stocks.db 访问层。
 * 表结构与连接由 Rust 侧启动时创建（src-tauri/src/main.rs），这里只封装命令调用。
 * 浏览器环境没有数据库，统一返回空结果，便于纯前端调试与单测。
 */

/** 把旧版 monitor.dat 的自选/概念一次性导入数据库（Rust 侧幂等） */
export async function migrateWatchGroup(groups) {
  if (!isTauri()) return { migrated: false, skipped: true };
  try {
    return await invoke('db_migrate_watchgroup', { groups: JSON.stringify(groups || []) });
  } catch (e) {
    console.error('[db] 自选数据迁移失败', e);
    return { migrated: false, error: String(e) };
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

/** 需要校验日K的股票（自选 + 已有历史的股票）：{ secid, last_date, latest_turnover }[] */
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
 * 股票代码由 secid 拆出，数据库不单独存 code。数据库为空时返回 []，调用方保留原有数据。
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
