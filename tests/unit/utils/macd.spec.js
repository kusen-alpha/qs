import { describe, expect, it } from 'vitest';
import { ema, macdHistogram, signDays, averageSeries, aggregateSignDays } from '@/utils/macd';

function candles(closes) {
  return closes.map((close, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, close }));
}

function series(values) {
  return values.map((value, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, value }));
}

describe('macd · 计算', () => {
  it('ema 按周期加权，首值作为种子', () => {
    const out = ema([1, 2, 3], 2);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(1);
    expect(out[1]).toBeCloseTo(1.6667, 3);
    expect(out[2]).toBeCloseTo(2.5556, 3);
  });

  it('横盘时 DIF、DEA、MACD 柱均为 0', () => {
    const hist = macdHistogram(candles(Array(40).fill(10)));
    expect(hist).toHaveLength(40);
    expect(hist.every((item) => Math.abs(item.value) < 1e-9)).toBe(true);
  });

  it('上涨后 MACD 柱为正，下跌后为负', () => {
    const up = macdHistogram(candles([...Array(30).fill(10), ...Array(6).fill(20)]));
    expect(up.at(-1).value).toBeGreaterThan(0);
    const down = macdHistogram(candles([...Array(30).fill(10), ...Array(6).fill(5)]));
    expect(down.at(-1).value).toBeLessThan(0);
  });
});

describe('macd · 连续天数', () => {
  it('连续为正记正数，连续为负记负数', () => {
    expect(signDays(series([-1, 2, 3, 4]))).toBe(3);
    expect(signDays(series([1, -2, -3]))).toBe(-2);
  });

  it('最后一根为 0 或没有数据时返回 0', () => {
    expect(signDays(series([2, 2, 0]))).toBe(0);
    expect(signDays([])).toBe(0);
    expect(signDays(null)).toBe(0);
  });
});

describe('macd · 概念聚合', () => {
  it('按日期对齐取平均，缺日期跳过该股票', () => {
    const merged = averageSeries([series([1, 2]), series([3])]);
    expect(merged[0].value).toBe(2);
    expect(merged[1].value).toBe(2);
  });

  it('先算成分股每日平均柱，再数连续天数', () => {
    expect(aggregateSignDays([series([3, 3]), series([-1, -1])])).toBe(2);
    expect(aggregateSignDays([series([3, -3]), series([-1, 1])])).toBe(-1);
    expect(aggregateSignDays([series([-2, 2]), series([-2, 2])])).toBe(1);
  });
});
