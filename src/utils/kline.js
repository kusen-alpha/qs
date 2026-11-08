import { request } from './http';
import { loadHistory, saveHistory } from './db';

/**
 * 日 K 线数据获取（东方财富 push2his，klt=101 日线，fqt=1 前复权）。
 * 东财日K接口不可用时退回腾讯 newfqkline（同为前复权）。
 * HQChart 通过 NetworkFilter 呼叫这里。
 */

const UT = '7eea3edcaed734bea9cbfc24409ed989';
/** 日K最早日期：2024-01-01 */
export const MIN_BEG = 20240101;
const MIN_BEG_ISO = '2024-01-01';
/** 视为「已覆盖 2024-01-01 起」的判定日（2024 年首个交易日 1 月 2 日） */
const FULL_COVER_ISO = '2024-01-10';
/** 单次行情请求超时：东财不可达时不能无限等待，超时后立即走腾讯兜底 */
const REQUEST_TIMEOUT_MS = 8000;
/** 15:15 后当天K线才视为完成，与 klineSync 的收盘完成线保持一致 */
const CLOSE_MINUTES = 15 * 60 + 15;

export const EASTMONEY_HEADERS = {
  Referer: 'https://quote.eastmoney.com/',
};

const TENCENT_URL = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get';
export const TENCENT_HEADERS = {
  Referer: 'https://gu.qq.com/',
};
/** 腾讯单次最多返回 640 根，按年拆分请求 */
const TENCENT_MAX_BARS = 640;
/** 东财日K本次运行不可用时置位，后续直接走腾讯兜底 */
let eastmoneyDown = false;

/** 东财 secid（1.600519）转纯代码（600519） */
export function secidToSymbol(secid) {
  const text = String(secid || '');
  const dot = text.indexOf('.');
  return dot === -1 ? text : text.slice(dot + 1);
}

/** 东财 secid（1.600519）转腾讯代码（sh600519 / sz000001 / bj920002） */
export function secidToTencentSymbol(secid) {
  const text = String(secid || '');
  const dot = text.indexOf('.');
  if (dot === -1) return text;
  const market = text.slice(0, dot);
  const code = text.slice(dot + 1);
  if (market === '1') return `sh${code}`;
  // 北交所代码以 43/83/87/88/92 开头，腾讯用 bj 前缀（sz 前缀会查不到数据）
  if (/^[489]/.test(code)) return `bj${code}`;
  return `sz${code}`;
}

export function buildKlineUrl(secid, beg = MIN_BEG, end = 20500101) {
  const params = {
    fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    beg,
    end,
    rtntype: 6,
    secid,
    klt: 101,
    fqt: 1,
    ut: UT,
  };
  return 'https://push2his.eastmoney.com/api/qt/stock/kline/get?' + new URLSearchParams(params).toString();
}

