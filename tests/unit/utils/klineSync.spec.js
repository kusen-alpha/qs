import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/db', () => ({
  loadHistory: vi.fn(),
  loadHistoryTargets: vi.fn(),
  pruneTodayHistory: vi.fn(),
  replaceHistory: vi.fn(),
  replaceHistoryRange: vi.fn(),
  saveHistory: vi.fn(),
}));
vi.mock('@/utils/kline', () => ({ MIN_BEG: 20240101, fetchKlineRange: vi.fn() }));

import * as db from '@/utils/db';
import * as kline from '@/utils/kline';
import {
  countTradingDays,
  isOverlapSame,
  isSameCandle,
  isTodaySettled,
  latestSettledTradingDate,
  needsFieldBackfill,
  pickLatestTradingDate,
  shiftTradingDays,
  syncWatchHistory,
} from '@/utils/klineSync';

/** 2026-11-01 是周日，2026-11-02 是周一，2026-10-30 是周五 */
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute);

describe('klineSync · 交易日推算', () => {
  it('15:15 后当天算已完成交易日', () => {
    expect(isTodaySettled(at(2, 15, 15))).toBe(true);
    expect(latestSettledTradingDate(at(2, 15, 15))).toBe('2026-11-02');
    expect(latestSettledTradingDate(at(2, 16, 0))).toBe('2026-11-02');
  });

  it('15:15 前回退到上一工作日', () => {
    expect(isTodaySettled(at(2, 15, 14))).toBe(false);
    expect(latestSettledTradingDate(at(2, 15, 14))).toBe('2026-10-30');
    expect(latestSettledTradingDate(at(2, 10, 0))).toBe('2026-10-30');
  });

  it('周末回退到周五', () => {
    expect(latestSettledTradingDate(at(1, 12, 0))).toBe('2026-10-30');
    expect(latestSettledTradingDate(at(7, 12, 0))).toBe('2026-11-06');
  });

  it('按交易日平移跳过周末', () => {
    expect(shiftTradingDays('2026-11-02', -4)).toBe('2026-10-27');
    expect(shiftTradingDays('2026-10-30', 1)).toBe('2026-11-02');
    expect(shiftTradingDays('2026-11-02', -1)).toBe('2026-10-30');
  });

  it('统计区间内交易日数量', () => {
    expect(countTradingDays('2026-11-02', '2026-11-02')).toBe(0);
    expect(countTradingDays('2026-10-30', '2026-11-02')).toBe(1);
    expect(countTradingDays('2026-10-28', '2026-11-02')).toBe(3);
  });
});

describe('klineSync · 基准判定', () => {
  const candles = [{ date: '2026-10-29' }, { date: '2026-10-30' }, { date: '2026-11-02' }];

  it('15:15 后最新日期为当天则取当天', () => {
    expect(pickLatestTradingDate(candles, '2026-11-02', true)).toBe('2026-11-02');
  });

  it('15:15 前丢弃当天那根，取上一根', () => {
    expect(pickLatestTradingDate(candles, '2026-11-02', false)).toBe('2026-10-30');
  });

  it('最新日期不是当天则直接用接口返回的最新', () => {
    expect(pickLatestTradingDate(candles.slice(0, 2), '2026-11-02', true)).toBe('2026-10-30');
    expect(pickLatestTradingDate([], '2026-11-02', true)).toBe(null);
  });
});

describe('klineSync · 重叠比对', () => {
  const candle = {
    date: '2026-10-30',
    open: 10,
    close: 10.5,
    high: 10.6,
    low: 9.9,
    volume: 120000,
    amount: 123456.78,
    ratio: 1.25,
    turnover_ratio: 3.4,
  };

  it('价格差分即判不一致', () => {
    expect(isSameCandle(candle, { ...candle, close: 10.501 })).toBe(false);
  });

  it('成交额按元精确比较，不再按亿取整', () => {
    // 旧逻辑按亿两位小数会把两者判成相同；现在差 38 万必须判不一致
    expect(isSameCandle({ ...candle, amount: 8257381800 }, { ...candle, amount: 8257000000 })).toBe(
      false,
    );
    // 仅容忍浮点除法带来的相对误差
    expect(isSameCandle({ ...candle, amount: 8257381800 }, { ...candle, amount: 8257381800.5 })).toBe(
      true,
    );
    expect(isSameCandle({ ...candle, amount: null }, { ...candle, amount: null })).toBe(true);
  });

  it('涨跌幅/换手率缺失或不同判不一致', () => {
    expect(isSameCandle({ ...candle, ratio: null }, candle)).toBe(false);
    expect(isSameCandle(candle, { ...candle, ratio: 1.26 })).toBe(false);
    expect(isSameCandle(candle, { ...candle, turnover_ratio: null })).toBe(false);
  });

  it('成交量缺失或不同判不一致', () => {
    expect(isSameCandle({ ...candle, volume: null }, candle)).toBe(false);
    expect(isSameCandle(candle, { ...candle, volume: 130000 })).toBe(false);
  });

  it('接口缺少库中某天判不一致', () => {
    const dbRows = [candle, { ...candle, date: '2026-10-29' }];
    expect(isOverlapSame(dbRows, [candle])).toBe(false);
  });

  it('重叠部分一致时通过（接口多出的日期不影响）', () => {
    const dbRows = [{ ...candle, date: '2026-10-29' }, candle];
    const fetched = [...dbRows, { ...candle, date: '2026-11-02' }];
    expect(isOverlapSame(dbRows, fetched)).toBe(true);
  });
});

