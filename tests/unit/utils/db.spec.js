import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWatchGroup,
  configureDb,
  deleteCalendarEvent,
  getDbSetupState,
  importLegacy,
  loadBoardK,
  loadBoardList,
  loadCalendarEvents,
  loadMarketWidthDb,
  loadQuoteMarketStatus,
  loadQuotes,
  loadSettings,
  loadSymbolConfigs,
  pruneTodayHistory,
  refreshBoardHistory,
  replaceHistoryRange,
  saveCalendarEvent,
  saveMarketWidthDb,
  saveSettings,
  saveStockConcepts,
  saveSymbolConfigs,
  setNonTradingDay,
  syncNonTradingDays,
  testDbConnection,
} from '@/utils/db';

const state = vi.hoisted(() => ({ tauri: false, invoke: vi.fn() }));
vi.mock('@/utils/env', () => ({ isTauri: () => state.tauri }));
vi.mock('../../mocks/tauri-api.js', () => ({ invoke: state.invoke }));

beforeEach(() => {
  state.tauri = false;
  state.invoke.mockReset();
});

describe('buildWatchGroup · 数据库行还原为 watchGroup', () => {
  it('数据库为空时返回空数组，调用方补空自选组', () => {
    expect(buildWatchGroup({})).toEqual([]);
    expect(buildWatchGroup({ stocks: [], notions: [], members: [] })).toEqual([]);
  });

  it('zx 组成自选，非自选股票不进入自选，代码由 secid 拆出', () => {
    const groups = buildWatchGroup({
      stocks: [
        { secid: '1.600036', name: '招商银行', zx: false },
        { secid: '0.000001', name: '平安银行', zx: true },
        { secid: '1.600519', name: '贵州茅台', zx: true },
      ],
      notions: [],
      members: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: '自选', id: 0 });
    expect(groups[0].symbols.map((s) => s.symbol)).toEqual(['000001', '600519']);
    expect(groups[0].symbols[0]).toMatchObject({
      symbol: '000001',
      name: '平安银行',
      secid: '0.000001',
      source: '1',
    });
  });

  it('按 pid 组装一级/二级概念，并按 sort_order 还原成员', () => {
    const groups = buildWatchGroup({
      stocks: [
        { secid: '1.600519', name: '贵州茅台', zx: true },
        { secid: '1.600036', name: '招商银行', zx: false },
        { secid: '0.000001', name: '平安银行', zx: false },
      ],
      notions: [
        { id: 1, name: '白酒', pid: null, sort_order: 0, editable: true },
        { id: 3, name: '银行', pid: null, sort_order: 1, editable: true },
        { id: 2, name: '一线白酒', pid: 1, sort_order: 0, editable: true },
      ],
      members: [
        { notion_id: 1, secid: '1.600519', sort_order: 0 },
        { notion_id: 2, secid: '1.600519', sort_order: 0 },
        { notion_id: 3, secid: '0.000001', sort_order: 1 },
        { notion_id: 3, secid: '1.600036', sort_order: 0 },
      ],
    });

    expect(groups.map((g) => g.name)).toEqual(['自选', '白酒', '银行']);
    expect(groups[1].symbols.map((s) => s.symbol)).toEqual(['600519']);
    expect(groups[1].children.map((c) => c.name)).toEqual(['一线白酒']);
    expect(groups[2].symbols.map((s) => s.symbol)).toEqual(['600036', '000001']);
  });
});

