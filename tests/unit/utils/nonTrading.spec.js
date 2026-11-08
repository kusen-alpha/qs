import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tauri: true,
  label: 'main',
  on: vi.fn(),
  sync: vi.fn(),
  setNonTradingDay: vi.fn(),
  getCurrentWindow: vi.fn(),
}));

vi.mock('@/utils/env', () => ({ isTauri: () => mocks.tauri }));
vi.mock('@/utils/db', () => ({
  syncNonTradingDays: mocks.sync,
  setNonTradingDay: mocks.setNonTradingDay,
}));
vi.mock('@/utils/events', () => ({ emit: vi.fn(), on: mocks.on }));
vi.mock('../../mocks/tauri-api.js', () => ({ getCurrentWindow: mocks.getCurrentWindow }));

import { formatDate } from '@/utils/calendar';
import {
  BACKFILL_START,
  PROBE_MISS_LIMIT,
  createTradingDayProbe,
  hasTodayDeal,
  isProbeWindow,
  startNonTradingCalendar,
} from '@/utils/nonTrading';

/** 本地时间构造，避免 UTC 时区导致日期错位 */
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0);
const TODAY = at(9, 10, 0);
const TODAY_DATE = formatDate(TODAY);
const YESTERDAY_SEC = Math.floor(at(8, 10, 0).getTime() / 1000);
const TODAY_SEC = Math.floor(TODAY.getTime() / 1000);

beforeEach(() => {
  mocks.tauri = true;
  mocks.label = 'main';
  mocks.getCurrentWindow.mockImplementation(() => ({ label: mocks.label }));
  mocks.on.mockResolvedValue(() => {});
  mocks.sync.mockResolvedValue({ added: 0, removed: 0 });
  mocks.setNonTradingDay.mockResolvedValue({ ok: true });
});

describe('非交易日探测 · 时间窗与成交时间判断', () => {
  it('只有 9:30–15:15 之间才探测', () => {
    expect(isProbeWindow(at(9, 9, 29))).toBe(false);
    expect(isProbeWindow(at(9, 9, 30))).toBe(true);
    expect(isProbeWindow(at(9, 15, 15))).toBe(true);
    expect(isProbeWindow(at(9, 15, 16))).toBe(false);
  });

  it('交易所成交时间落在当天才算当天有成交', () => {
    expect(hasTodayDeal({ time: TODAY_SEC }, TODAY)).toBe(true);
    expect(hasTodayDeal({ time: YESTERDAY_SEC }, TODAY)).toBe(false);
    expect(hasTodayDeal({ time: String(TODAY_SEC) }, TODAY)).toBe(true);
    expect(hasTodayDeal({}, TODAY)).toBe(false);
    expect(hasTodayDeal({ time: 0 }, TODAY)).toBe(false);
    expect(hasTodayDeal(null, TODAY)).toBe(false);
  });
});

