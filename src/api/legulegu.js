import MD5 from 'crypto-js/md5';
import { loadMarketWidthDb, saveMarketWidthDb } from '../utils/db';
import { request } from '../utils/http';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const API_URL = 'https://legulegu.com/api/stockdata/member-ship/ma-market-width';

/* 接口要求带站点访客 Cookie（LAAA，只校验存在不校验取值）与当天日期 MD5 token */
let visitor = { day: '', uuid: '' };
let dataCache = { day: '', value: null };

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
  return request(url, { headers: requestHeaders() });
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

/* 默认从数据库读取；接口成功时把最新数据写回 sckd（新交易日自动累积），
   接口不可用时回落到库内数据。当天只取一次，弹窗反复打开不再重复请求。 */
export async function loadMarketWidth(force = false) {
  if (!force && dataCache.day === today() && dataCache.value) return dataCache.value;

  const stored = await loadMarketWidthDb();
  let fresh = null;
  try {
    fresh = buildRows(parsePayload(await requestApi(fetchStart(stored))));
    await saveMarketWidthDb(fresh);
  } catch (e) {
    if (hasData(stored)) {
      dataCache = { day: today(), value: stored };
      return stored;
    }
    throw e;
  }

  // 写入后再读库，返回库内完整历史（含接口窗口之外的旧日期）
  const merged = await loadMarketWidthDb();
  const value = hasData(merged) ? merged : hasData(fresh) ? fresh : stored;
  dataCache = { day: today(), value };
  return value;
}
