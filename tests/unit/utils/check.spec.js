import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/db', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadHistory: vi.fn(),
    loadWatchlist: vi.fn(),
    loadIndustries: vi.fn(),
    saveQuotes: vi.fn(),
    cleanOrphanStocks: vi.fn(),
  };
});

const realtimeMock = vi.hoisted(() => vi.fn());
const refreshIndustryMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/eastmoney', () => ({
  EastmoneyApi: class {
    realtime(...args) {
      return realtimeMock(...args);
    }
  },
}));

vi.mock('@/api/ths', () => ({ refreshStockIndustries: refreshIndustryMock }));

import * as db from '@/utils/db';
import {
  HISTORY_MIN_DATE,
  checkStocksData,
  checkWatchHistory,
  evaluateHistory,
  evaluateStocksData,
  repairOrphanStocks,
  repairStocksData,
} from '@/utils/check';

const STOCKS = [
  { secid: '1.600519', symbol: '600519', name: '贵州茅台' },
  { secid: '0.000001', symbol: '000001', name: '平安银行' },
];

/** 完整序列：2024 年起始 + 最近两个交易日（2026-11-02 周一、2026-11-03 周二） */
const FULL_DATES = [
  '2024-01-02',
  '2024-01-03',
  '2024-01-04',
  '2024-01-05',
  '2024-01-08',
  '2024-01-09',
  '2024-01-10',
  '2026-11-02',
  '2026-11-03',
];

const candles = (dates) => dates.map((date) => ({ date }));

describe('check · 历史数据齐全度判定', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('所有自选股都覆盖 2024-01-01 起且无缺失时判定通过', () => {
    const result = evaluateHistory(STOCKS, {
      '1.600519': candles(FULL_DATES),
      '0.000001': candles(FULL_DATES),
    });

    expect(result.status).toBe('ok');
    expect(result.total).toBe(2);
    expect(result.complete).toBe(2);
    expect(result.issues).toEqual([]);
    expect(result.marketFirst).toBe('2024-01-02');
    expect(result.marketLast).toBe('2026-11-03');
    expect(result.summary).toBe('共 2 只自选股，历史数据齐全');
  });

  it('没有历史数据的股票标记为缺失', () => {
    const result = evaluateHistory(STOCKS, {
      '1.600519': candles(FULL_DATES),
      '0.000001': [],
    });

    expect(result.status).toBe('fail');
    expect(result.complete).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      secid: '0.000001',
      name: '平安银行',
      first: null,
      last: null,
      reasons: ['无历史数据'],
    });
    expect(result.summary).toBe('共 2 只自选股，1 只历史完整，1 只存在问题');
  });

  it('首根K线晚于 2024-01-10 判定为起始不足', () => {
    const result = evaluateHistory(STOCKS, {
      '1.600519': candles(['2024-02-01', '2026-11-02', '2026-11-03']),
      '0.000001': candles([...FULL_DATES, '2024-02-01'].sort()),
    });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reasons[0]).toBe(`起始 2024-02-01，未覆盖 ${HISTORY_MIN_DATE}`);
  });

  it('最新日期落后市场最新交易日时给出落后天数', () => {
    const result = evaluateHistory(STOCKS, {
      '1.600519': candles(FULL_DATES.slice(0, -1)),
      '0.000001': candles(FULL_DATES),
    });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].last).toBe('2026-11-02');
    expect(result.issues[0].reasons).toContain('最新 2026-11-02，落后 1 个交易日');
  });

  it('落后天数按库内真实交易日计数，长假不会被周末算法夸大', () => {
    // 库内日历：09-29、09-30 之后直接跳到 10-08、10-09（国庆长假没有交易日）
    const base = ['2024-01-02', '2024-01-03', '2026-09-29', '2026-09-30'];
    const result = evaluateHistory(STOCKS, {
      '1.600519': candles(base),
      '0.000001': candles([...base, '2026-10-08', '2026-10-09']),
    });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].last).toBe('2026-09-30');
    expect(result.issues[0].reasons).toContain('最新 2026-09-30，落后 2 个交易日');
  });

  it('15:15 前忽略仅用于展示的当日合成K线，避免误报落后', () => {
    // 2026-11-03 周二 10:00 盘中：loadHistory 会给已刷新行情的股票合成当天K线
    const now = new Date(2026, 10, 3, 10, 0);
    const result = evaluateHistory(
      STOCKS,
      {
        '1.600519': candles(FULL_DATES),
        '0.000001': candles(FULL_DATES.slice(0, -1)),
      },
      now,
    );

    expect(result.status).toBe('ok');
    expect(result.marketLast).toBe('2026-11-02');
    expect(result.issues).toEqual([]);
  });

  it('15:15 后当日已收盘，当天K线参与落后判定', () => {
    const now = new Date(2026, 10, 3, 15, 30);
    const result = evaluateHistory(
      STOCKS,
      {
        '1.600519': candles(FULL_DATES),
        '0.000001': candles(FULL_DATES.slice(0, -1)),
      },
      now,
    );

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].last).toBe('2026-11-02');
    expect(result.issues[0].reasons).toContain('最新 2026-11-02，落后 1 个交易日');
  });

  it('中间缺少交易日时统计缺失天数', () => {
    const result = evaluateHistory(STOCKS, {
      '1.600519': candles(FULL_DATES.filter((date) => date !== '2024-01-05')),
      '0.000001': candles(FULL_DATES),
    });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reasons).toContain('中间缺失 1 个交易日');
  });

  it('没有自选股时返回空结果', () => {
    const result = evaluateHistory([], {});

    expect(result.status).toBe('ok');
    expect(result.total).toBe(0);
    expect(result.summary).toBe('暂无自选股票');
  });
});

