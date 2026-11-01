import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWatchGroup,
  loadBoardK,
  loadBoardList,
  loadMarketWidthDb,
  refreshBoardHistory,
  saveMarketWidthDb,
  saveStockConcepts,
} from '@/utils/db';

const state = vi.hoisted(() => ({ tauri: false, invoke: vi.fn() }));
vi.mock('@/utils/env', () => ({ isTauri: () => state.tauri }));
vi.mock('../../mocks/tauri-api.js', () => ({ invoke: state.invoke }));

beforeEach(() => {
  state.tauri = false;
  state.invoke.mockReset();
});

describe('buildWatchGroup · 数据库行还原为 watchGroup', () => {
  it('数据库为空时返回空数组，调用方保留原数据', () => {
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
