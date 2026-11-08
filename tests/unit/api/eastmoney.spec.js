import { describe, expect, it, vi } from 'vitest';
import {
  EastmoneyApi,
  calcPosition,
  formatAmount,
  formatRate,
  mergeRealtime,
  pickBySource,
  summarizeProfit,
  toNumber,
} from '@/api/eastmoney';

const net = vi.hoisted(() => ({ request: vi.fn(), saveQuotes: vi.fn() }));
vi.mock('@/utils/http', () => ({ request: net.request }));
vi.mock('@/utils/db', () => ({ saveQuotes: net.saveQuotes }));

const api = new EastmoneyApi();

describe('eastmoney · 实时行情映射', () => {
  it('processRealtimeData 映射东财字段', () => {
    const [row] = api.processRealtimeData([
      { f12: '600519', f13: 1, f14: '贵州茅台', f2: 1500, f3: 1.5, f4: 22, f8: 0.3, f15: 1520, f16: 1480, f17: 1490, f18: 1478 },
    ]);
    expect(row).toMatchObject({
      name: '贵州茅台',
      secid: '1.600519',
      price: 1500,
      range: 1.5,
      price_diff: 22,
      high: 1520,
      low: 1480,
      pre_close: 1478,
    });
    expect(row.position_num).toBe('-');
  });

  it('processRealtimeData 入参为空返回 []', () => {
    expect(api.processRealtimeData(null)).toEqual([]);
    expect(api.processRealtimeData([])).toEqual([]);
  });

  it('processRealtimeData 映射交易所行情时间 f124，供后端判断当天是否真的刷新过', () => {
    const [row] = api.processRealtimeData([
      { f12: '600519', f13: 1, f14: '贵州茅台', f2: 1500, f124: 1762300200 },
    ]);
    expect(row.time).toBe(1762300200);
  });

  it('processRealtimeData 不再把 f86 当成时间戳（该字段不是成交时间）', () => {
    const [row] = api.processRealtimeData([
      { f12: '600519', f13: 1, f14: '贵州茅台', f2: 1500, f86: 34.58 },
    ]);
    expect(row.time).toBeUndefined();
  });
});

describe('eastmoney · 实时行情请求与写库', () => {
  it('请求字段包含 f124（成交时间戳）', async () => {
    net.request.mockResolvedValue({ ok: true, data: { data: { diff: [] } } });
    await api.realtime([{ secid: '1.600519' }]);
    expect(net.request.mock.calls[0][0]).toContain('f124');
  });

  it('默认写库，非交易日探测传 save=false 时只读不写', async () => {
    net.request.mockResolvedValue({
      ok: true,
      data: { data: { diff: [{ f12: '600519', f13: 1, f2: 1500, f124: 1762300200 }] } },
    });
    const rows = await api.realtime([{ secid: '1.600519' }]);
    expect(rows).toHaveLength(1);
    expect(net.saveQuotes).toHaveBeenCalledTimes(1);

    net.saveQuotes.mockClear();
    await api.realtime([{ secid: '1.600519' }], false);
    expect(net.saveQuotes).not.toHaveBeenCalled();
  });
});