describe('check · 读取自选股票历史', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('逐只读取历史（1000 根上限）后汇总判定', async () => {
    db.loadHistory.mockImplementation(async (secid) =>
      candles(secid === '1.600519' ? FULL_DATES : FULL_DATES.slice(0, -1)),
    );

    const result = await checkWatchHistory(STOCKS);

    expect(db.loadHistory).toHaveBeenCalledTimes(2);
    expect(db.loadHistory).toHaveBeenCalledWith('1.600519', 1000);
    expect(db.loadHistory).toHaveBeenCalledWith('0.000001', 1000);
    expect(result.status).toBe('fail');
    expect(result.issues[0].secid).toBe('0.000001');
  });

  it('读取异常按无数据处理，不影响其他股票', async () => {
    db.loadHistory.mockImplementation(async (secid) => {
      if (secid === '1.600519') throw new Error('boom');
      return candles(FULL_DATES);
    });

    const result = await checkWatchHistory(STOCKS);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].secid).toBe('1.600519');
    expect(result.issues[0].reasons).toEqual(['无历史数据']);
  });
});

const STOCK_ROWS = [
  { secid: '1.600519', name: '贵州茅台', price: 100, ratio: 1, turnover_ratio: 2 },
  { secid: '0.000001', name: '平安银行', price: 10, ratio: 0.5, turnover_ratio: 1 },
];

const INDUSTRIES = [
  { code: '600519', l1: '食品饮料', l2: '白酒Ⅱ', ths: '白酒' },
  { code: '000001', l1: '银行', l2: '股份制银行', ths: '银行' },
];

describe('check · stocks 表数据判定', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.loadWatchlist.mockResolvedValue({ stocks: STOCK_ROWS });
    db.loadIndustries.mockResolvedValue(INDUSTRIES);
  });

  it('记录与关键字段齐全时判定通过', () => {
    const result = evaluateStocksData(STOCKS, STOCK_ROWS, INDUSTRIES);

    expect(result.status).toBe('ok');
    expect(result.total).toBe(2);
    expect(result.complete).toBe(2);
    expect(result.issues).toEqual([]);
    expect(result.summary).toBe('共 2 只自选股，stocks 数据齐全');
  });

  it('stocks 表缺少记录时标记为缺数据', () => {
    const result = evaluateStocksData(STOCKS, [STOCK_ROWS[0]], INDUSTRIES);

    expect(result.status).toBe('fail');
    expect(result.complete).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      secid: '0.000001',
      name: '平安银行',
      reasons: ['stocks 表缺少记录'],
    });
    expect(result.summary).toBe('共 2 只自选股，1 只 stocks 数据完整，1 只缺数据');
  });

  it('记录缺少名称、现价、涨跌幅时列出缺失字段', () => {
    const result = evaluateStocksData(STOCKS, [
      STOCK_ROWS[0],
      { secid: '0.000001', name: '  ', price: null, ratio: null, turnover_ratio: 0 },
    ], INDUSTRIES);

    expect(result.issues[0].reasons).toEqual(['缺少名称', '缺少现价', '缺少涨跌幅']);
  });

  it('现价小于等于 0 视为缺少现价', () => {
    const result = evaluateStocksData(STOCKS, [
      { ...STOCK_ROWS[0], price: 0 },
      STOCK_ROWS[1],
    ], INDUSTRIES);

    expect(result.issues[0].reasons).toEqual(['缺少现价']);
  });

  it('现价、涨跌幅、换手率为字符串数字时视为有效', () => {
    const result = evaluateStocksData(STOCKS, [
      { secid: '1.600519', name: '贵州茅台', price: '100.5', ratio: '-0.3', turnover_ratio: '2.1' },
      STOCK_ROWS[1],
    ], INDUSTRIES);

    expect(result.status).toBe('ok');
  });

  it('缺少申万与同花顺行业时列出缺失字段', () => {
    const result = evaluateStocksData(STOCKS, STOCK_ROWS, [
      { code: '600519', l1: '', l2: ' ', ths: '' },
      INDUSTRIES[1],
    ]);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reasons).toEqual([
      '缺少申万一级行业',
      '缺少申万二级行业',
      '缺少同花顺行业',
    ]);
  });

  it('没有行业记录时按行业全部缺失处理', () => {
    const result = evaluateStocksData(STOCKS, STOCK_ROWS, []);

    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].reasons).toEqual([
      '缺少申万一级行业',
      '缺少申万二级行业',
      '缺少同花顺行业',
    ]);
  });

  it('逐行读取 stocks 表后汇总判定', async () => {
    db.loadWatchlist.mockResolvedValue({ stocks: [STOCK_ROWS[0]] });

    const result = await checkStocksData(STOCKS);

    expect(db.loadWatchlist).toHaveBeenCalledTimes(1);
    expect(db.loadIndustries).toHaveBeenCalledWith(['600519', '000001']);
    expect(result.status).toBe('fail');
    expect(result.issues[0].secid).toBe('0.000001');
  });

  it('读取 stocks 表失败时按全部缺数据处理', async () => {
    db.loadWatchlist.mockRejectedValue(new Error('boom'));

    const result = await checkStocksData(STOCKS);

    expect(result.issues).toHaveLength(2);
    expect(result.summary).toBe('共 2 只自选股，0 只 stocks 数据完整，2 只缺数据');
  });

  it('读取行业字段失败时按行业全部缺失处理', async () => {
    db.loadIndustries.mockRejectedValue(new Error('boom'));

    const result = await checkStocksData(STOCKS);

    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].reasons).toEqual([
      '缺少申万一级行业',
      '缺少申万二级行业',
      '缺少同花顺行业',
    ]);
  });
});

