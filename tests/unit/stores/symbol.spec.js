import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSymbolStore } from '@/stores/symbol';
import { freshPinia } from '../../helpers';

vi.mock('@/utils/events', () => ({ emit: vi.fn(), on: vi.fn() }));

vi.mock('@/utils/db', () => ({
  loadSymbolConfigs: vi.fn(async () => ({})),
  saveSymbolConfigs: vi.fn(async () => ({ saved: true })),
}));

describe('symbol store · 持仓与提醒配置', () => {
  let store;

  beforeEach(() => {
    freshPinia();
    store = useSymbolStore();
  });

  it('初始为空', () => {
    expect(store.configs).toEqual({});
    expect(store.positionNum()).toBe(0);
    expect(store.alertNum()).toBe(0);
  });

  it('loadFromDb 从数据库整体回填，空库即空配置', async () => {
    const { loadSymbolConfigs } = await import('@/utils/db');
    loadSymbolConfigs.mockResolvedValueOnce({
      '1.600519': { secid: '1.600519', position: { buyPrice: 100, buyAmount: 10 } },
    });
    await store.loadFromDb();
    expect(store.showPosition('1.600519')).toBe(true);

    loadSymbolConfigs.mockResolvedValueOnce({});
    await store.loadFromDb();
    expect(store.configs).toEqual({});
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
    const { saveSymbolConfigs } = await import('@/utils/db');
    const config = { secid: '1.600519', crossAlertConfig: { price: 10 } };
    await store.addConfig(config);
    saveSymbolConfigs.mockClear();
    await store.addConfig({ ...config });
    expect(saveSymbolConfigs).not.toHaveBeenCalled();
    expect(store.alertNum()).toBe(1);
  });

  it('addConfig 传空配置（无持仓/提醒）会删除已有配置', async () => {
    await store.addConfig({ secid: '1.600519', position: { buyPrice: 1, buyAmount: 1 } });
    await store.addConfig({ secid: '1.600519' });
    expect(store.showPosition('1.600519')).toBe(false);
    expect(store.configs).toEqual({});
  });

  it('deleteSymbolConfig 删除配置', async () => {
    const { saveSymbolConfigs } = await import('@/utils/db');
    const { emit } = await import('@/utils/events');
    await store.addConfig({ secid: '1.600519', position: { buyPrice: 1, buyAmount: 1 } });
    saveSymbolConfigs.mockClear();
    emit.mockClear();
    await store.deleteSymbolConfig('1.600519');
    expect(store.configs).toEqual({});
    expect(saveSymbolConfigs).toHaveBeenCalledTimes(1);
    expect(saveSymbolConfigs.mock.calls[0][0]).toEqual({});
    // 其他窗口需要收到广播才能刷新提醒/持仓图标
    expect(emit).toHaveBeenCalledWith('symbolConfigChange', {});
  });
});
