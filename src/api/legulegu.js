import MD5 from 'crypto-js/md5';
import { loadMarketWidthDb, saveMarketWidthDb } from '../utils/db';
import { request } from '../utils/http';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const API_URL = 'https://legulegu.com/api/stockdata/member-ship/ma-market-width';

/* 接口要求带站点访客 Cookie（LAAA，只校验存在不校验取值）与当天日期 MD5 token */
let visitor = { day: '', uuid: '' };
let dataCache = { day: '', value: null };
/* 同一窗口内并发刷新共享同一次请求 */
let refreshInFlight = null;

/* 最近一次成功增量刷新的时间，跨窗口共享（localStorage），TTL 内不再重复请求接口 */
const REFRESH_KEY = 'marketWidth.lastRefresh';
const REFRESH_TTL = 10 * 60 * 1000;
/* 接口超时：8 秒未返回即中止，避免窗口一直等待 */
const REQUEST_TIMEOUT = 8000;

function ymd(date) {
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function today() {
  return ymd(new Date());
}

export function tokenOf(day = today()) {
  return MD5(day).toString();
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function visitorCookie() {
  if (visitor.day !== today() || !visitor.uuid) visitor = { day: today(), uuid: uuid() };
  return `LAAA=${visitor.uuid}`;
}

/* 读取最近一次成功刷新的时间戳；非当天记录视为过期 */
function lastRefreshAt() {
  try {
    const info = JSON.parse(localStorage.getItem(REFRESH_KEY) || 'null');
    if (!info || info.day !== today() || !Number.isFinite(info.at)) return 0;
    return info.at;
  } catch (e) {
    return 0;
  }
}

/* 当天且 TTL 内已成功刷新过，可跳过接口请求 */
export function refreshedRecently() {
  const at = lastRefreshAt();
  return !!at && Date.now() - at < REFRESH_TTL;
}

function markRefreshed() {
  try {
    localStorage.setItem(REFRESH_KEY, JSON.stringify({ day: today(), at: Date.now() }));
  } catch (e) {
    /* 存储不可用时忽略，退化为仅本窗口内的缓存 */
  }
}

/* sckd 落库起点，与个股历史一致；早于此日期的市场宽度不保存 */
export const MARKET_WIDTH_MIN_DATE = '2024-01-01';
/* 2024 年首个交易日（元旦休市），允许年初假期余量后即视为已覆盖完整区间 */
const COVERAGE_START = '2024-01-10';

/* 接口只校验 Cookie 是否存在，因此用本地生成的访客 ID 即可 */
export function requestHeaders() {
  return {
    'User-Agent': UA,
    Cookie: visitorCookie(),
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    /* Tauri 的 http 插件默认注入 Origin: tauri://localhost，而本接口带任意 Origin 都返回 403；
       启用 unsafe-headers 后传空值可让插件删除该头（浏览器 fetch 会忽略此字段） */
    Origin: '',
  };
}

/* 不传 severalTradeDays 时由 startDate/endDate 决定区间 */
function requestApi(startDate = MARKET_WIDTH_MIN_DATE) {
  const url =
    `${API_URL}?level=1&startDate=${startDate}&endDate=${today()}` +
    `&maType=value20&token=${tokenOf()}`;
  /* 超时后中止请求，调用方按接口失败处理（库内数据仍可展示） */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  return request(url, { headers: requestHeaders(), signal: controller.signal })
    .catch((e) => {
      if (controller.signal.aborted) throw new Error('市场宽度接口请求超时');
      throw e;
    })
    .finally(() => clearTimeout(timer));
}

function parsePayload(res) {
  if (!res.ok) throw new Error(`市场宽度接口返回 ${res.status}`);
  const payload = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  if (!payload || !payload.dates || !payload.swCodeNames) throw new Error('市场宽度数据格式异常');
  return payload;
}

/* 原始值视图：行=申万一级行业，列=交易日，单元格为该行业站上 MA20 的股票占比(%) */
export function buildRows(payload) {
  const dates = payload.dates || [];
  const industries = payload.swCodeNames || [];
  const rows = industries.map((industry) => {
    const series = (payload.maMarketWidth || {})[industry.indexCode] || [];
    return {
      name: industry.indexName,
      code: industry.indexCode,
      values: dates.map((_, i) => {
        const cell = series[i];
        return cell && Number.isFinite(cell.value20) ? cell.value20 : null;
      }),
    };
  });
  return { dates, rows };
}

function hasData(data) {
  return !!(data && data.dates && data.dates.length);
}

/* 库内未覆盖 2024 年初时整段补齐；已覆盖则从最后日期开始增量更新 */
function fetchStart(stored) {
  const first = stored && stored.range && stored.range.first;
  const last = stored && stored.range && stored.range.last;
  if (!first || !last || first > COVERAGE_START) return MARKET_WIDTH_MIN_DATE;
  return last;
}

/* 启动时幂等补齐：库内未覆盖 2024 年初才整段拉取落库，已覆盖则不额外请求 */
export async function ensureMarketWidthHistory() {
  const stored = await loadMarketWidthDb();
  const covered =
    hasData(stored) &&
    stored.range &&
    stored.range.first &&
    stored.range.first <= COVERAGE_START;
  if (covered) return stored;
  return loadMarketWidth(true);
}

/* 仅读本地库（不请求接口），供窗口先渲染；库内无数据时返回 null */
export async function loadMarketWidthFromDb() {
  const stored = await loadMarketWidthDb();
  return hasData(stored) ? stored : null;
}

/* 增量刷新：以库内最大交易日为起点向接口补齐，成功后落库并返回库内完整历史。
   TTL 内已刷新过、或后台刷新失败时返回 null（不打断已渲染的库内数据）。 */
export async function refreshMarketWidth({ force = false } = {}) {
  if (!force && refreshedRecently()) return null;
  if (!force && refreshInFlight) return refreshInFlight;

  const task = runRefresh(force);
  refreshInFlight = task;
  try {
    return await task;
  } finally {
    if (refreshInFlight === task) refreshInFlight = null;
  }
}

async function runRefresh(force) {
  const stored = await loadMarketWidthDb();
  try {
    const fresh = buildRows(parsePayload(await requestApi(fetchStart(stored))));
    if (!hasData(fresh)) throw new Error('市场宽度数据为空');
    await saveMarketWidthDb(fresh);
    markRefreshed();
    /* 写入后再读库，返回库内完整历史（含接口窗口之外的旧日期） */
    const merged = await loadMarketWidthDb();
    return hasData(merged) ? merged : fresh;
  } catch (e) {
    if (force) throw e;
    return null;
  }
}

/* 兼容阻塞式调用（启动补齐、无库数据等场景）：先读库，再按库内最大日期补数。
   接口不可用时回落到库内数据；库内也无数据则抛出接口错误。 */
export async function loadMarketWidth(force = false) {
  if (!force && dataCache.day === today() && dataCache.value) return dataCache.value;

  const stored = await loadMarketWidthDb();
  if (!force && refreshedRecently() && hasData(stored)) {
    dataCache = { day: today(), value: stored };
    return stored;
  }

  try {
    const value = await refreshMarketWidth({ force: force || !hasData(stored) });
    if (value) {
      dataCache = { day: today(), value };
      return value;
    }
  } catch (e) {
    if (!hasData(stored)) throw e;
  }

  if (hasData(stored)) {
    dataCache = { day: today(), value: stored };
    return stored;
  }
  throw new Error('市场宽度数据不可用');
}