describe('非交易日探测 · 状态机', () => {
  function setup({ quotes = [], save = () => Promise.resolve({ ok: true }) } = {}) {
    const fetchQuotes = vi.fn().mockResolvedValue(quotes);
    let current = TODAY;
    const saveNonTrading = vi.fn().mockImplementation(save);
    const probe = createTradingDayProbe({
      fetchQuotes,
      saveNonTrading,
      now: () => current,
      logger: { info: () => {} },
    });
    return {
      probe,
      fetchQuotes,
      saveNonTrading,
      setNow: (value) => {
        current = value;
      },
    };
  }

  it('时间窗外不发请求', async () => {
    const { probe, fetchQuotes } = setup({ quotes: [{ time: YESTERDAY_SEC }] });
    const before = createTradingDayProbe({
      fetchQuotes,
      now: () => at(9, 9, 0),
      saveNonTrading: vi.fn(),
      logger: { info: () => {} },
    });
    expect(await before.tick()).toBe('outside');
    expect(fetchQuotes).not.toHaveBeenCalled();
    expect(await probe.tick()).toBe('miss');
  });

  it('网络异常或空结果不计入 miss，恢复后照常判定', async () => {
    const fetchQuotes = vi.fn();
    const saveNonTrading = vi.fn().mockResolvedValue({ ok: true });
    const probe = createTradingDayProbe({
      fetchQuotes,
      saveNonTrading,
      now: () => TODAY,
      logger: { info: () => {}, error: () => {} },
    });

    fetchQuotes.mockRejectedValueOnce(new Error('net'));
    expect(await probe.tick()).toBe('error');
    expect(probe.state().misses).toBe(0);

    fetchQuotes.mockResolvedValueOnce([]);
    expect(await probe.tick()).toBe('error');
    expect(probe.state().misses).toBe(0);

    fetchQuotes.mockResolvedValue([{ time: TODAY_SEC }]);
    expect(await probe.tick()).toBe('trading');
    expect(probe.state().misses).toBe(0);
    expect(saveNonTrading).toHaveBeenCalledWith(TODAY_DATE, false);
  });

  it('连续 3 次无当天成交才写入非交易日，确认后当天不再请求', async () => {
    const { probe, fetchQuotes, saveNonTrading } = setup({
      quotes: [{ time: YESTERDAY_SEC }, { time: YESTERDAY_SEC }],
    });
    for (let i = 1; i < PROBE_MISS_LIMIT; i += 1) {
      expect(await probe.tick()).toBe('miss');
    }
    expect(await probe.tick()).toBe('non-trading');
    expect(saveNonTrading).toHaveBeenCalledWith(TODAY_DATE, true);
    expect(probe.state().settled).toBe(true);

    expect(await probe.tick()).toBe('settled');
    expect(fetchQuotes).toHaveBeenCalledTimes(PROBE_MISS_LIMIT);
  });

  it('检测到当天成交时删除误记并当天停止探测', async () => {
    const { probe, fetchQuotes, saveNonTrading } = setup({
      quotes: [{ time: TODAY_SEC }],
    });
    expect(await probe.tick()).toBe('trading');
    expect(saveNonTrading).toHaveBeenCalledWith(TODAY_DATE, false);
    expect(saveNonTrading).not.toHaveBeenCalledWith(TODAY_DATE, true);
    expect(await probe.tick()).toBe('settled');
    expect(fetchQuotes).toHaveBeenCalledTimes(1);
  });

  it('写库失败不结束探测，下一轮可重试', async () => {
    const saveNonTrading = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ok: true });
    const probe = createTradingDayProbe({
      fetchQuotes: vi.fn().mockResolvedValue([{ time: TODAY_SEC }]),
      saveNonTrading,
      now: () => TODAY,
      logger: { info: () => {} },
    });
    expect(await probe.tick()).toBe('error');
    expect(probe.state().settled).toBe(false);
    expect(await probe.tick()).toBe('trading');
    expect(probe.state().settled).toBe(true);
  });

  it('跨天后重置当天状态重新探测', async () => {
    const { probe, fetchQuotes, setNow } = setup({ quotes: [{ time: TODAY_SEC }] });
    expect(await probe.tick()).toBe('trading');
    // 次日同一批行情（成交时间仍是 11-09）不再算当天成交，重新开始累计 miss
    setNow(at(10, 10, 0));
    expect(await probe.tick()).toBe('miss');
    expect(fetchQuotes).toHaveBeenCalledTimes(2);
  });
});

describe('非交易日任务 · 主窗口启动', () => {
  it('非主窗口或非 Tauri 环境直接返回，不回填也不监听', async () => {
    mocks.label = 'group';
    await startNonTradingCalendar();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.on).not.toHaveBeenCalled();

    mocks.label = 'main';
    mocks.tauri = false;
    await startNonTradingCalendar();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.on).not.toHaveBeenCalled();
  });

  it('主窗口后台回填历史非交易日并监听探测事件', async () => {
    await startNonTradingCalendar();
    expect(mocks.sync).toHaveBeenCalledWith(BACKFILL_START, formatDate(new Date()));
    expect(mocks.on).toHaveBeenCalledWith('trading-day-probe', expect.any(Function));
  });

  it('回填失败只记录日志，仍然注册探测监听', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.sync.mockRejectedValue(new Error('boom'));
    await startNonTradingCalendar();
    expect(errorSpy).toHaveBeenCalledWith('[probe] 非交易日回填失败', expect.any(Error));
    expect(mocks.on).toHaveBeenCalledWith('trading-day-probe', expect.any(Function));
    errorSpy.mockRestore();
  });
});