describe('板块成分与板块日K · 命令封装', () => {
  it('浏览器环境不调用 IPC，返回 null', async () => {
    expect(await saveStockConcepts([{ code: '600519', concepts: [] }])).toBeNull();
    expect(await loadBoardK('ths_gn:885761')).toBeNull();
  });

  it('空入参不触发 IPC', async () => {
    state.tauri = true;
    expect(await saveStockConcepts([])).toBeNull();
    expect(await loadBoardK('')).toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it('桌面端写入概念成分时按行序列化', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValue({ updated: 1, relations: 2 });
    const rows = [
      { code: '600519', concepts: [{ code: '885761', name: '白酒' }] },
      null,
    ];
    const result = await saveStockConcepts(rows);
    expect(state.invoke).toHaveBeenCalledWith('db_save_stock_concepts', {
      rows: JSON.stringify([{ code: '600519', concepts: [{ code: '885761', name: '白酒' }] }]),
    });
    expect(result).toEqual({ updated: 1, relations: 2 });
  });

  it('桌面端读取板块日K时透传 boardKey 与默认条数', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValue({ dates: [], close: [], pct: [], amount: [] });
    expect(await loadBoardK('ths_gn:885761')).toEqual({
      dates: [],
      close: [],
      pct: [],
      amount: [],
    });
    expect(state.invoke).toHaveBeenCalledWith('db_load_board_k', {
      boardKey: 'ths_gn:885761',
      limit: 250,
    });
  });
});

