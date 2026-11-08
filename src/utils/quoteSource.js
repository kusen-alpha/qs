import { isTauri } from './env';
import { loadQuoteMarketStatus, loadQuotes } from './db';

/** 盘中窗口 9:15–15:15：这段时间行情必须走接口（库内是当天部分数据或上一交易日） */
export const QUOTE_LIVE_START_MINUTES = 9 * 60 + 15;
export const QUOTE_LIVE_END_MINUTES = 15 * 60 + 15;

/** 时段判定缓存：既避免每 4 秒一次 IPC，又能在一分钟内发现「今天休市」 */
const STATUS_TTL_MS = 60 * 1000;

/** 按窗口标的集合分别缓存：不同窗口的「库是否覆盖」结论互相独立 */
const cache = new Map();

export function isLiveQuoteWindow(now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= QUOTE_LIVE_START_MINUTES && minutes <= QUOTE_LIVE_END_MINUTES;
}

/** 仅供测试：清空时段判定缓存 */
export function resetQuoteEnvironmentCache() {
  cache.clear();
}

/** 窗口标的集合的缓存键（去重排序，避免顺序变化导致重复查询） */
function secidsKey(secids) {
  return [...new Set(secids || [])].sort().join(',');
}

/**
 * 空闲态下次唤醒间隔：取「距离下一次 9:15」与 60 秒的较小值。
 * 保证 9:15 一到能立刻切回接口轮询，同时空闲时仍会低频检查库是否落后。
 */
export function idleDelayMs(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 15, 0, 0);
  const next =
    now < start
      ? start
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 15, 0, 0);
  return Math.min(STATUS_TTL_MS, Math.max(1000, next - now));
}

/**
 * 当前应该调接口还是读库。
 * secids 为本窗口要展示的标的：只有它们都刷新到最近已收盘交易日才允许读库，
 * 否则先补一次接口（由调用方按 60 秒间隔重试）。
 * 浏览器调试（非 Tauri）保持原有 4 秒接口轮询，避免开发环境没有行情服务时数据为空。
 */
export async function loadQuoteEnvironment(secids = [], now = new Date()) {
  const live = isLiveQuoteWindow(now);
  if (!isTauri()) {
    return { live: true, todayTrading: true, useDb: false };
  }
  const key = secidsKey(secids);
  const hit = cache.get(key);
  if (hit && hit.live === live && Date.now() - hit.at < STATUS_TTL_MS) {
    return hit.value;
  }
  const status = await loadQuoteMarketStatus([...new Set(secids || [])]);
  // 读不到状态时退回接口，避免把库内旧数据当成最新行情展示
  const value = status
    ? { live, todayTrading: !!status.todayTrading, useDb: !!status.useDb }
    : { live, todayTrading: true, useDb: false };
  cache.set(key, { at: Date.now(), live, value });
  return value;
}

/** 库优先时读取行情快照，补齐与实时行情一致的空持仓字段 */
export async function loadQuoteRows(secids) {
  const rows = await loadQuotes(secids);
  return (rows || []).map((row) => ({
    position_num: '-',
    position_price: '-',
    position_value: '-',
    position_profit: '-',
    position_profit_rate: '-',
    ...row,
  }));
}

/**
 * 取一轮行情：优先读库，库不可用或未覆盖时回退接口。
 * 时段状态查询、读库失败都只降级为接口请求：任何一步出错都不能让整表行情变空
 * （MACD 等来自库的列仍会显示，只有涨跌幅/换手率变成「-」）。
 * 接口空结果（异常/风控）时缩短重试间隔，避免长时间空表。
 * 返回 { quotes, delay, source }。
 */
export async function fetchQuotes(api, symbols, now = new Date()) {
  const secids = symbols.map((item) => item.secid);
  const live = isLiveQuoteWindow(now);
  let useDb = false;
  let todayTrading = true;
  try {
    const env = await loadQuoteEnvironment(secids, now);
    useDb = env.useDb;
    todayTrading = env.todayTrading;
  } catch (e) {
    console.error(e);
  }
  if (useDb) {
    try {
      const rows = await loadQuoteRows(secids);
      // 空结果说明库内并没有这些标的，不能当成「已覆盖」
      if (rows.length) return { quotes: rows, delay: idleDelayMs(now), source: 'db' };
    } catch (e) {
      console.error(e);
    }
  }
  const quotes = await api.realtime(symbols);
  const base = live && todayTrading ? 4000 : 60000;
  return { quotes, delay: quotes.length ? base : Math.min(base, 20000), source: 'api' };
}
