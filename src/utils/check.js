import { cleanOrphanStocks, loadHistory, loadIndustries, loadWatchlist, saveQuotes } from './db';
import { isTodaySettled, reloadHistories } from './klineSync';
import { EastmoneyApi } from '../api/eastmoney';
import { refreshStockIndustries } from '../api/ths';

/**
 * 数据校验工具：独立校验窗口的各项检查与修复逻辑。
 * 目前包含 stocks 表股票数据、histories 表股票历史数据两项，后续新增校验项时在这里补充纯函数与加载函数。
 */

/** 历史数据最早起点（与 kline.js 的 MIN_BEG 保持一致） */
export const HISTORY_MIN_DATE = '2024-01-01';
/** 起始覆盖判定日：首根K线早于该日即视为已覆盖 2024-01-01 起 */
export const HISTORY_COVER_DATE = '2024-01-10';
/** 2024-01-01 起不足 1000 个交易日，一次读满即可 */
const HISTORY_LIMIT = 1000;

/**
 * 15:15 前当天K线尚未落库，loadHistory 为图表展示合成的那根不能当作真实历史，
 * 否则会把当日有合成K线的股票与没有的股票比较，误报「落后 1 个交易日」。
 */
function dropUnsettledToday(list, now) {
  if (isTodaySettled(now)) return list;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  return list.filter((candle) => candle.date !== today);
}

/**
 * 纯函数版历史数据齐全度判定：
 * 1. 无历史数据；
 * 2. 首根日期晚于 HISTORY_COVER_DATE（未覆盖 2024-01-01 起）；
 * 3. 最新日期落后于市场最新交易日（停牌/未补齐）；
 * 4. 自身区间内缺少其他股票普遍都有的交易日。
 * histories 为 { secid: candles[] }。
 */
export function evaluateHistory(stocks = [], histories = {}, now = new Date()) {
  const list = (stocks || []).filter((stock) => stock && stock.secid);
  const rows = list.map((stock) => ({
    stock,
    candles: dropUnsettledToday(
      (histories[stock.secid] || [])
        .filter((candle) => candle && candle.date)
        .slice()
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
      now,
    ),
  }));

  // 市场日历：统计每根日期出现在多少只股票中，判定单只股票时排除它自己，
  // 避免该股独有的异常日期把其他股票误判为缺失
  const nonEmpty = rows.filter((row) => row.candles.length);
  const totals = new Map();
  for (const row of nonEmpty) {
    for (const candle of row.candles) {
      totals.set(candle.date, (totals.get(candle.date) || 0) + 1);
    }
  }
  const allDates = [...totals.keys()].sort();
  const marketFirst = allDates.length ? allDates[0] : null;
  const marketLast = allDates.length ? allDates[allDates.length - 1] : null;
  const refStocks = Math.max(0, nonEmpty.length - 1);
  const refNeed = refStocks > 0 ? Math.max(1, Math.ceil(refStocks / 2)) : 0;

  const issues = [];
  for (const { stock, candles } of rows) {
    const base = { secid: stock.secid, symbol: stock.symbol || '', name: stock.name || '' };
    if (!candles.length) {
      issues.push({ ...base, first: null, last: null, reasons: ['无历史数据'] });
      continue;
    }
    const first = candles[0].date;
    const last = candles[candles.length - 1].date;
    const reasons = [];

    if (first > HISTORY_COVER_DATE) {
      reasons.push(`起始 ${first}，未覆盖 ${HISTORY_MIN_DATE}`);
    }
    if (marketLast && last < marketLast) {
      // 用库内真实出现过的日期计数，而不是只跳周末，避免长假后夸大落后天数
      const gap = allDates.filter((date) => date > last && date <= marketLast).length;
      reasons.push(`最新 ${last}，落后 ${gap} 个交易日`);
    }

    if (refNeed > 0) {
      const dates = new Set(candles.map((candle) => candle.date));
      let missing = 0;
      for (const date of allDates) {
        if (date <= first || date >= last || dates.has(date)) continue;
        const others = totals.get(date) || 0;
        if (others >= refNeed) missing += 1;
      }
      if (missing) reasons.push(`中间缺失 ${missing} 个交易日`);
    }

    if (reasons.length) issues.push({ ...base, first, last, reasons });
  }

  const total = list.length;
  const complete = total - issues.length;
  let summary = '暂无自选股票';
  if (total) {
    summary = issues.length
      ? `共 ${total} 只自选股，${complete} 只历史完整，${issues.length} 只存在问题`
      : `共 ${total} 只自选股，历史数据齐全`;
  }

  return {
    total,
    complete,
    issues,
    summary,
    marketFirst,
    marketLast,
    status: issues.length ? 'fail' : 'ok',
  };
}

