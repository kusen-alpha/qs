/**
 * 同花顺接口：个股所属申万一级/二级行业、同花顺行业板块。
 * 依据 docs/同花顺接口.md（3.11 / 3.12）：
 * - 申万行业：basic.10jqka.com.cn/{code}/company.html（GBK，按代码缓存 7 天）
 * - 同花顺行业板块：basic.10jqka.com.cn/{code}/field.html 中
 *   “行业新闻-更多”链接 list/field/0881xxx/，取板块代码后在
 *   q.10jqka.com.cn/thshy/ 的板块全表里查名称（如 881273 -> 白酒）。
 *   两套体系各自独立取数，互不推导。
 */
import { requestBytes } from '../utils/http';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COMPANY_URL = (code) => `https://basic.10jqka.com.cn/${code}/company.html`;
const FIELD_URL = (code) => `https://basic.10jqka.com.cn/${code}/field.html`;
const BOARD_URL = 'https://q.10jqka.com.cn/thshy/';
const TTL = 7 * 24 * 60 * 60 * 1000;
const SW_STORAGE = 'qs.ths.sw-industry';
const BOARD_STORAGE = 'qs.ths.boards';
const FIELD_STORAGE = 'qs.ths.field-board';
const MAX_WORKERS = 3;
const INTERVAL = 350;

/* ---------------- 解析 ---------------- */

/** 解析 company.html 中的“所属申万行业”字段，缺失时返回 null */
export function parseSwIndustry(html) {
  if (!html) return null;
  const m = html.match(/所属申万行业[：:]\s*<\/strong>\s*<span>(.*?)<\/span>/s);
  if (!m) return null;
  const raw = m[1]
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const [l1, l2] = raw.split('—').map((s) => s.trim());
  if (!l1) return null;
  return { raw, l1, l2: l2 || '' };
}

/** 解析 field.html 中的同花顺行业板块代码（0881273 -> 881273），无归属返回 null */
export function parseFieldBoardCode(html) {
  if (!html) return null;
  const m = html.match(/list\/field\/0(881\d{3})\//);
  return m ? m[1] : null;
}

/** 解析行业板块全表，返回 { 板块代码: 板块名称 } */
export function parseBoardMap(html) {
  if (!html) return {};
  const map = {};
  const re = /thshy\/detail\/code\/(881\d{3})\/"[^>]*>([^<]{1,20})</g;
  for (const m of html.matchAll(re)) {
    const name = m[2].trim();
    if (name) map[m[1]] = name;
  }
  return map;
}

/* ---------------- 抓取与缓存 ---------------- */

async function fetchPage(url, referer) {
  const res = await requestBytes(url, {
    headers: { 'User-Agent': UA, Referer: referer },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new TextDecoder('gbk').decode(res.data);
}

function readCache(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) {
    return {};
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* 存储失败时仅保留内存缓存 */
  }
}

let swCache = readCache(SW_STORAGE);
let fieldCache = readCache(FIELD_STORAGE);
let boardCache = readCache(BOARD_STORAGE);

/* 页面较重，最多 3 并发且每次之间留间隔 */
let active = 0;
const pending = [];

function drain() {
  while (active < MAX_WORKERS && pending.length > 0) {
    const job = pending.shift();
    active += 1;
    job
      .run()
      .then(job.resolve, () => job.resolve(null))
      .finally(() => {
        active -= 1;
        setTimeout(drain, INTERVAL);
      });
  }
}

function enqueue(run) {
  return new Promise((resolve) => {
    pending.push({ run, resolve });
    drain();
  });
}

const requests = new Map();

function loadCached(code, cache, storageKey, url, parse) {
  const hit = cache[code];
  if (hit && Date.now() - hit.t < TTL && hit.value) return Promise.resolve(hit);
  if (requests.has(code + storageKey)) return requests.get(code + storageKey);
  const task = enqueue(() => fetchPage(url, 'https://basic.10jqka.com.cn/')).then((html) => {
    const value = html ? parse(html) : null;
    if (!value) return hit || null;
    const item = { value, t: Date.now() };
    cache[code] = item;
    writeCache(storageKey, cache);
    return item;
  });
  requests.set(code + storageKey, task);
  return task.finally(() => requests.delete(code + storageKey));
}

/** 同花顺行业板块全表（本地缓存 7 天） */
async function loadBoardMap() {
  const hit = boardCache.value;
  if (hit && Object.keys(hit).length > 0 && Date.now() - boardCache.t < TTL) return hit;
  if (requests.has(BOARD_STORAGE)) return requests.get(BOARD_STORAGE);
  const task = enqueue(() => fetchPage(BOARD_URL, 'https://q.10jqka.com.cn/'))
    .then((html) => {
      const map = html ? parseBoardMap(html) : {};
      if (Object.keys(map).length === 0) return hit || {};
      boardCache = { value: map, t: Date.now() };
      writeCache(BOARD_STORAGE, boardCache);
      return map;
    })
    .catch(() => hit || {});
  requests.set(BOARD_STORAGE, task);
  return task.finally(() => requests.delete(BOARD_STORAGE));
}

/** 单只股票的申万行业（本地缓存 7 天） */
export async function loadSwIndustry(code) {
  return loadCached(code, swCache, SW_STORAGE, COMPANY_URL(code), parseSwIndustry);
}

/** 单只股票的同花顺行业板块代码（本地缓存 7 天） */
export async function loadFieldBoardCode(code) {
  return loadCached(code, fieldCache, FIELD_STORAGE, FIELD_URL(code), parseFieldBoardCode);
}

/** 批量获取：代码 -> { l1, l2, ths }，ths 为同花顺行业板块名称 */
export async function loadStockConcepts(codes) {
  const list = [...new Set((codes || []).map((c) => String(c || '')))]
    .filter((c) => /^\d{6}$/.test(c));
  const out = {};
  if (list.length === 0) return out;
  const boardMap = await loadBoardMap();
  await Promise.all(
    list.map(async (code) => {
      const [sw, board] = await Promise.all([
        loadSwIndustry(code).catch(() => null),
        loadFieldBoardCode(code).catch(() => null),
      ]);
      const value = sw && sw.value;
      out[code] = {
        l1: (value && value.l1) || '',
        l2: (value && value.l2) || '',
        ths: (board && board.value && boardMap[board.value]) || '',
      };
    }),
  );
  return out;
}