describe('板块列表 · 命令封装', () => {
  it('浏览器环境不调用 IPC，返回空数组', async () => {
    expect(await loadBoardList()).toEqual([]);
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it('桌面端读取板块列表时透传 scope 并取出 boards', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValue({ boards: [{ board_key: 'sw1:电子', name: '电子' }] });
    expect(await loadBoardList('sw')).toEqual([{ board_key: 'sw1:电子', name: '电子' }]);
    expect(state.invoke).toHaveBeenCalledWith('db_load_board_list', { scope: 'sw' });

    state.invoke.mockClear();
    await loadBoardList();
    expect(state.invoke).toHaveBeenCalledWith('db_load_board_list', { scope: 'ths' });
  });

  it('读取失败只记录日志并返回空数组', async () => {
    state.tauri = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.invoke.mockRejectedValue(new Error('boom'));
    expect(await loadBoardList('ths')).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith('[db] 读取板块列表失败', expect.any(Error));
    errorSpy.mockRestore();
  });
});

describe('市场宽度 · 命令封装', () => {
  it('浏览器环境不调用 IPC', async () => {
    expect(await loadMarketWidthDb()).toBeNull();
    expect(
      await saveMarketWidthDb({ dates: ['2026-10-28'], rows: [{ code: 'x' }] }),
    ).toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it('空数据不触发 IPC', async () => {
    state.tauri = true;
    expect(await saveMarketWidthDb({ dates: [], rows: [] })).toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it('桌面端默认读取库内全部交易日', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValue({ dates: [], rows: [] });
    expect(await loadMarketWidthDb()).toEqual({ dates: [], rows: [] });
    expect(state.invoke).toHaveBeenCalledWith('db_load_market_width', { days: 0 });
  });

  it('桌面端写入时序列化 dates 与 rows', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValue({ saved: 2 });
    const data = {
      dates: ['2026-10-28'],
      rows: [{ name: '环保', code: '801970.SI', values: [52] }],
    };
    expect(await saveMarketWidthDb(data)).toEqual({ saved: 2 });
    expect(state.invoke).toHaveBeenCalledWith('db_save_market_width', {
      payload: JSON.stringify(data),
    });
  });
});

describe('日历事件 · 命令封装', () => {
  it('浏览器环境不调用 IPC，返回空值', async () => {
    expect(await loadCalendarEvents()).toEqual([]);
    expect(await saveCalendarEvent({ name: '事件' })).toBeNull();
    expect(await deleteCalendarEvent(1)).toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it('桌面端读取、保存与删除都走对应命令', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValue({ events: [{ id: 1, name: '事件' }] });
    expect(await loadCalendarEvents()).toEqual([{ id: 1, name: '事件' }]);
    expect(state.invoke).toHaveBeenCalledWith('db_load_calendar_events');

    state.invoke.mockResolvedValue({ id: 2 });
    const event = {
      name: '事件',
      start_date: '2026-11-05',
      end_date: '2026-11-06',
      repeat_type: 'none',
    };
    expect(await saveCalendarEvent(event)).toBe(2);
    expect(state.invoke).toHaveBeenCalledWith('db_save_calendar_event', {
      payload: JSON.stringify(event),
    });

    state.invoke.mockResolvedValue({ removed: 1 });
    expect(await deleteCalendarEvent(2)).toBe(1);
    expect(state.invoke).toHaveBeenCalledWith('db_delete_calendar_event', { id: 2 });
  });
});

describe('非交易日日历 · 命令封装', () => {
  it('浏览器环境不调用 IPC，返回 null', async () => {
    expect(await syncNonTradingDays('2024-01-01', '2026-11-08')).toBeNull();
    expect(await setNonTradingDay('2026-11-08', true)).toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it('桌面端回填时透传起止日期，缺参不触发 IPC', async () => {
    state.tauri = true;
    expect(await syncNonTradingDays('', '2026-11-08')).toBeNull();
    expect(await syncNonTradingDays('2024-01-01', '')).toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();

    state.invoke.mockResolvedValue({ added: 3, removed: 1 });
    expect(await syncNonTradingDays('2024-01-01', '2026-11-08')).toEqual({
      added: 3,
      removed: 1,
    });
    expect(state.invoke).toHaveBeenCalledWith('db_sync_non_trading_days', {
      start: '2024-01-01',
      end: '2026-11-08',
    });
  });

  it('桌面端标记/清除当天非交易日，source 默认 probe', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValue({ ok: true });
    expect(await setNonTradingDay('2026-11-08', true)).toEqual({ ok: true });
    expect(state.invoke).toHaveBeenCalledWith('db_set_non_trading_day', {
      date: '2026-11-08',
      nonTrading: true,
      source: 'probe',
    });

    state.invoke.mockClear();
    await setNonTradingDay('2026-11-08', false, 'manual');
    expect(state.invoke).toHaveBeenCalledWith('db_set_non_trading_day', {
      date: '2026-11-08',
      nonTrading: false,
      source: 'manual',
    });
  });

  it('日期缺失或命令失败时返回 null，不抛出', async () => {
    state.tauri = true;
    expect(await setNonTradingDay('', true)).toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.invoke.mockRejectedValue(new Error('boom'));
    expect(await syncNonTradingDays('2024-01-01', '2026-11-08')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('[db] 回填非交易日失败', expect.any(Error));
    expect(await setNonTradingDay('2026-11-08', true)).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('[db] 标记非交易日失败', expect.any(Error));
    errorSpy.mockRestore();
  });
});

describe('行情来源判定与库内快照 · 命令封装', () => {
  it('浏览器环境不调用 IPC，返回 null 与空数组', async () => {
    expect(await loadQuoteMarketStatus()).toBeNull();
    expect(await loadQuotes(['1.600519'])).toEqual([]);
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it('桌面端读取时段判定与批量快照', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValue({
      today: '2026-11-09',
      todayTrading: true,
      liveWindow: false,
      latestTradingDay: '2026-11-06',
      syncedDate: '2026-11-06',
      useDb: true,
    });
    expect(await loadQuoteMarketStatus()).toMatchObject({ useDb: true });
    expect(state.invoke).toHaveBeenCalledWith('db_quote_market_status', { secids: [] });

    state.invoke.mockClear().mockResolvedValue({ useDb: true, windowCovered: true });
    await loadQuoteMarketStatus(['1.600519']);
    expect(state.invoke).toHaveBeenCalledWith('db_quote_market_status', {
      secids: ['1.600519'],
    });

    state.invoke.mockClear().mockResolvedValue([{ secid: '1.600519', price: 1500 }]);
    expect(await loadQuotes(['1.600519'])).toEqual([{ secid: '1.600519', price: 1500 }]);
    expect(state.invoke).toHaveBeenCalledWith('db_load_quotes', {
      secids: ['1.600519'],
    });
  });

  it('空 secids 不触发 IPC；命令失败只记录日志并返回空值', async () => {
    state.tauri = true;
    expect(await loadQuotes([])).toEqual([]);
    expect(state.invoke).not.toHaveBeenCalled();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.invoke.mockRejectedValue(new Error('boom'));
    expect(await loadQuoteMarketStatus()).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('[db] 读取行情时段失败', expect.any(Error));
    expect(await loadQuotes(['1.600519'])).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith('[db] 读取行情快照失败', expect.any(Error));
    errorSpy.mockRestore();
  });
});

describe('数据库初始化向导 · 命令封装', () => {
  it('浏览器环境视为已配置，不发 IPC', async () => {
    const setup = await getDbSetupState();
    expect(setup.configured).toBe(true);
    expect(await testDbConnection({})).toMatchObject({ ok: true });
    expect(await configureDb({})).toMatchObject({ ok: true });
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it('桌面端读取配置、测试连接与保存配置均透传 payload', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValue({ configured: false, saved: false });
    expect(await getDbSetupState()).toEqual({ configured: false, saved: false });
    expect(state.invoke).toHaveBeenCalledWith('db_setup_state');

    const config = { type: 'mysql', mysql: { host: '10.0.0.2', port: 3306 } };
    state.invoke.mockResolvedValue({ ok: true, message: '连接成功' });
    expect(await testDbConnection(config)).toEqual({ ok: true, message: '连接成功' });
    expect(state.invoke).toHaveBeenCalledWith('db_test_connection', {
      payload: JSON.stringify(config),
    });

    state.invoke.mockClear();
    state.invoke.mockResolvedValue({ ok: true, message: '已保存' });
    expect(await configureDb(config)).toEqual({ ok: true, message: '已保存' });
    expect(state.invoke).toHaveBeenCalledWith('db_configure', {
      payload: JSON.stringify(config),
    });
  });
});

describe('板块历史刷新 · 命令封装', () => {
  it('浏览器环境不调用 IPC，返回 null', async () => {
    expect(await refreshBoardHistory()).toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it('桌面端默认刷新最近 5 个交易日，可显式指定天数', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValue({ days: 5, rebuilt: 1 });
    expect(await refreshBoardHistory()).toEqual({ days: 5, rebuilt: 1 });
    expect(state.invoke).toHaveBeenCalledWith('db_refresh_board_history', { days: 5 });

    state.invoke.mockClear();
    await refreshBoardHistory(10);
    expect(state.invoke).toHaveBeenCalledWith('db_refresh_board_history', { days: 10 });
  });

  it('刷新失败只记录日志并返回 null', async () => {
    state.tauri = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.invoke.mockRejectedValue(new Error('boom'));
    expect(await refreshBoardHistory()).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('[db] 刷新板块历史失败', expect.any(Error));
    errorSpy.mockRestore();
  });
});

describe('replaceHistoryRange · 区间替换K线', () => {
  const candles = [{ date: '2026-11-03', open: 10, close: 10.5 }];

  it('浏览器环境直接返回 null，不调用命令', async () => {
    expect(await replaceHistoryRange('1.600519', '2026-11-01', '2026-11-03', candles)).toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it('桌面端按区间删除后写入，参数透传', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValue({ removed: 2, saved: 1 });
    expect(await replaceHistoryRange('1.600519', '2026-11-01', '2026-11-03', candles)).toEqual({
      removed: 2,
      saved: 1,
    });
    expect(state.invoke).toHaveBeenCalledWith('db_replace_history_range', {
      secid: '1.600519',
      beg: '2026-11-01',
      end: '2026-11-03',
      candles: JSON.stringify(candles),
    });
  });

  it('参数缺失时不调用命令', async () => {
    state.tauri = true;
    expect(await replaceHistoryRange('', '2026-11-01', '2026-11-03', candles)).toBeNull();
    expect(await replaceHistoryRange('1.600519', '', '2026-11-03', candles)).toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();
  });
});

describe('pruneTodayHistory · 清理当天残留K线', () => {
  it('浏览器环境直接返回 null，不调用命令', async () => {
    expect(await pruneTodayHistory('2026-11-03')).toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it('桌面端返回删除行数', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValue({ removed: 3 });
    expect(await pruneTodayHistory('2026-11-03')).toBe(3);
    expect(state.invoke).toHaveBeenCalledWith('db_prune_today_history', { date: '2026-11-03' });
  });

  it('日期缺失或命令失败时返回 null', async () => {
    state.tauri = true;
    expect(await pruneTodayHistory('')).toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.invoke.mockRejectedValue(new Error('boom'));
    expect(await pruneTodayHistory('2026-11-03')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('[db] 清理当天K线失败', expect.any(Error));
    errorSpy.mockRestore();
  });
});

describe('设置与持仓配置 · 数据库命令封装', () => {
  it('浏览器环境返回空值且不发 IPC', async () => {
    expect(await loadSettings()).toBeNull();
    expect(await saveSettings({})).toBeNull();
    expect(await loadSymbolConfigs()).toEqual({});
    expect(await saveSymbolConfigs({})).toBeNull();
    expect(await importLegacy({})).toBeNull();
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it('桌面端读取设置与持仓配置', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValueOnce({ settings: { tableSize: 'small' } });
    expect(await loadSettings()).toEqual({ tableSize: 'small' });
    expect(state.invoke).toHaveBeenCalledWith('db_load_settings');

    state.invoke.mockReset().mockResolvedValueOnce({
      configs: { '1.600519': { secid: '1.600519' } },
    });
    expect(await loadSymbolConfigs()).toEqual({ '1.600519': { secid: '1.600519' } });
    expect(state.invoke).toHaveBeenCalledWith('db_load_symbol_configs');
  });

  it('桌面端保存设置与持仓配置透传 payload', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValueOnce({ saved: true });
    expect(await saveSettings({ tableSize: 'small' })).toEqual({ saved: true });
    expect(state.invoke).toHaveBeenCalledWith('db_save_settings', {
      payload: JSON.stringify({ tableSize: 'small' }),
    });

    state.invoke.mockReset().mockResolvedValueOnce({ saved: true });
    const configs = { '1.600519': { secid: '1.600519' } };
    expect(await saveSymbolConfigs(configs)).toEqual({ saved: true });
    expect(state.invoke).toHaveBeenCalledWith('db_save_symbol_configs', {
      payload: JSON.stringify(configs),
    });
  });

  it('旧版数据导入按约定结构透传', async () => {
    state.tauri = true;
    state.invoke.mockResolvedValueOnce({ imported: true });
    const payload = {
      settings: { tableSize: 'small' },
      symbolConfigs: { '1.600519': { secid: '1.600519' } },
      groups: [{ id: 0, name: '自选', symbols: [] }],
    };
    expect(await importLegacy(payload)).toEqual({ imported: true });
    expect(state.invoke).toHaveBeenCalledWith('db_import_legacy', {
      payload: JSON.stringify({
        settings: payload.settings,
        symbol_configs: payload.symbolConfigs,
        groups: payload.groups,
      }),
    });
  });

  it('读写失败时返回空值或 null，不抛出', async () => {
    state.tauri = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.invoke.mockRejectedValue(new Error('boom'));
    expect(await loadSettings()).toBeNull();
    expect(await saveSettings({})).toBeNull();
    expect(await loadSymbolConfigs()).toEqual({});
    expect(await saveSymbolConfigs({})).toBeNull();
    expect(await importLegacy({})).toBeNull();
    errorSpy.mockRestore();
  });
});

