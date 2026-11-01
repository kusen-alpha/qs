import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMonitorStore } from '@/stores/monitor';
import { freshPinia, stock } from '../../helpers';

vi.mock('@/utils/file', () => ({
  writeData: vi.fn(),
  readData: vi.fn(async () => null),
  Files: {
    SETTINGS: { folder: '', file: 'settings.json', encrpt: false },
    MONITOR: { folder: '', file: 'monitor.dat', encrpt: true },
    SYMBOL: { folder: '', file: 'symbol.dat', encrpt: true },
  },
}));

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
    monitor.$persist = () => {};
  });

  it('默认只有一个「自选」分组（不可重命名/删除）', () => {
    expect(monitor.watchGroup).toHaveLength(1);
    expect(monitor.watchGroup[0]).toMatchObject({
      name: '自选',
      id: 0,
    });
    expect(monitor.watchGroup[0].symbols.map((s) => s.symbol)).toEqual(['600519']);
  });

  it('addWatchList 把股票加入自选，重复加入会去重', () => {
    const item = { Code: '000001', Name: '平安银行', QuoteID: '0.000001' };
    monitor.addWatchList(item);
    monitor.addWatchList(item);
    expect(monitor.watchGroup[0].symbols.map((s) => s.symbol)).toEqual(['600519', '000001']);
    expect(monitor.watchGroup[0].symbols[1]).toMatchObject({
      name: '平安银行',
      secid: '0.000001',
      source: '1',
    });
  });

  it('deleteWatchList 按 secid 删除', () => {
    monitor.deleteWatchList('1.600519');
    expect(monitor.watchGroup[0].symbols).toEqual([]);
  });

  it('existSymbolInGroup 判断是否已存在', () => {
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
