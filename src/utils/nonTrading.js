import { EastmoneyApi } from '../api/eastmoney';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { formatDate } from './calendar';
import { setNonTradingDay, syncNonTradingDays } from './db';
import { isTauri } from './env';
import { on } from './events';

/** 历史非交易日回填起点（与个股K线最短入库日期一致） */
export const BACKFILL_START = '2024-01-01';

/** 盘中探测标的：固定 3 只流动性好的代表股 */
export const PROBE_SECIDS = ['1.600519', '0.300750', '1.600036'];

/** 连续 3 次都查不到当天成交才判定为非交易日，避免开盘延迟误判 */
export const PROBE_MISS_LIMIT = 3;

/** 探测窗口 9:30–15:15（分钟数，与当天K线合成窗口一致） */
const PROBE_OPEN_MINUTES = 9 * 60 + 30;
const PROBE_CLOSE_MINUTES = 15 * 60 + 15;

const probeApi = new EastmoneyApi();

/** 是否处于探测时间窗内（只判断时刻，周末也探测，结论会命中已有的非交易日记录） */
export function isProbeWindow(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  return minutes >= PROBE_OPEN_MINUTES && minutes <= PROBE_CLOSE_MINUTES;
}

/**
 * 行情里的交易所成交时间（f86，秒）是否落在当天。
 * 非交易日/停牌时该时间停留在上一个交易日，因此只有「日期相同」才算当天有成交。
 */
export function hasTodayDeal(quote, now = new Date()) {
  const sec = Number(quote && quote.time);
  if (!Number.isFinite(sec) || sec <= 0) return false;
  return formatDate(new Date(sec * 1000)) === formatDate(now);
}

/**
 * 盘中非交易日探测状态机。
 * - 时间窗内请求代表股行情，3 只都没有当天成交累计一次 miss；
 * - 连续 3 次 miss 判定当天非交易日并写库（source=probe）；
 * - 只要有一只出现当天成交，则当天是交易日：删除当天可能存在的误记并停止探测；
 * - 请求失败（网络问题）不计入 miss，直接跳过本轮。
 */
export function createTradingDayProbe({
  fetchQuotes = () => probeApi.realtime(PROBE_SECIDS.map((secid) => ({ secid })), false),
  saveNonTrading = (date, nonTrading) => setNonTradingDay(date, nonTrading, 'probe'),
  now = () => new Date(),
  logger = console,
} = {}) {
  let day = '';
  let misses = 0;
  let settled = false;

  async function tick() {
    const current = now();
    const today = formatDate(current);
    if (today !== day) {
      day = today;
      misses = 0;
      settled = false;
    }
    // 当天已有结论（交易日或非交易日），当天不再请求
    if (settled) return 'settled';
    if (!isProbeWindow(current)) return 'outside';

    let quotes;
    try {
      quotes = await fetchQuotes();
    } catch (e) {
      logger.error('[probe] 行情请求失败，跳过本轮', e);
      return 'error';
    }
    // 空结果视为网络/接口异常，不参与判定
    if (!Array.isArray(quotes) || !quotes.length) return 'error';

    if (quotes.some((quote) => hasTodayDeal(quote, current))) {
      misses = 0;
      const saved = await saveNonTrading(today, false);
      // 删除误记失败时不结束当天探测，下一轮继续尝试
      if (!saved) return 'error';
      settled = true;
      logger.info(`[probe] ${today} 有成交，按交易日处理`);
      return 'trading';
    }

    misses += 1;
    if (misses >= PROBE_MISS_LIMIT) {
      const saved = await saveNonTrading(today, true);
      if (!saved) return 'error';
      settled = true;
      logger.info(`[probe] ${today} 连续 ${PROBE_MISS_LIMIT} 次无成交，判定为非交易日`);
      return 'non-trading';
    }
    return 'miss';
  }

  return {
    tick,
    state: () => ({ day, misses, settled }),
  };
}

/**
 * 主窗口启动任务：后台回填历史非交易日，并监听 Rust 定时器广播的探测信号。
 * 只在 Tauri 主窗口生效；其余窗口与浏览器环境直接返回。
 */
export async function startNonTradingCalendar() {
  if (!isTauri()) return;
  try {
    if (getCurrentWindow().label !== 'main') return;
  } catch (e) {
    return;
  }

  const probe = createTradingDayProbe();
  try {
    const result = await syncNonTradingDays(BACKFILL_START, formatDate(new Date()));
    if (result) {
      console.info(`[probe] 非交易日回填完成：新增 ${result.added}，纠错删除 ${result.removed}`);
    }
  } catch (e) {
    console.error('[probe] 非交易日回填失败', e);
  }

  await on('trading-day-probe', () => {
    probe.tick().catch((e) => console.error('[probe] 探测失败', e));
  });
  // 启动时若正处在时间窗内，先探一次，及时纠正回填把「今天」误记成非交易日
  probe.tick().catch((e) => console.error('[probe] 探测失败', e));
}