describe('klineSync · 字段回填判定', () => {
  it('存在任意缺字段的行就需要回填', () => {
    expect(needsFieldBackfill('2026-10-30', 3)).toBe(true);
    expect(needsFieldBackfill('2026-10-30', 1)).toBe(true);
  });

  it('所有行字段齐全视为已回填', () => {
    expect(needsFieldBackfill('2026-10-30', 0)).toBe(false);
    expect(needsFieldBackfill('2026-10-30', null)).toBe(false);
  });

  it('库里没有历史时交给首次入库分支', () => {
    expect(needsFieldBackfill('', 5)).toBe(false);
    expect(needsFieldBackfill('', 0)).toBe(false);
  });
});

describe('klineSync · 全量重拉', () => {
  const now = new Date(2026, 10, 3, 16, 0);

  beforeEach(() => {
    vi.clearAllMocks();
    db.loadHistoryTargets.mockResolvedValue([{ secid: '1.600519', last_date: '' }]);
  });

  it('行情源截断成近期窗口时区间合并写入，清理源端已不存在的日期', async () => {
    kline.fetchKlineRange.mockImplementation(async (secid, beg) => {
      if (beg === 20240101) {
        return { candles: [{ date: '2025-09-29' }, { date: '2026-11-03' }] };
      }
      return { candles: [{ date: '2026-11-03' }] };
    });

    const summary = await syncWatchHistory({ now, delay: 0 });

    expect(summary.reloaded).toBe(1);
    expect(db.replaceHistory).not.toHaveBeenCalled();
    expect(db.replaceHistoryRange).toHaveBeenCalledWith('1.600519', '2025-09-29', '2026-11-03', [
      { date: '2025-09-29' },
      { date: '2026-11-03' },
    ]);
  });

  it('覆盖 2024-01-01 起的完整历史时整段覆盖', async () => {
    const candles = [{ date: '2024-01-02' }, { date: '2025-09-29' }, { date: '2026-11-03' }];
    kline.fetchKlineRange.mockImplementation(async (secid, beg) =>
      beg === 20240101 ? { candles } : { candles: [{ date: '2026-11-03' }] },
    );

    await syncWatchHistory({ now, delay: 0 });

    expect(db.replaceHistory).toHaveBeenCalledWith('1.600519', candles);
    expect(db.replaceHistoryRange).not.toHaveBeenCalled();
    expect(db.saveHistory).not.toHaveBeenCalled();
  });

  it('库里存在缺失字段的行时触发全量回填（不只看最新一行）', async () => {
    db.loadHistoryTargets.mockResolvedValue([
      { secid: '1.600519', last_date: '2026-11-03', missing_fields: 2 },
    ]);
    kline.fetchKlineRange.mockResolvedValue({
      candles: [{ date: '2026-11-03' }],
    });

    const summary = await syncWatchHistory({ now, delay: 0 });

    expect(summary.reloaded).toBe(1);
    expect(db.replaceHistoryRange).toHaveBeenCalledWith('1.600519', '2026-11-03', '2026-11-03', [
      { date: '2026-11-03' },
    ]);
  });
});

describe('klineSync · 未收盘清理当天残留', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.loadHistoryTargets.mockResolvedValue([]);
  });

  it('15:15 前先清理当天遗留K线，再读取补齐目标', async () => {
    const order = [];
    db.pruneTodayHistory.mockImplementation(async (date) => {
      order.push(`prune:${date}`);
      return 0;
    });
    db.loadHistoryTargets.mockImplementation(async () => {
      order.push('targets');
      return [];
    });

    await syncWatchHistory({ now: new Date(2026, 10, 3, 10, 0), delay: 0 });

    expect(order).toEqual(['prune:2026-11-03', 'targets']);
  });

  it('15:15 后当天K线已完整，不做清理', async () => {
    await syncWatchHistory({ now: new Date(2026, 10, 3, 15, 30), delay: 0 });

    expect(db.pruneTodayHistory).not.toHaveBeenCalled();
  });
});