/** 读取所有自选股票的历史K线后做齐全度判定；load 可在测试中替换 */
export async function checkWatchHistory(stocks = [], load = loadHistory) {
  const list = (stocks || []).filter((stock) => stock && stock.secid);
  const histories = {};
  await Promise.all(
    list.map(async (stock) => {
      try {
        histories[stock.secid] = (await load(stock.secid, HISTORY_LIMIT)) || [];
      } catch (e) {
        console.error('[check] 读取历史数据失败', stock.secid, e);
        histories[stock.secid] = [];
      }
    }),
  );
  return evaluateHistory(list, histories);
}

/** stocks 表必填的行情字段（loadWatchlist 可读到的部分） */
const STOCK_REQUIRED_NUMBERS = [
  { key: 'price', label: '现价', positive: true },
  { key: 'ratio', label: '涨跌幅' },
  { key: 'turnover_ratio', label: '换手率' },
];

/** stocks 表必填的行业字段（loadIndustries 读到的申万/同花顺行业） */
const STOCK_REQUIRED_INDUSTRIES = [
  { key: 'l1', label: '申万一级行业' },
  { key: 'l2', label: '申万二级行业' },
  { key: 'ths', label: '同花顺行业' },
];

function isFiniteNumber(value) {
  if (value == null || value === '') return false;
  return Number.isFinite(Number(value));
}

/** secid（如 1.600519）转 6 位股票代码 */
function stockCode(secid) {
  const parts = String(secid || '').split('.');
  return parts.length > 1 ? parts[1] : parts[0];
}

/**
 * 纯函数版 stocks 表数据判定：自选股票在 stocks 表中缺记录，
 * 或记录缺少名称、现价、涨跌幅、换手率、申万行业、同花顺行业等关键字段；
 * 传入 references（自选 + 概念成员）时，还会把失去全部引用的孤儿股票列为可清理项。
 * rows 为 loadWatchlist().stocks，industries 为 loadIndustries() 的结果。
 */
