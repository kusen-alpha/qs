import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMonitorStore } from '@/stores/monitor';
import { freshPinia, stock } from '../../helpers';

vi.mock('@/utils/events', () => ({ emit: vi.fn(), on: vi.fn() }));

vi.mock('@/utils/db', () => ({
  saveWatchGroup: vi.fn(),
  loadWatchlist: vi.fn(async () => ({ stocks: [], notions: [], members: [] })),
  buildWatchGroup: vi.fn(() => []),
}));

describe('monitor store · 自选列表', () => {
  let monitor;

  beforeEach(() => {
    freshPinia();
    monitor = useMonitorStore();
  });

  it('默认只有一个空的「自选」分组（不带任何预置股票）', () => {
    expect(monitor.watchGroup).toHaveLength(1);
    expect(monitor.watchGroup[0]).toMatchObject({
      name: '自选',
      id: 0,
      symbols: [],
    });
  });

  it('loadFromDb 空库时清空为空自选组', async () => {
    monitor.watchGroup[0].symbols.push(stock('600519', '贵州茅台'));
    await monitor.loadFromDb();
    expect(monitor.watchGroup).toEqual([{ name: '自选', id: 0, symbols: [] }]);
  });

  it('addWatchList 把股票加入自选，重复加入会去重', () => {
    const item = { Code: '000001', Name: '平安银行', QuoteID: '0.000001' };
    monitor.addWatchList(item);
    monitor.addWatchList(item);
    expect(monitor.watchGroup[0].symbols.map((s) => s.symbol)).toEqual(['000001']);
    expect(monitor.watchGroup[0].symbols[0]).toMatchObject({
      name: '平安银行',
      secid: '0.000001',
      source: '1',
    });
  });

  it('deleteWatchList 按 secid 删除', () => {
    monitor.watchGroup[0].symbols.push(stock('600519', '贵州茅台'));
    monitor.deleteWatchList('1.600519');
    expect(monitor.watchGroup[0].symbols).toEqual([]);
  });

  it('deleteWatchList 同时从所有概念（含二级）移除同一只股票', () => {
    monitor.watchGroup = [
      {
        name: '自选',
        id: 0,
        symbols: [stock('600519', '贵州茅台'), stock('000001', '平安银行', '0.000001')],
      },
      {
        name: '行业',
        id: 1,
        symbols: [stock('600519', '贵州茅台')],
        children: [{ id: 2, name: '白酒', symbols: [stock('600519', '贵州茅台')] }],
      },
    ];
    monitor.deleteWatchList('1.600519');
    expect(monitor.watchGroup[0].symbols.map((s) => s.symbol)).toEqual(['000001']);
    expect(monitor.watchGroup[1].symbols).toEqual([]);
    expect(monitor.watchGroup[1].children[0].symbols).toEqual([]);
  });

  it('existSymbolInGroup 判断是否已存在', () => {
    monitor.watchGroup[0].symbols.push(stock('600519', '贵州茅台'));
    expect(monitor.existSymbolInGroup('1.600519')).toBe(true);
    expect(monitor.existSymbolInGroup('1.000001')).toBe(false);
  });

  it('persist 会把完整快照写入数据库并广播事件', async () => {
    const { saveWatchGroup } = await import('@/utils/db');
    const { emit } = await import('@/utils/events');
    await monitor.persist('addWatchList');
    expect(saveWatchGroup).toHaveBeenCalledTimes(1);
    expect(saveWatchGroup.mock.calls[0][0][0]).toMatchObject({ name: '自选', id: 0 });
    expect(emit).toHaveBeenCalledWith('stateChange', 'addWatchList');
  });
});
