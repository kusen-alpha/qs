import { request } from './http';

/**
 * 日 K 线数据获取（东方财富 push2his，klt=101 日线，fqt=1 前复权）。
 * HQChart 通过 NetworkFilter 呼叫这里。
 */

const UT = '7eea3edcaed734bea9cbfc24409ed989';

export const EASTMONEY_HEADERS = {
  Referer: 'https://quote.eastmoney.com/',
};

/** 东财 secid（1.600519）转纯代码（600519） */
export function secidToSymbol(secid) {
  const text = String(secid || '');
  const dot = text.indexOf('.');
  return dot === -1 ? text : text.slice(dot + 1);
}

export function buildKlineUrl(secid, beg = 20150101) {
  const params = {
    fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    beg,
    end: 20500101,
    rtntype: 6,
    secid,
    klt: 101,
    fqt: 1,
    ut: UT,
  };
  return 'https://push2his.eastmoney.com/api/qt/stock/kline/get?' + new URLSearchParams(params).toString();
}

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
    list.push({
      date: arr[0],
      open,
      close,
      high,
      low,
      volume: Number(arr[5]) * 100,
      amount: Number(arr[6]),
    });
  }
  return list;
}

export async function fetchKline(secid, beg = 20150101) {
  try {
    const res = await request(buildKlineUrl(secid, beg), { headers: EASTMONEY_HEADERS });
    const data = res && res.data && res.data.data;
    if (data && Array.isArray(data.klines) && data.klines.length) {
      return {
        name: data.name || '',
        code: data.code || '',
        preClose: Number(data.preKPrice) || null,
        candles: parseKlines(data.klines),
      };
    }
  } catch (e) {
    /* 网络失败时由调用方使用兜底数据 */
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