/** 接口数值列：空串 / "-" 视为缺失 */
function numOf(text) {
  if (text == null) return null;
  const raw = String(text).trim();
  if (!raw || raw === '-') return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

/**
 * 东财 fields2：date, open, close, high, low, volume, amount, 振幅, 涨跌幅, 涨跌额, 换手率
 * ratio / turnover_ratio 为百分数（2.35 表示 +2.35%），接口缺列时为 null。
 */
export function parseKlines(klines) {
  const list = [];
  for (const line of klines || []) {
    const arr = String(line).split(',');
    if (arr.length < 7) continue;
    const open = Number(arr[1]);
    const close = Number(arr[2]);
    const high = Number(arr[3]);
    const low = Number(arr[4]);
    if (![open, close, high, low].every(Number.isFinite)) continue;
    const volume = numOf(arr[5]);
    const amount = numOf(arr[6]);
    list.push({
      date: arr[0],
      open,
      close,
      high,
      low,
      // 缺失成交量/成交额时显式置 null：NaN 会让K线重叠比对永远不相等，触发反复全量重拉
      volume: volume == null ? null : volume * 100,
      amount,
      ratio: arr.length > 8 ? numOf(arr[8]) : null,
      turnover_ratio: arr.length > 10 ? numOf(arr[10]) : null,
    });
  }
  return list;
}

/** 保留两位小数 */
function round2(value) {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : null;
}

/** 20240101 / 2024-01-01 统一为 YYYY-MM-DD */
function isoOfDay(value) {
  const text = String(value);
  if (text.length === 8) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  return text;
}

/** 按自然年拆分请求区间：腾讯单次最多 640 根，未来年份不请求 */
function splitByYear(beg, end) {
  const begYear = Number(isoOfDay(beg).slice(0, 4));
  const endYear = Math.min(Number(isoOfDay(end).slice(0, 4)), new Date().getFullYear());
  const chunks = [];
  for (let year = begYear; year <= endYear; year += 1) {
    chunks.push([`${year}-01-01`, `${year}-12-31`]);
  }
  return chunks;
}

/**
 * 腾讯 qfqday：date, open, close, high, low, volume(手), {}, 换手率(%), amount(万元), ''
 * 成交量转股、成交额转元，与东财口径对齐；涨跌幅腾讯不提供，由 fetchTencentRange 按收盘价补算。
 */
export function parseTencentKlines(lines) {
  const list = [];
  for (const line of lines || []) {
    if (!Array.isArray(line) || line.length < 6) continue;
    const open = Number(line[1]);
    const close = Number(line[2]);
    const high = Number(line[3]);
    const low = Number(line[4]);
    if (![open, close, high, low].every(Number.isFinite)) continue;
    const volume = line.length >= 6 ? Number(line[5]) : NaN;
    const amount = line.length >= 9 ? Number(line[8]) : NaN;
    list.push({
      date: String(line[0]),
      open,
      close,
      high,
      low,
      volume: Number.isFinite(volume) ? round2(volume * 100) : null,
      amount: Number.isFinite(amount) ? round2(amount * 10000) : null,
      ratio: null,
      turnover_ratio: line.length >= 8 ? numOf(line[7]) : null,
    });
  }
  return list;
}

/** 带超时的请求：避免单个接口卡住时整段K线一直等不到结果 */
async function timedRequest(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await request(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 东财日K（主数据源） */
async function fetchEastmoneyRange(secid, beg, end) {
  if (eastmoneyDown) return null;
  try {
    const res = await timedRequest(buildKlineUrl(secid, beg, end), {
      headers: EASTMONEY_HEADERS,
    });
    const data = res && res.data && res.data.data;
    if (data && Array.isArray(data.klines) && data.klines.length) {
      const candles = parseKlines(data.klines);
      if (!candles.length) return null;
      return {
        name: data.name || '',
        code: data.code || '',
        preClose: Number(data.preKPrice) || null,
        candles,
      };
    }
  } catch (e) {
    // 东财整条链路不可用时本次运行不再重试，避免每只股票都等一次超时
    eastmoneyDown = true;
  }
  return null;
}

/** 腾讯日K（东财不可用时的兜底，前复权） */
async function fetchTencentRange(secid, beg, end) {
  const symbol = secidToTencentSymbol(secid);
  const map = new Map();
  for (const [chunkBeg, chunkEnd] of splitByYear(beg, end)) {
    const param = `${symbol},day,${chunkBeg},${chunkEnd},${TENCENT_MAX_BARS},qfq`;
    let data = null;
    try {
      const res = await timedRequest(`${TENCENT_URL}?param=${encodeURIComponent(param)}`, {
        headers: TENCENT_HEADERS,
      });
      data = res && res.data && res.data.data && res.data.data[symbol];
    } catch (e) {
      data = null;
    }
    for (const candle of parseTencentKlines(data && (data.qfqday || data.day))) {
      map.set(candle.date, candle);
    }
  }
  if (!map.size) return null;
  const candles = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  // 腾讯不提供涨跌幅，按前一根收盘价补算（同一年份区间内合并后连续，首根为 null）
  let prevClose = null;
  for (const candle of candles) {
    candle.ratio = prevClose ? (candle.close / prevClose - 1) * 100 : null;
    prevClose = candle.close;
  }
  // 腾讯按结束日反向补满 640 根，退市或区间内无行情的股票会返回 beg 之前的远古K线，
  // 这里按请求区间裁剪；涨跌幅在上面已按连续序列算好，裁剪不影响区间首根的比值
  const begIso = isoOfDay(beg);
  const endIso = isoOfDay(end);
  const ranged = candles.filter((candle) => candle.date >= begIso && candle.date <= endIso);
  if (!ranged.length) return null;
  return { name: '', code: secidToSymbol(secid), preClose: null, candles: ranged };
}

/** 只请求区间日K，不落库（供启动补齐与重叠比对使用） */
export async function fetchKlineRange(secid, beg = MIN_BEG, end = 20500101) {
  const result = await fetchEastmoneyRange(secid, beg, end);
  if (result) return result;
  return fetchTencentRange(secid, beg, end);
}

/** 当天K线是否已完成（15:15 前盘中只有半根K线） */
function isTodaySettled(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes() >= CLOSE_MINUTES;
}

/**
 * 剔除未完成的当日K线：接口在盘中会返回当天半根K线，
 * 图表可展示它，但直接落库会污染 histories、板块历史与 MACD。
 */
export function settledCandles(candles, now = new Date()) {
  const list = candles || [];
  if (isTodaySettled(now)) return list;
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return list.filter((candle) => candle.date !== today);
}

/** YYYY-MM-DD 的前一天 */
function dayBefore(iso) {
  const [year, month, day] = String(iso).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() - 1);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 数据源只返回近期窗口时（如 MACD 预取 400 天），补拉更早区间直到 MIN_BEG */
async function fetchOlderRange(secid, firstDate) {
  if (!firstDate || firstDate <= FULL_COVER_ISO) return [];
  const endIso = dayBefore(firstDate);
  if (endIso < MIN_BEG_ISO) return [];
  const older = await fetchKlineRange(secid, MIN_BEG, Number(endIso.replace(/-/g, '')));
  if (!older || !older.candles.length) return [];
  return older.candles.filter((candle) => candle.date >= MIN_BEG_ISO && candle.date < firstDate);
}

export async function fetchKline(secid, beg = MIN_BEG) {
  const res = await fetchKlineRange(secid, beg);
  if (res) {
    // 盘中不落库未完成的当日K线，避免污染 histories / 板块历史 / MACD
    const persist = settledCandles(res.candles);
    if (persist.length) await saveHistory(secid, persist);
    // 全量请求只拿到近期窗口时（行情源截断），补拉更早历史，保证最早到 2024-01-01
    if (beg === MIN_BEG && res.candles.length) {
      const older = await fetchOlderRange(secid, res.candles[0].date);
      if (older.length) {
        await saveHistory(secid, settledCandles(older));
        return { ...res, candles: [...older, ...res.candles] };
      }
    }
    return res;
  }
  const cached = await loadHistory(secid, 200);
  if (cached.length) {
    return {
      name: '',
      code: secidToSymbol(secid),
      preClose: null,
      candles: cached,
    };
  }
  return null;
}

/* ---------------- 本地兜底数据（接口不可用时保持图表可显示） ---------------- */

function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function basePrice(secid) {
  const m = /^\d+\.(\d+)$/.exec(secid || '');
  const code = m ? m[1] : '000001';
  if (code === '600519') return 1480;
  if (code.startsWith('688')) return 28 + (hashSeed(secid) % 800) / 10;
  if (code.startsWith('300')) return 12 + (hashSeed(secid) % 1200) / 10;
  return 5 + (hashSeed(secid) % 800) / 10;
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function recentTradingDates(count) {
  const out = [];
  const d = new Date();
  while (out.length < count) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) out.unshift(fmtDate(d));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

/** 确定性随机日 K，仅在接口不可用时用于占位 */
export function fallbackKline(secid) {
  const rnd = mulberry32(hashSeed(`${secid}-daily`));
  const dates = recentTradingDates(160);
  const list = [];
  let price = basePrice(secid);
  for (let i = 0; i < dates.length; i++) {
    const open = price * (1 + (rnd() - 0.5) * 0.012);
    const close = open * (1 + (rnd() - 0.5) * 0.045);
    const high = Math.max(open, close) * (1 + rnd() * 0.012);
    const low = Math.min(open, close) * (1 - rnd() * 0.012);
    const volume = Math.round((0.35 + rnd()) * 2600000) * 100;
    list.push({
      date: dates[i],
      open: +open.toFixed(2),
      close: +close.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      volume,
      amount: Math.round(volume * close),
    });
    price = close;
  }
  return list.slice(-120);
}
