import {
  loadHistory,
  loadHistoryTargets,
  pruneTodayHistory,
  replaceHistory,
  replaceHistoryRange,
  saveHistory,
} from './db';
import { fetchKlineRange, MIN_BEG } from './kline';

/**
 * 启动时补齐自选股票的日K：
 * 1. 基准：固定 2 只代表股取最近 10 个交易日，取其中最新日期；15:15 前当天K线未完成，不算基准；
 * 2. 只处理 stocks.zx=1，库中最新日期 >= 基准则跳过；
 * 3. 落后时从库中最新日期往前回看 10 个交易日请求，重叠部分逐字段严格比对；
 * 4. 不一致判为复权基准变动（除权/分红），删除该股旧数据后全量重拉覆盖。
 */
const FULL_BEG = MIN_BEG;
/** 完整历史的判定起点：2024 年首个交易日附近，早于该日即视为覆盖 2024-01-01 起 */
const FULL_COVER_ISO = '2024-01-10';
const OVERLAP_TRADING_DAYS = 10;
const REQUEST_GAP_MS = 300;
/** 15:15 后当天K线才视为完成 */
const CLOSE_MINUTES = 15 * 60 + 15;
/** 基准探测代表股：贵州茅台、平安银行 */
const PROBE_SECIDS = ['1.600519', '0.000001'];

const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);

function parseIso(text) {
  const [year, month, day] = String(text).split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatIso(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function isWeekend(date) {
  const week = date.getDay();
  return week === 0 || week === 6;
}

/** 当天是否已过 15:15（当天K线视为完成） */
export function isTodaySettled(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes() >= CLOSE_MINUTES;
}

/** 本地日历兜底：探测失败时用（不识别节假日） */
export function latestSettledTradingDate(now = new Date()) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (isWeekend(date) || !isTodaySettled(now)) {
    date.setDate(date.getDate() - 1);
  }
  while (isWeekend(date)) date.setDate(date.getDate() - 1);
  return formatIso(date);
}

/** 按交易日平移（仅跳过周末，不考虑节假日） */
export function shiftTradingDays(iso, offset) {
  const date = parseIso(iso);
  const step = offset > 0 ? 1 : -1;
  let left = Math.abs(offset);
  while (left > 0) {
    date.setDate(date.getDate() + step);
    if (!isWeekend(date)) left -= 1;
  }
  return formatIso(date);
}

/** (from, to] 之间的交易日数量 */
export function countTradingDays(fromIso, toIso) {
  const start = parseIso(fromIso);
  const end = parseIso(toIso);
  if (end <= start) return 0;
  let count = 0;
  const cursor = new Date(start);
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    if (!isWeekend(cursor)) count += 1;
  }
  return count;
}

/** 接口日期（YYYYMMDD）转整数入参 */
function toBeg(iso) {
  return Number(iso.replace(/-/g, ''));
}

/** 成交额按元比较：库里单位是亿，读回已换算成元，仅容忍浮点除法误差 */
export function isSameAmount(a, b) {
  if (a == null || b == null) return a == null && b == null;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const base = Math.max(Math.abs(x), Math.abs(y), 1);
  return Math.abs(x - y) <= base * 1e-6;
}

/** 单根K线全字段严格相等；volume / ratio / turnover_ratio 缺失会触发一次全量重拉补齐 */
export function isSameCandle(a, b) {
  return (
    a.date === b.date &&
    a.open === b.open &&
    a.close === b.close &&
    a.high === b.high &&
    a.low === b.low &&
    (a.volume ?? null) === (b.volume ?? null) &&
    isSameAmount(a.amount, b.amount) &&
    (a.ratio ?? null) === (b.ratio ?? null) &&
    (a.turnover_ratio ?? null) === (b.turnover_ratio ?? null)
  );
}

/** 重叠区间是否完全一致；接口缺少库中某一天也算不一致 */
export function isOverlapSame(dbRows, fetched) {
  const map = new Map(fetched.map((candle) => [candle.date, candle]));
  for (const row of dbRows) {
    const item = map.get(row.date);
    if (!item) return false;
    if (!isSameCandle(row, item)) return false;
  }
  return true;
}

/** 从接口返回的K线里取最新已完成交易日（15:15 前当天不算） */
export function pickLatestTradingDate(candles, todayIso, todaySettled = true) {
  let latest = null;
  for (const candle of candles || []) {
    const date = candle.date;
    if (!date || date > todayIso) continue;
    if (date === todayIso && !todaySettled) continue;
    if (!latest || date > latest) latest = date;
  }
  return latest;
}

