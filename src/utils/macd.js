/**
 * MACD 连续天数指标。
 * 指标含义：MACD 柱（DIF - DEA）连续大于 0 或连续小于 0 的天数，
 * 大于 0 记为正数，小于 0 记为负数（例如 5 表示连续 5 根红柱，-3 表示连续 3 根绿柱）。
 */

/** EMA 序列（首个值作为种子） */
export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** 日 K（按时间升序，需含 close/date）→ MACD 柱序列 */
export function macdHistogram(candles, fast = 12, slow = 26, signal = 9) {
  if (!candles || !candles.length) return [];
  const closes = candles.map((c) => c.close);
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const difs = closes.map((_, i) => fastEma[i] - slowEma[i]);
  const deas = ema(difs, signal);
  return candles.map((c, i) => ({ date: c.date, value: difs[i] - deas[i] }));
}

/** 最新一段连续同号天数：正数 / 负数 / 0（数据不足或最后一天为 0） */
export function signDays(series) {
  if (!series || !series.length) return 0;
  const last = series[series.length - 1].value;
  if (!Number.isFinite(last) || last === 0) return 0;
  const positive = last > 0;
  let count = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    const value = series[i].value;
    if (!Number.isFinite(value) || value === 0) break;
    if (value > 0 !== positive) break;
    count += 1;
  }
  return positive ? count : -count;
}

/** 多只股票的 MACD 序列按日期对齐取平均（某日缺数据则跳过该股票） */
export function averageSeries(seriesList) {
  const buckets = new Map();
  for (const series of seriesList || []) {
    for (const item of series || []) {
      const bucket = buckets.get(item.date);
      if (bucket) {
        bucket.sum += item.value;
        bucket.count += 1;
      } else {
        buckets.set(item.date, { sum: item.value, count: 1 });
      }
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, bucket]) => ({ date, value: bucket.sum / bucket.count }));
}

/** 概念层面：先算出成分股每日 MACD 平均序列，再数连续天数 */
export function aggregateSignDays(seriesList) {
  return signDays(averageSeries(seriesList));
}
