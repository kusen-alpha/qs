import MD5 from 'crypto-js/md5';
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

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
}

function requestApi() {
  const url =
    `${API_URL}?level=1&severalTradeDays=30&startDate=${daysAgo(45)}&endDate=${today()}` +
    `&maType=value20&token=${tokenOf()}`;
  return request(url, {
    headers: {
      'User-Agent': UA,
      Cookie: visitorCookie(),
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
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

/* 当天数据只取一次，弹窗反复打开不再重复请求 */
export async function loadMarketWidth(force = false) {
  if (!force && dataCache.day === today() && dataCache.value) return dataCache.value;
  const res = await requestApi();
  const value = buildRows(parsePayload(res));
  dataCache = { day: today(), value };
  return value;
}