describe('eastmoney · 组合与持仓计算', () => {
  const watchGroup = [
    { name: '自选', symbols: [{ secid: '1.600519', source: '1' }, { secid: '0.000001', source: '0' }] },
    { name: '行业', symbols: [{ secid: '0.000858', source: '1' }] },
  ];

  it('pickBySource 跨分组按来源筛选', () => {
    expect(pickBySource(watchGroup, '1').map((s) => s.secid)).toEqual(['1.600519', '0.000858']);
    expect(pickBySource(watchGroup, '0').map((s) => s.secid)).toEqual(['0.000001']);
  });

  it('mergeRealtime 有行情时用行情，无行情时给占位行', () => {
    const quotes = [{ secid: '1.600519', price: 1500, price_diff: 20 }];
    const symbols = [
      { secid: '1.600519', name: '贵州茅台' },
      { secid: '1.000001', name: '平安银行' },
    ];
    const merged = mergeRealtime(quotes, symbols, []);
    expect(merged[0].price).toBe(1500);
    expect(merged[1]).toMatchObject({ name: '平安银行', price: '-' });
  });

  it('mergeRealtime 对有持仓的标的填入持仓盈亏', () => {
    const quotes = [{ secid: '1.600519', price: 1600, price_diff: 10 }];
    const configs = [{ secid: '1.600519', position: { buyPrice: 1500, buyAmount: 100 } }];
    const [row] = mergeRealtime(quotes, [{ secid: '1.600519', name: '贵州茅台' }], configs);
    expect(row.position_num).toBe(100);
    expect(row.position_value).toBe(160000);
    expect(row.position_profit).toBe(10000);
    expect(row.position_profit_rate).toBeCloseTo(10000 / 150000);
  });

  it('calcPosition 计算市值 / 盈亏 / 收益率', () => {
    const pos = calcPosition({ price: 12 }, { position: { buyPrice: 10, buyAmount: 1000 } });
    expect(pos).toEqual({
      num: 1000,
      buy_price: 10,
      value: 12000,
      profit: 2000,
      profit_rate: 0.2,
    });
  });

  it('summarizeProfit 汇总总盈亏与今盈亏', () => {
    const quotes = [
      { secid: '1.600519', price: 1600, price_diff: 10 },
      { secid: '0.000001', price: 12, price_diff: -0.5 },
    ];
    const configs = [
      { secid: '1.600519', position: { buyPrice: 1500, buyAmount: 100 } },
      { secid: '0.000001', position: { buyPrice: 10, buyAmount: 200 } },
      { secid: '1.000858' }, // 无持仓，不参与
    ];
    const sum = summarizeProfit(quotes, configs);
    expect(sum.total_profit).toBe(10000 + 400);
    expect(sum.today_profit).toBe(1000 - 100);
    expect(sum.total_profit_rate).toBeCloseTo(10400 / (150000 + 2000));
    expect(sum.today_profit_rate).toBeCloseTo(900 / (159000 + 2500));
  });

  it('summarizeProfit 当天平盘（涨跌额为 0）的持仓仍计入总盈亏', () => {
    const quotes = [{ secid: '1.600519', price: 1600, price_diff: 0 }];
    const configs = [{ secid: '1.600519', position: { buyPrice: 1500, buyAmount: 100 } }];
    const sum = summarizeProfit(quotes, configs);
    expect(sum.total_profit).toBe(10000);
    expect(sum.total_cost).toBe(150000);
    expect(sum.today_profit).toBe(0);
    expect(sum.total_profit_rate).toBeCloseTo(10000 / 150000);
    expect(sum.today_profit_rate).toBe((0 / 160000));
  });
});

describe('eastmoney · 格式化', () => {
  it('toNumber', () => {
    expect(toNumber(1)).toBe(1);
    expect(toNumber('2.5')).toBe(2.5);
    expect(Number.isNaN(toNumber(null))).toBe(true);
  });

  it('formatAmount 金额缩写', () => {
    expect(formatAmount(9999)).toBe('9999');
    expect(formatAmount(12345)).toBe('1.2万');
    expect(formatAmount(123456)).toBe('12万');
    expect(formatAmount(123456789)).toBe('1.23亿');
    // 停牌/缺行情时价格为 '-'，toNumber 得到 NaN，不能显示成 NaN亿
    expect(formatAmount(NaN)).toBe('-');
    expect(formatAmount(undefined)).toBe('-');
  });

  it('formatRate 收益率', () => {
    expect(formatRate(0.1234)).toBe('12.34%');
    expect(formatRate(12.345)).toBe('12.35倍');
    expect(formatRate(1234.5)).toBe('1235倍');
    expect(formatRate(100000)).toBe('>10万倍');
    // NaN 曾因比较全为 false 而落到「>10万倍」分支
    expect(formatRate(NaN)).toBe('-');
  });
});
