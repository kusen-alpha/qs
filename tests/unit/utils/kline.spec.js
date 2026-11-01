import { describe, expect, it, vi } from 'vitest';
import {
  buildKlineUrl,
  fallbackKline,
  fetchKlineRange,
  parseKlines,
  parseTencentKlines,
  secidToSymbol,
  secidToTencentSymbol,
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
      '2024-01-05,10.60,10.70,10.90,10.50,300,3120000.00,1.8,0.94,0.10,2.35',
    ]);
    expect(list).toHaveLength(3);
    expect(list[0]).toEqual({
      date: '2024-01-02',
      open: 10,
      close: 10.5,
      high: 10.8,
      low: 9.9,
      volume: 123400,
      amount: 1234000,
      ratio: null,
      turnover_ratio: null,
    });
    expect(list[1].date).toBe('2024-01-04');
    expect(list[2].ratio).toBeCloseTo(0.94);
    expect(list[2].turnover_ratio).toBeCloseTo(2.35);
  });

  it('parseKlines 涨跌幅/换手率为空串或 "-" 时返回 null', () => {
    const list = parseKlines([
      '2024-01-02,10.00,10.50,10.80,9.90,100,1000000.00,1.0,-,0.50,-',
      '2024-01-03,10.50,10.60,10.70,10.40,200,2000000.00,1.0,0.95,0.10,0.00',
    ]);
    expect(list[0].ratio).toBe(null);
    expect(list[0].turnover_ratio).toBe(null);
    expect(list[1].ratio).toBeCloseTo(0.95);
    expect(list[1].turnover_ratio).toBe(0);
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

  it('secidToTencentSymbol 按市场拼接 sh/sz', () => {
    expect(secidToTencentSymbol('1.600519')).toBe('sh600519');
    expect(secidToTencentSymbol('0.000001')).toBe('sz000001');
    expect(secidToTencentSymbol('600519')).toBe('600519');
  });

  it('parseTencentKlines 成交量转股、成交额转元、换手率直取', () => {
    const list = parseTencentKlines([
      ['2024-01-02', '1363.00', '1392.05', '1393.37', '1352.98', '59927.00', {}, '0.48', '825738.18', ''],
      ['2024-01-03', '10.00', 'abc', '10.90', '10.20', '100.00'],
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      date: '2024-01-02',
      open: 1363,
      close: 1392.05,
      high: 1393.37,
      low: 1352.98,
      volume: 5992700,
      amount: 8257381800,
      ratio: null,
      turnover_ratio: 0.48,
    });
  });

  it('东财日K不可用时退回腾讯', async () => {
    const urls = [];
    vi.stubGlobal('fetch', async (url) => {
      urls.push(String(url));
      if (String(url).includes('push2his')) throw new Error('blocked');
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            data: {
              sh600519: {
                qfqday: [
                  ['2024-01-02', '1363.00', '1392.05', '1393.37', '1352.98', '59927.00', {}, '0.48', '825738.18', ''],
                ],
              },
            },
          }),
      };
    });
    const res = await fetchKlineRange('1.600519', 20240101);
    vi.unstubAllGlobals();

    expect(urls.some((url) => url.includes('newfqkline'))).toBe(true);
    expect(res.candles).toHaveLength(1);
    expect(res.candles[0].volume).toBe(5992700);
    expect(res.candles[0].ratio).toBe(null);
    expect(res.candles[0].turnover_ratio).toBe(0.48);
  });

  it('腾讯兜底按前一根收盘价补算涨跌幅', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: {
            sh600519: {
              qfqday: [
                ['2024-01-02', '10.00', '10.00', '10.10', '9.90', '1000.00', {}, '0.20', '100.00', ''],
                ['2024-01-03', '10.00', '10.50', '10.60', '9.95', '1200.00', {}, '0.25', '120.00', ''],
              ],
            },
          },
        }),
    }));
    const res = await fetchKlineRange('1.600519', 20240101);
    vi.unstubAllGlobals();

    expect(res.candles).toHaveLength(2);
    expect(res.candles[0].ratio).toBe(null);
    expect(res.candles[1].ratio).toBeCloseTo(5);
    expect(res.candles[1].turnover_ratio).toBe(0.25);
  });

  it('腾讯兜底裁剪 beg 之前与 end 之后的K线', async () => {
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).includes('push2his')) throw new Error('blocked');
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            data: {
              sh600519: {
                qfqday: [
                  ['2003-08-01', '10.00', '10.00', '10.10', '9.90', '1000.00', {}, '0.20', '100.00', ''],
                  ['2003-08-04', '10.00', '10.20', '10.30', '9.95', '1200.00', {}, '0.25', '120.00', ''],
                  ['2024-01-02', '10.00', '10.50', '10.60', '9.90', '1500.00', {}, '0.30', '150.00', ''],
                  ['2050-01-05', '10.50', '10.60', '10.70', '10.40', '1600.00', {}, '0.31', '160.00', ''],
                ],
              },
            },
          }),
      };
    });
    const res = await fetchKlineRange('1.600519', 20240101, 20500101);
    vi.unstubAllGlobals();

    expect(res.candles.map((candle) => candle.date)).toEqual(['2024-01-02']);
    // 区间首根的涨跌幅仍按裁剪前的连续序列补算（相对 2003-08-04 的收盘价）
    expect(res.candles[0].ratio).toBeCloseTo(2.941, 3);
  });

  it('腾讯兜底全部落在区间外时返回 null', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: {
            sh600002: {
              qfqday: [['2003-08-01', '10.00', '10.00', '10.10', '9.90', '1000.00', {}, '0.20', '100.00', '']],
            },
          },
        }),
    }));
    const res = await fetchKlineRange('1.600002', 20240101);
    vi.unstubAllGlobals();

    expect(res).toBe(null);
  });
});
