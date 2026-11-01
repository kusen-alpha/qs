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
import { isTauri } from '../utils/env';
import {
  loadBoards,
  saveBoards,
  saveIndustries,
  loadIndustries,
  saveStockConcepts,
} from '../utils/db';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COMPANY_URL = (code) => `https://basic.10jqka.com.cn/${code}/company.html`;
const FIELD_URL = (code) => `https://basic.10jqka.com.cn/${code}/field.html`;
const CONCEPT_URL = (code) => `https://basic.10jqka.com.cn/${code}/concept.html`;
const BOARD_URL = 'https://q.10jqka.com.cn/thshy/';
const TTL = 7 * 24 * 60 * 60 * 1000;
const SW_STORAGE = 'qs.ths.sw-industry';
const BOARD_STORAGE = 'qs.ths.boards';
const FIELD_STORAGE = 'qs.ths.field-board';
const CONCEPT_STORAGE = 'qs.ths.stock-concepts';
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

/**
 * 解析 concept.html 中“概念”标签，返回 [{ code: '885761', name: '白酒' }]。
 * 每行形如 <td class="gnName" clid="885761">白酒</td>，clid 缺失时 code 为空串。
 */
export function parseStockConcepts(html) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  const re = /<td([^>]*gnName[^>]*)>([\s\S]*?)<\/td>/g;
  for (const m of html.matchAll(re)) {
    const name = m[2]
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name) continue;
    const code = (m[1].match(/clid="(\d+)"/) || [])[1] || '';
    const key = code || name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code, name });
  }
  return out;
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
let conceptCache = readCache(CONCEPT_STORAGE);
/* 板块全表：桌面端存 stocks.db 的 boards 表，浏览器端仍用 localStorage */
let boardCache = null;

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

/** 读取板块全表缓存：{ value: { 代码: 名称 }, t: 更新时间 } */
async function readBoardCache() {
  if (isTauri()) {
    if (boardCache) return boardCache;
    const data = await loadBoards();
    const value = (data && data.boards) || {};
    if (Object.keys(value).length === 0) return null;
    boardCache = { value, t: data.updated_at || 0 };
    return boardCache;
  }
  const raw = readCache(BOARD_STORAGE);
  return raw && raw.value ? raw : null;
}

async function writeBoardCache(value) {
  boardCache = { value, t: Date.now() };
  if (isTauri()) {
    await saveBoards(value);
    return;
  }
  writeCache(BOARD_STORAGE, boardCache);
}

/** 同花顺行业板块全表（本地缓存 7 天） */
async function loadBoardMap() {
  const hit = await readBoardCache();
  const hitValue = (hit && hit.value) || {};
  if (Object.keys(hitValue).length > 0 && Date.now() - hit.t < TTL) return hitValue;
  if (requests.has(BOARD_STORAGE)) return requests.get(BOARD_STORAGE);
  const task = enqueue(() => fetchPage(BOARD_URL, 'https://q.10jqka.com.cn/'))
    .then(async (html) => {
      const map = html ? parseBoardMap(html) : {};
      if (Object.keys(map).length === 0) return hitValue;
      await writeBoardCache(map);
      return map;
    })
    .catch(() => hitValue);
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

/** 单只股票的官方概念列表（本地缓存 7 天） */
async function loadStockConceptList(code) {
  return loadCached(
    code,
    conceptCache,
    CONCEPT_STORAGE,
    CONCEPT_URL(code),
    parseStockConcepts,
  );
}

/**
 * 批量获取：代码 -> { l1, l2, ths, gns }。
 * ths 为同花顺行业板块名称，gns 为同花顺官方概念 [{ code, name }]。
 * 桌面端先读 stocks 表：7 天内查过的直接复用（即使字段为空也不重抓），
 * 只有缺失或过期（含库里没有这只股票）才走接口，抓完再写回库。
 */
export async function loadStockConcepts(codes) {
  const list = [...new Set((codes || []).map((c) => String(c || '')))]
    .filter((c) => /^\d{6}$/.test(c));
  const out = {};
  if (list.length === 0) return out;

  const cached = {};
  if (isTauri()) {
    const rows = await loadIndustries(list);
    for (const row of rows || []) {
      if (row.updated_at && Date.now() - row.updated_at < TTL) cached[row.code] = row;
    }
  }

  const missing = [];
  for (const code of list) {
    const hit = cached[code];
    if (hit) {
      const gn = conceptCache[code];
      out[code] = {
        l1: hit.l1 || '',
        l2: hit.l2 || '',
        ths: hit.ths || '',
        gns: gn && Date.now() - gn.t < TTL ? gn.value : [],
      };
    } else {
      missing.push(code);
    }
  }
  if (missing.length === 0) return out;

  const boardMap = await loadBoardMap();
  const fresh = {};
  const conceptRows = [];
  await Promise.all(
    missing.map(async (code) => {
      const [sw, board, gns] = await Promise.all([
        loadSwIndustry(code).catch(() => null),
        loadFieldBoardCode(code).catch(() => null),
        loadStockConceptList(code).catch(() => null),
      ]);
      const value = sw && sw.value;
      const item = {
        l1: (value && value.l1) || '',
        l2: (value && value.l2) || '',
        ths: (board && board.value && boardMap[board.value]) || '',
        gns: (gns && gns.value) || [],
      };
      out[code] = item;
      fresh[code] = item;
      if (item.gns.length) conceptRows.push({ code, concepts: item.gns });
    }),
  );
  // 只写本次新抓的，避免刷新库里有效记录的 7 天计时
  saveIndustries(fresh);
  saveStockConcepts(conceptRows);
  return out;
}
