import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus, { ElMessage } from 'element-plus';
import Group from '@/views/Group.vue';
import { useMonitorStore } from '@/stores/monitor';
import { useCacheStore } from '@/stores/cache';
import { useSymbolStore } from '@/stores/symbol';
import { emit } from '@/utils/events';
import { freshPinia } from '../../helpers';

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => false) }));

vi.mock('@/utils/env', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isTauri: () => isTauriMock() };
});
vi.mock('@/utils/layout', () => ({ applyDragRegion: vi.fn() }));
vi.mock('@/utils/events', () => ({ emit: vi.fn(), on: vi.fn() }));

function mountGroup() {
  freshPinia();
  const monitor = useMonitorStore();
  monitor.watchGroup = [
    { name: '自选', id: 0, symbols: [{ symbol: '600519', name: '贵州茅台', secid: '1.600519' }] },
    {
      name: '行业',
      id: 1,
      symbols: [],
      children: [{ id: 2, name: '白酒', symbols: [{ symbol: '000858', name: '五粮液', secid: '0.000858' }] }],
    },
  ];
  const cache = useCacheStore();
  const persist = vi.spyOn(monitor, 'persist').mockImplementation(() => {});
  const wrapper = mount(Group, { global: { plugins: [ElementPlus] } });
  return { wrapper, monitor, cache, persist };
}

describe('Group 页面 · 分组编辑窗口', () => {
  let ctx;

  beforeEach(() => {
    isTauriMock.mockReturnValue(false);
    ctx = mountGroup();
  });

  it('加载时把旧数据补齐为两级结构', () => {
    const { cache } = ctx;
    expect(cache.group).toHaveLength(2);
    // 旧分组没有 children 字段
    expect(cache.group[0].children).toEqual([]);
    expect(cache.group[0].id_str).toBe('0');
    expect(cache.group[1].children[0]).toMatchObject({
      name: '白酒',
      id_str: '2',
    });
    expect(cache.selectGroup).toBe(0);
  });

  it('默认选中「自选」，且草稿是独立深拷贝', () => {
    const { cache, monitor } = ctx;
    cache.group[0].name = '改名测试';
    expect(monitor.watchGroup[0].name).toBe('自选');
  });

  it('保存把草稿写回 monitor 并持久化', async () => {
    const { wrapper, cache, monitor, persist } = ctx;
    cache.group.push({
      name: '板块',
      id: 3,
      id_str: '3',
      symbols: [],
      children: [],
    });
    await wrapper.find('.save-button').trigger('click');
    expect(monitor.watchGroup).toBe(cache.group);
    expect(monitor.watchGroup.at(-1).name).toBe('板块');
    expect(persist).toHaveBeenCalledWith('addWatchList');
  });

  it('底部提示与关闭按钮存在', () => {
    const { wrapper } = ctx;
    expect(wrapper.find('.tips-text').text()).toContain('调整概念顺序');
    expect(wrapper.find('#titlebar-close').exists()).toBe(true);
  });

  it('保存成功后清理已从自选删除的提醒/持仓配置', async () => {
    const { wrapper, cache, persist } = ctx;
    const symbol = useSymbolStore();
    const del = vi.spyOn(symbol, 'deleteSymbolConfig').mockImplementation(() => {});
    cache.group[0].symbols = [];
    cache.removedWatchSecids = ['1.600519'];
    persist.mockResolvedValueOnce({ removed_stocks: 1 });

    await wrapper.find('.save-button').trigger('click');
    await flushPromises();

    expect(del).toHaveBeenCalledWith('1.600519');
    expect(cache.removedWatchSecids).toEqual([]);
  });

  it('保存前重新加回自选的股票不清理配置', async () => {
    const { wrapper, cache, persist } = ctx;
    const symbol = useSymbolStore();
    const del = vi.spyOn(symbol, 'deleteSymbolConfig').mockImplementation(() => {});
    cache.removedWatchSecids = ['1.600519'];
    persist.mockResolvedValueOnce({ removed_stocks: 1 });

    await wrapper.find('.save-button').trigger('click');
    await flushPromises();

    expect(del).not.toHaveBeenCalled();
    expect(cache.removedWatchSecids).toEqual([]);
  });

  it('保存落库失败时回滚快照、提示错误且保留待清理记录', async () => {
    const { wrapper, cache, monitor, persist } = ctx;
    const error = vi.spyOn(ElMessage, 'error').mockImplementation(() => {});
    isTauriMock.mockReturnValue(true);
    cache.group[0].symbols = [];
    cache.removedWatchSecids = ['1.600519'];
    persist.mockResolvedValueOnce(null);

    await wrapper.find('.save-button').trigger('click');
    await flushPromises();

    expect(error).toHaveBeenCalled();
    // persist 被替身后不会广播，这条事件只能来自失败后的回滚广播
    expect(emit).toHaveBeenCalledWith('stateChange', 'rollbackWatchList');
    expect(monitor.watchGroup).not.toBe(cache.group);
    expect(monitor.watchGroup[0].symbols.map((s) => s.secid)).toEqual(['1.600519']);
    // 失败时不能清空待清理记录，否则重试保存就没机会删配置
    expect(cache.removedWatchSecids).toEqual(['1.600519']);
  });
});
