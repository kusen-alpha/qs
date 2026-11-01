import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMacdStore } from '@/stores/macd';
import { macdHistogram } from '@/utils/macd';
import { freshPinia } from '../../helpers';

const mocks = vi.hoisted(() => ({
  fetchKline: vi.fn(),
}));

vi.mock('@/utils/kline', () => ({ fetchKline: mocks.fetchKline }));

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function candles(closes = []) {
  return closes.map((close, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, close }));
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('macd store · 按日缓存 MACD 柱序列', () => {
  let store;

  beforeEach(() => {
    vi.useFakeTimers();
    freshPinia();
    store = useMacdStore();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('ensure(null / 空数组 / 全是空值) 不发请求', async () => {
    await store.ensure(null);
    await store.ensure([]);
    await store.ensure(['', null, undefined]);
    expect(mocks.fetchKline).not.toHaveBeenCalled();
  });

  it('去重后请求，成功时写入 series 与当天 stamp', async () => {
    const data = candles([...Array(30).fill(10), ...Array(6).fill(20)]);
    mocks.fetchKline.mockResolvedValue({ candles: data });

    await store.ensure(['1.600519', '1.600519', '0.000001']);
    expect(mocks.fetchKline).toHaveBeenCalledTimes(2);

    const expected = macdHistogram(data);
    expect(store.series['1.600519']).toHaveLength(data.length);
    expect(store.series['1.600519'].at(-1).value).toBeGreaterThan(0);
    expect(store.series['1.600519'].at(-1).date).toBe(expected.at(-1).date);
    expect(store.stamps['1.600519']).toBe(today());
    expect(store.stamps['0.000001']).toBe(today());
  });

  it('同一天已成功的股票跳过，stamp 过期则重新拉取', async () => {
    mocks.fetchKline.mockResolvedValue({ candles: candles([1, 2, 3, 4]) });

    store.stamps['1.600519'] = today();
    await store.ensure(['1.600519']);
    expect(mocks.fetchKline).not.toHaveBeenCalled();

    store.stamps['1.600519'] = '2000-1-1';
    await store.ensure(['1.600519']);
    expect(mocks.fetchKline).toHaveBeenCalledTimes(1);
    expect(store.stamps['1.600519']).toBe(today());
  });

  it('空K线不写 stamp，series 置空数组，并在 60 秒后自动重试', async () => {
    mocks.fetchKline.mockResolvedValue({ candles: [] });

    await store.ensure(['1.600519', '0.000001']);
    expect(store.series['1.600519']).toEqual([]);
    expect(store.series['0.000001']).toEqual([]);
    expect(store.stamps).toEqual({});

    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.fetchKline).toHaveBeenCalledTimes(4);
    expect(mocks.fetchKline).toHaveBeenLastCalledWith('0.000001', expect.any(Number));
  });

  it('单只股票抛错不影响同批其它股票，失败项 60 秒后自动重试', async () => {
    mocks.fetchKline.mockImplementation(async (secid) => {
      if (secid === '1.600519') throw new Error('network down');
      return { candles: candles([1, 2, 3, 4]) };
    });

    await expect(store.ensure(['1.600519', '0.000001'])).resolves.toBeUndefined();
    expect(store.series['0.000001']).toHaveLength(4);
    expect(store.stamps['0.000001']).toBe(today());
    expect(store.series['1.600519']).toBeUndefined();
    expect(store.stamps['1.600519']).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.fetchKline).toHaveBeenCalledTimes(3);
    expect(mocks.fetchKline).toHaveBeenLastCalledWith('1.600519', expect.any(Number));
  });

  it('按每批 4 只串行请求，前一批完成后再发起下一批', async () => {
    const started = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    mocks.fetchKline.mockImplementation(async (secid) => {
      started.push(secid);
      await gate;
      return { candles: candles([1, 2, 3]) };
    });

    const pending = store.ensure(['a', 'b', 'c', 'd', 'e']);
    try {
      expect(started).toEqual(['a', 'b', 'c', 'd']);
    } finally {
      release();
      await pending;
    }
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('请求 beg 参数为 8 位数字的近似 400 天前日期', async () => {
    mocks.fetchKline.mockResolvedValue({ candles: candles([1, 2, 3]) });
    await store.ensure(['1.600519']);

    const beg = mocks.fetchKline.mock.calls[0][1];
    expect(Number.isInteger(beg)).toBe(true);
    expect(String(beg)).toHaveLength(8);
    const expected = new Date();
    expected.setDate(expected.getDate() - 400);
    const expectedBeg = Number(
      `${expected.getFullYear()}${String(expected.getMonth() + 1).padStart(2, '0')}${String(
        expected.getDate(),
      ).padStart(2, '0')}`,
    );
    expect(Math.abs(beg - expectedBeg)).toBeLessThanOrEqual(1);
  });

  it('全部失败时 60 秒后的重试会对同一批股票再次请求', async () => {
    mocks.fetchKline.mockResolvedValue({ candles: [] });
    await store.ensure(['a', 'b', 'c', 'd', 'e']);
    expect(mocks.fetchKline).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(60000);
    await tick();
    expect(mocks.fetchKline).toHaveBeenCalledTimes(10);
    expect(new Set(mocks.fetchKline.mock.calls.slice(5).map(([secid]) => secid))).toEqual(
      new Set(['a', 'b', 'c', 'd', 'e']),
    );
  });
});
