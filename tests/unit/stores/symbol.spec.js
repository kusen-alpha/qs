import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSymbolStore } from '@/stores/symbol';
import { freshPinia } from '../../helpers';

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

describe('symbol store · 持仓与提醒配置', () => {
  let store;

  beforeEach(() => {
    freshPinia();
    store = useSymbolStore();
    store.$persist = () => {};
  });

  it('初始为空', () => {
    expect(store.configs).toEqual({});
    expect(store.positionNum()).toBe(0);
    expect(store.alertNum()).toBe(0);
  });

  it('addConfig 保存有效配置并发出变更事件', async () => {
    const { emit } = await import('@/utils/events');
    await store.addConfig({ secid: '1.600519', position: { buyPrice: 100, buyAmount: 10 } });
    expect(store.showPosition('1.600519')).toBe(true);
    expect(store.showAlert('1.600519')).toBe(false);
    expect(store.positionNum()).toBe(1);
    expect(emit).toHaveBeenCalledWith('symbolConfigChange', {});
  });

  it('addConfig 内容相同则跳过', async () => {
    const { writeData } = await import('@/utils/file');
    const config = { secid: '1.600519', crossAlertConfig: { price: 10 } };
    await store.addConfig(config);
    writeData.mockClear();
    await store.addConfig({ ...config });
    expect(writeData).not.toHaveBeenCalled();
    expect(store.alertNum()).toBe(1);
  });

  it('addConfig 传空配置（无持仓/提醒）会删除已有配置', async () => {
    await store.addConfig({ secid: '1.600519', position: { buyPrice: 1, buyAmount: 1 } });
    await store.addConfig({ secid: '1.600519' });
    expect(store.showPosition('1.600519')).toBe(false);
    expect(store.configs).toEqual({});
  });

  it('deleteSymbolConfig 删除配置', async () => {
    const { writeData } = await import('@/utils/file');
    await store.addConfig({ secid: '1.600519', position: { buyPrice: 1, buyAmount: 1 } });
    writeData.mockClear();
    store.deleteSymbolConfig('1.600519');
    expect(store.configs).toEqual({});
    expect(writeData).toHaveBeenCalledTimes(1);
  });
});
