import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchQuotes,
  idleDelayMs,
  isLiveQuoteWindow,
  loadQuoteEnvironment,
  loadQuoteRows,
  resetQuoteEnvironmentCache,
} from '@/utils/quoteSource';

const state = vi.hoisted(() => ({
  tauri: false,
  status: vi.fn(),
  quotes: vi.fn(),
}));

vi.mock('@/utils/env', () => ({ isTauri: () => state.tauri }));
vi.mock('@/utils/db', () => ({
  loadQuoteMarketStatus: (...args) => state.status(...args),
  loadQuotes: (...args) => state.quotes(...args),
}));

beforeEach(() => {
  state.tauri = false;
  state.status.mockReset();
  state.quotes.mockReset();
  resetQuoteEnvironmentCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isLiveQuoteWindow · 盘中窗口 9:15–15:15', () => {
  it('窗口两侧边界包含端点', () => {
    expect(isLiveQuoteWindow(new Date(2026, 10, 9, 9, 14))).toBe(false);
    expect(isLiveQuoteWindow(new Date(2026, 10, 9, 9, 15))).toBe(true);
    expect(isLiveQuoteWindow(new Date(2026, 10, 9, 15, 15))).toBe(true);
    expect(isLiveQuoteWindow(new Date(2026, 10, 9, 15, 16))).toBe(false);
  });
});

describe('idleDelayMs · 空闲态唤醒间隔', () => {
  it('白天与盘后最多 60 秒检查一次库是否落后', () => {
    expect(idleDelayMs(new Date(2026, 10, 9, 8, 0))).toBe(60000);
    expect(idleDelayMs(new Date(2026, 10, 9, 14, 30))).toBe(60000);
  });

  it('临近 9:15 时按剩余时间唤醒，并保留 1 秒下限', () => {
    expect(idleDelayMs(new Date(2026, 10, 9, 9, 14, 30))).toBe(30000);
    expect(idleDelayMs(new Date(2026, 10, 9, 9, 14, 59, 500))).toBe(1000);
  });
});

describe('loadQuoteEnvironment · 接口 / 读库判定', () => {
  it('浏览器调试保持原 4 秒接口轮询，不读时段状态', async () => {
    const env = await loadQuoteEnvironment([], new Date(2026, 10, 9, 8, 0));
    expect(env).toEqual({ live: true, todayTrading: true, useDb: false });
    expect(state.status).not.toHaveBeenCalled();
  });

  it('桌面端盘中即使库已覆盖上一交易日也走接口', async () => {
    state.tauri = true;
    state.status.mockResolvedValue({ todayTrading: true, useDb: false });
    const env = await loadQuoteEnvironment(['1.600519'], new Date(2026, 10, 9, 10, 0));
    expect(env).toEqual({ live: true, todayTrading: true, useDb: false });
    expect(state.status).toHaveBeenCalledTimes(1);
    expect(state.status).toHaveBeenCalledWith(['1.600519']);
  });

  it('桌面端非盘中且库已覆盖交易日时读库', async () => {
    state.tauri = true;
    state.status.mockResolvedValue({ todayTrading: true, useDb: true });
    const env = await loadQuoteEnvironment([], new Date(2026, 10, 9, 8, 0));
    expect(env).toEqual({ live: false, todayTrading: true, useDb: true });
  });

  it('窗口标的去重后传给后端，库未覆盖则继续走接口', async () => {
    state.tauri = true;
    state.status.mockResolvedValue({ todayTrading: true, useDb: false });
    const env = await loadQuoteEnvironment(
      ['1.600519', '0.000858', '1.600519'],
      new Date(2026, 10, 9, 8, 0),
    );
    expect(state.status).toHaveBeenCalledWith(['1.600519', '0.000858']);
    expect(env.useDb).toBe(false);
  });

  it('时段判定缓存 60 秒，超出后重新读取', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 8, 0, 0));
    state.tauri = true;
    state.status.mockResolvedValue({ todayTrading: true, useDb: true });
    await loadQuoteEnvironment(['1.600519']);
    await loadQuoteEnvironment(['1.600519']);
    expect(state.status).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(2026, 10, 9, 8, 1, 1));
    await loadQuoteEnvironment(['1.600519']);
    expect(state.status).toHaveBeenCalledTimes(2);
  });

  it('不同窗口的标的集合各自缓存，互不覆盖', async () => {
    state.tauri = true;
    state.status.mockResolvedValue({ todayTrading: true, useDb: true });
    await loadQuoteEnvironment(['1.600519']);
    await loadQuoteEnvironment(['0.000858']);
    expect(state.status).toHaveBeenCalledTimes(2);
    expect(state.status).toHaveBeenNthCalledWith(1, ['1.600519']);
    expect(state.status).toHaveBeenNthCalledWith(2, ['0.000858']);
  });

  it('进入盘中窗口立即重新判定，不等缓存过期', async () => {
    state.tauri = true;
    state.status.mockResolvedValue({ todayTrading: true, useDb: true });
    await loadQuoteEnvironment([], new Date(2026, 10, 9, 9, 10));
    expect(state.status).toHaveBeenCalledTimes(1);

    state.status.mockResolvedValue({ todayTrading: true, useDb: false });
    const env = await loadQuoteEnvironment([], new Date(2026, 10, 9, 9, 16));
    expect(env).toEqual({ live: true, todayTrading: true, useDb: false });
    expect(state.status).toHaveBeenCalledTimes(2);
  });

  it('读不到库状态时退回接口，避免把旧库数据当最新行情', async () => {
    state.tauri = true;
    state.status.mockResolvedValue(null);
    const env = await loadQuoteEnvironment([], new Date(2026, 10, 9, 8, 0));
    expect(env).toEqual({ live: false, todayTrading: true, useDb: false });
  });
});

