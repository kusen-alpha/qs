import { describe, expect, it } from 'vitest';
import {
  buildKlineUrl,
  fallbackKline,
  parseKlines,
  secidToSymbol,
} from '@/utils/kline';

describe('kline 工具', () => {
  it('secidToSymbol 去掉市场前缀', () => {
    expect(secidToSymbol('1.600519')).toBe('600519');
    expect(secidToSymbol('0.000001')).toBe('000001');
    expect(secidToSymbol('600519')).toBe('600519');
    expect(secidToSymbol(null)).toBe('');
  });

  it('buildKlineUrl 固定日线 / 前复权参数', () => {
    const url = buildKlineUrl('1.600519');
    expect(url.startsWith('https://push2his.eastmoney.com/api/qt/stock/kline/get?')).toBe(true);
    expect(url).toContain('klt=101');
    expect(url).toContain('fqt=1');
    expect(url).toContain('secid=1.600519');
  });

  it('parseKlines 映射字段并跳过脏数据', () => {
    const list = parseKlines([
      '2024-01-02,10.00,10.50,10.80,9.90,1234,1234000.00',
      '2024-01-03,10.50,abc,10.90,10.20,100,1000',
      'too,few,fields',
      '2024-01-04,10.50,10.60,10.70,10.40,200,2000',
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      date: '2024-01-02',
      open: 10,
      close: 10.5,
      high: 10.8,
      low: 9.9,
      volume: 123400,
      amount: 1234000,
    });
    expect(list[1].date).toBe('2024-01-04');
  });

  it('parseKlines 入参为空时返回空数组', () => {
    expect(parseKlines()).toEqual([]);
    expect(parseKlines([])).toEqual([]);
  });

  it('fallbackKline 生成 120 根确定性的合法日 K', () => {
    const a = fallbackKline('1.600519');
    const b = fallbackKline('1.600519');
    expect(a).toHaveLength(120);
    expect(a).toEqual(b);
    for (const candle of a) {
      expect(candle.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(candle.high).toBeGreaterThanOrEqual(Math.max(candle.open, candle.close));
      expect(candle.low).toBeLessThanOrEqual(Math.min(candle.open, candle.close));
      expect(candle.volume).toBeGreaterThan(0);
    }
    // 日期升序
    const dates = a.map((c) => c.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('fallbackKline 不同标的不同', () => {
    expect(fallbackKline('1.600519')[0].open).not.toBe(fallbackKline('0.000001')[0].open);
  });
});