describe('check · 孤儿股票判定', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.loadIndustries.mockResolvedValue(INDUSTRIES);
  });

  it('传入引用集合时把失去全部引用的股票列为可清理项', () => {
    const rows = [...STOCK_ROWS, { secid: '0.000002', name: '孤儿股票', price: 1 }];
    const result = evaluateStocksData(
      STOCKS,
      rows,
      INDUSTRIES,
      new Set(['1.600519', '0.000001']),
    );

    expect(result.status).toBe('fail');
    // 孤儿不计入自选完整数
    expect(result.complete).toBe(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ secid: '0.000002', orphan: true });
    expect(result.summary).toBe('共 2 只自选股，stocks 数据齐全；另有 1 只孤儿股票可清理');
  });

  it('没有名称的行业/板块缓存行不算孤儿', () => {
    const rows = [...STOCK_ROWS, { secid: '0.000002', name: '', price: 1 }];
    const result = evaluateStocksData(
      STOCKS,
      rows,
      INDUSTRIES,
      new Set(['1.600519', '0.000001']),
    );

    expect(result.status).toBe('ok');
    expect(result.issues).toEqual([]);
  });

  it('按数据库中的自选与概念成员识别孤儿股票', async () => {
    db.loadWatchlist.mockResolvedValue({
      stocks: [
        { ...STOCK_ROWS[0], zx: true },
        { ...STOCK_ROWS[1], zx: false },
        { secid: '0.000002', name: '孤儿股票', zx: false },
        { secid: '0.000003', name: '', zx: false, industry1: '银行' },
      ],
      notions: [],
      members: [{ notion_id: 1, secid: '0.000001' }],
    });

    const result = await checkStocksData(STOCKS);

    expect(result.issues.map((issue) => issue.secid)).toEqual(['0.000002']);
    expect(result.issues[0].orphan).toBe(true);
  });

  it('修复孤儿股票时只清理、不拉行情', async () => {
    db.cleanOrphanStocks.mockResolvedValue({ removed: 1 });

    const result = await repairOrphanStocks(['0.000002', '']);

    expect(db.cleanOrphanStocks).toHaveBeenCalledWith(['0.000002']);
    expect(result).toEqual({ removed: 1 });
    expect(realtimeMock).not.toHaveBeenCalled();
  });
});

describe('check · stocks 表修复', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('重拉行情与行业并写回', async () => {
    const quotes = [{ secid: '0.000001', name: '平安银行', price: 10 }];
    realtimeMock.mockResolvedValue(quotes);
    refreshIndustryMock.mockResolvedValue({
      '000001': { l1: '银行', l2: '股份制银行', ths: '银行' },
    });

    const result = await repairStocksData(['0.000001']);

    expect(realtimeMock).toHaveBeenCalledWith([{ secid: '0.000001' }]);
    expect(db.saveQuotes).toHaveBeenCalledWith(quotes);
    expect(refreshIndustryMock).toHaveBeenCalledWith(['000001']);
    expect(result).toEqual({ updated: 1, industries: 1 });
  });

  it('行情接口没有返回数据时报错', async () => {
    realtimeMock.mockResolvedValue([]);

    await expect(repairStocksData(['0.000001'])).rejects.toThrow('行情接口未返回数据');
  });

  it('行业抓取失败时行情仍写回且不抛错', async () => {
    realtimeMock.mockResolvedValue([{ secid: '0.000001', price: 10 }]);
    refreshIndustryMock.mockRejectedValue(new Error('boom'));

    const result = await repairStocksData(['0.000001']);

    expect(db.saveQuotes).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ updated: 1, industries: 0 });
  });
});