export function evaluateStocksData(stocks = [], rows = [], industries = [], references = null) {
  const list = (stocks || []).filter((stock) => stock && stock.secid);
  const rowMap = new Map(
    (rows || []).filter((row) => row && row.secid).map((row) => [row.secid, row]),
  );
  const industryMap = new Map(
    (industries || [])
      .filter((row) => row && row.code)
      .map((row) => [String(row.code), row]),
  );

  const issues = [];
  for (const stock of list) {
    const base = {
      secid: stock.secid,
      symbol: stock.symbol || String(stock.secid).split('.')[1] || '',
      name: stock.name || '',
    };
    const row = rowMap.get(stock.secid);
    if (!row) {
      issues.push({ ...base, reasons: ['stocks 表缺少记录'] });
      continue;
    }
    const reasons = [];
    if (!String(row.name || '').trim()) reasons.push('缺少名称');
    for (const field of STOCK_REQUIRED_NUMBERS) {
      const number = row[field.key];
      if (!isFiniteNumber(number) || (field.positive && Number(number) <= 0)) {
        reasons.push(`缺少${field.label}`);
      }
    }
    const industry = industryMap.get(stockCode(stock.secid)) || {};
    for (const field of STOCK_REQUIRED_INDUSTRIES) {
      if (!String(industry[field.key] || '').trim()) {
        reasons.push(`缺少${field.label}`);
      }
    }
    if (reasons.length) issues.push({ ...base, reasons });
  }

  // 孤儿股票：不属于自选也不属于任何概念（概念删除后的遗留数据），可一键清理
  const refSet =
    references instanceof Set ? references : references ? new Set(references) : null;
  if (refSet) {
    for (const row of rows || []) {
      const secid = row && row.secid;
      if (!secid || refSet.has(secid)) continue;
      // 行业/板块缓存行没有名称，不属于用户股票
      if (!String(row.name || '').trim()) continue;
      issues.push({
        secid,
        symbol: String(secid).split('.')[1] || '',
        name: row.name || '',
        orphan: true,
        reasons: ['不在自选或任何概念中（孤儿股票）'],
      });
    }
  }

  const stockIssues = issues.filter((issue) => !issue.orphan);
  const orphanCount = issues.length - stockIssues.length;
  const total = list.length;
  const complete = total - stockIssues.length;
  let summary = '暂无自选股票';
  if (total) {
    summary = stockIssues.length
      ? `共 ${total} 只自选股，${complete} 只 stocks 数据完整，${stockIssues.length} 只缺数据`
      : `共 ${total} 只自选股，stocks 数据齐全`;
  }
  if (orphanCount) {
    summary += `${total ? '；' : ''}另有 ${orphanCount} 只孤儿股票可清理`;
  }

  return { total, complete, issues, summary, status: issues.length ? 'fail' : 'ok' };
}

/** 读取 stocks 表与行业字段后做数据齐全度判定；load / loadInd 可在测试中替换 */
export async function checkStocksData(
  stocks = [],
  load = loadWatchlist,
  loadInd = loadIndustries,
) {
  const list = (stocks || []).filter((stock) => stock && stock.secid);
  let rows = [];
  let references = null;
  try {
    const data = await load();
    rows = (data && data.stocks) || [];
    // 以数据库为准（不是未保存的草稿）：自选 zx=1 + 概念成员
    if (data && Array.isArray(data.notions) && Array.isArray(data.members)) {
      references = new Set([
        ...rows.filter((row) => row && row.zx).map((row) => row.secid),
        ...data.members.filter((member) => member && member.secid).map((member) => member.secid),
      ]);
    }
  } catch (e) {
    console.error('[check] 读取 stocks 表失败', e);
  }
  let industries = [];
  try {
    industries = (await loadInd(list.map((stock) => stockCode(stock.secid))) || []);
  } catch (e) {
    console.error('[check] 读取行业字段失败', e);
  }
  return evaluateStocksData(list, rows, industries, references);
}

/** 修复历史数据：对异常股票全量重拉 2024-01-01 起的日K */
export async function repairWatchHistory(secids = []) {
  return reloadHistories((secids || []).filter(Boolean));
}

/** 修复 stocks 表：删除已失去全部引用的孤儿股票（连带日K与板块成分） */
export async function repairOrphanStocks(secids = []) {
  return cleanOrphanStocks((secids || []).filter(Boolean));
}

/** 修复 stocks 表：重新拉取异常股票的实时行情与申万/同花顺行业并写回 */
export async function repairStocksData(secids = []) {
  const list = (secids || []).filter(Boolean);
  if (!list.length) return { updated: 0, industries: 0 };
  const quotes = await new EastmoneyApi().realtime(list.map((secid) => ({ secid })));
  if (!quotes.length) throw new Error('行情接口未返回数据');
  await saveQuotes(quotes);
  let industries = 0;
  try {
    const map = await refreshStockIndustries(list.map(stockCode));
    industries = Object.values(map || {}).filter(
      (value) => value && (value.l1 || value.l2 || value.ths),
    ).length;
  } catch (e) {
    console.error('[check] 修复行业字段失败', e);
  }
  return { updated: quotes.length, industries };
}