describe('loadQuoteRows · 库内行情补齐空持仓字段', () => {
  it('透传 secids 并补齐实时行情同款占位字段', async () => {
    state.quotes.mockResolvedValue([
      {
        secid: '1.600519',
        name: '贵州茅台',
        price: 1500,
        range: 1.5,
        price_diff: 22,
        turn: 0.3,
        high: 1510,
        low: 1480,
        open: 1490,
        pre_close: 1478,
        amount: 12.5,
        time: 1762000000,
      },
    ]);
    const rows = await loadQuoteRows(['1.600519']);
    expect(state.quotes).toHaveBeenCalledWith(['1.600519']);
    expect(rows).toEqual([
      {
        position_num: '-',
        position_price: '-',
        position_value: '-',
        position_profit: '-',
        position_profit_rate: '-',
        secid: '1.600519',
        name: '贵州茅台',
        price: 1500,
        range: 1.5,
        price_diff: 22,
        turn: 0.3,
        high: 1510,
        low: 1480,
        open: 1490,
        pre_close: 1478,
        amount: 12.5,
        time: 1762000000,
      },
    ]);
  });

  it('库内无数据时返回空数组', async () => {
    state.quotes.mockResolvedValue(null);
    expect(await loadQuoteRows(['1.600519'])).toEqual([]);
  });
});

describe('fetchQuotes · 读库失败必须回退接口', () => {
  const symbols = [{ secid: '1.600519' }, { secid: '0.000858' }];
  const api = () => ({ realtime: vi.fn().mockResolvedValue([{ secid: '1.600519', range: 1 }]) });
  const quiet = new Date(2026, 10, 9, 8, 0);

  it('非盘中且库已覆盖时直接读库，不请求接口', async () => {
    state.tauri = true;
    state.status.mockResolvedValue({ todayTrading: true, useDb: true });
    state.quotes.mockResolvedValue([{ secid: '1.600519', range: 1.5, turn: 2 }]);
    const client = api();
    const result = await fetchQuotes(client, symbols, quiet);
    expect(client.realtime).not.toHaveBeenCalled();
    expect(result.source).toBe('db');
    expect(result.delay).toBe(idleDelayMs(quiet));
    expect(result.quotes[0].position_num).toBe('-');
  });

  it('时段状态查询失败时回退接口，不让整表行情变空', async () => {
    state.tauri = true;
    state.status.mockRejectedValue(new Error('disk I/O error'));
    const client = api();
    const result = await fetchQuotes(client, symbols, quiet);
    expect(client.realtime).toHaveBeenCalledWith(symbols);
    expect(result.source).toBe('api');
    expect(result.quotes).toHaveLength(1);
    expect(result.delay).toBe(60000);
  });

  it('读库失败时回退接口', async () => {
    state.tauri = true;
    state.status.mockResolvedValue({ todayTrading: true, useDb: true });
    state.quotes.mockRejectedValue(new Error('disk I/O error'));
    const client = api();
    const result = await fetchQuotes(client, symbols, quiet);
    expect(client.realtime).toHaveBeenCalledWith(symbols);
    expect(result.source).toBe('api');
  });

  it('库内没有这些标的时不能当成已覆盖，回退接口补一次', async () => {
    state.tauri = true;
    state.status.mockResolvedValue({ todayTrading: true, useDb: true });
    state.quotes.mockResolvedValue([]);
    const client = api();
    const result = await fetchQuotes(client, symbols, quiet);
    expect(client.realtime).toHaveBeenCalledWith(symbols);
    expect(result.source).toBe('api');
  });

  it('接口空结果时缩短重试间隔（非盘中 20 秒，盘中保持 4 秒）', async () => {
    const client = { realtime: vi.fn().mockResolvedValue([]) };
    const idle = await fetchQuotes(client, symbols, quiet);
    expect(idle.delay).toBe(20000);

    const intraday = await fetchQuotes(client, symbols, new Date(2026, 10, 9, 10, 0));
    expect(intraday.delay).toBe(4000);
  });
});