/** 探测基准：多只代表股返回日期取最大值，避免单只停牌/数据滞后把基准拉旧 */
export async function resolveBaselineTradingDate(now = new Date(), delay = REQUEST_GAP_MS) {
  const todayIso = formatIso(now);
  const settled = isTodaySettled(now);
  const begIso = shiftTradingDays(todayIso, -15);
  let latest = null;
  for (const secid of PROBE_SECIDS) {
    const res = await fetchKlineRange(secid, toBeg(begIso));
    if (res) {
      const date = pickLatestTradingDate(res.candles, todayIso, settled);
      if (date && (!latest || date > latest)) latest = date;
    }
    if (delay) await sleep(delay);
  }
  return latest || latestSettledTradingDate(now);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 新增字段（volume / ratio / turnover_ratio）是否尚未回填：存在任一行缺字段即视为待回填 */
export function needsFieldBackfill(lastDate, missingFields) {
  return Boolean(lastDate) && Number(missingFields || 0) > 0;
}

/** 全量重拉并覆盖（复权基准变动、首次入库、字段回填共用） */
async function reloadAll(secid, baseline, summary) {
  const full = await fetchKlineRange(secid, FULL_BEG);
  if (!full) {
    summary.failed += 1;
    return;
  }
  const all = full.candles.filter((candle) => candle.date <= baseline);
  if (!all.length) {
    summary.skipped += 1;
    return;
  }
  // 数据源可能被截断成只有近期窗口，直接覆盖会丢掉更早历史，此时改为区间合并写入：
  // 先清空 [最早, 基准] 区间，避免源端已不存在的日期留在库里
  if (all[0].date <= FULL_COVER_ISO) await replaceHistory(secid, all);
  else await replaceHistoryRange(secid, all[0].date, baseline, all);
  summary.reloaded += 1;
}

async function syncOne(target, baseline, summary) {
  const secid = target.secid;
  const lastDate = target.last_date || '';

  // 库里没有该股历史，或 volume / ratio / turnover_ratio 尚未回填：全量拉取
  if (!lastDate || needsFieldBackfill(lastDate, target.missing_fields)) {
    await reloadAll(secid, baseline, summary);
    return;
  }

  if (lastDate >= baseline) {
    summary.skipped += 1;
    return;
  }

  const begIso = shiftTradingDays(lastDate, -(OVERLAP_TRADING_DAYS - 1));
  const res = await fetchKlineRange(secid, toBeg(begIso));
  if (!res) {
    summary.failed += 1;
    return;
  }
  // 丢弃基准日之后的K线（15:15 前当天的未完成K线也在此被过滤）
  const candles = res.candles.filter((candle) => candle.date <= baseline);
  const fresh = candles.filter((candle) => candle.date > lastDate);
  if (!fresh.length) {
    // 停牌或接口暂无新数据
    summary.skipped += 1;
    return;
  }

  const dbRows = (await loadHistory(secid, OVERLAP_TRADING_DAYS)).filter(
    (row) => row.date >= begIso && row.date <= lastDate,
  );

  if (isOverlapSame(dbRows, candles)) {
    // 只补缺失日期，重叠日期值相同，覆盖无副作用
    await saveHistory(secid, candles);
    summary.filled += 1;
    return;
  }

  // 历史价发生变动：全量重拉并覆盖
  await reloadAll(secid, baseline, summary);
}

/** 全量重拉指定股票（校验修复用），返回 { reloaded, failed, skipped } */
export async function reloadHistories(secids = [], { delay = REQUEST_GAP_MS, now = new Date() } = {}) {
  const list = (secids || []).filter(Boolean);
  const summary = { reloaded: 0, failed: 0, skipped: 0 };
  if (!list.length) return summary;

  const baseline = await resolveBaselineTradingDate(now, delay);
  for (const secid of list) {
    try {
      await reloadAll(secid, baseline, summary);
    } catch (e) {
      console.error('[kline] 全量重拉失败', secid, e);
      summary.failed += 1;
    }
    if (delay) await sleep(delay);
  }
  return summary;
}

/** 逐只串行补齐，返回统计 */
export async function syncWatchHistory({ delay = REQUEST_GAP_MS, now = new Date() } = {}) {
  // 15:15 前当天K线必然不完整：先清掉上次运行残留的当日行（否则 last_date=今天 会被跳过）
  if (!isTodaySettled(now)) {
    const todayIso = formatIso(now);
    await pruneTodayHistory(todayIso);
  }

  const targets = await loadHistoryTargets();
  const summary = { checked: 0, skipped: 0, filled: 0, reloaded: 0, failed: 0 };
  if (!targets.length) return summary;

  const baseline = await resolveBaselineTradingDate(now, delay);
  for (const target of targets) {
    summary.checked += 1;
    try {
      await syncOne(target, baseline, summary);
    } catch (e) {
      console.error('[kline] 日K补齐失败', target.secid, e);
      summary.failed += 1;
    }
    if (delay) await sleep(delay);
  }
  return summary;
}
