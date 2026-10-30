import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Group from '@/views/Group.vue';
import { useMonitorStore } from '@/stores/monitor';
import { useCacheStore } from '@/stores/cache';
import { freshPinia } from '../../helpers';

vi.mock('@/utils/layout', () => ({ applyDragRegion: vi.fn() }));
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

function mountGroup() {
  freshPinia();
  const monitor = useMonitorStore();
  monitor.watchGroup = [
    { name: '自选', id: 0, symbols: [{ symbol: '600519', name: '贵州茅台', secid: '1.600519' }] },
    {
      name: '行业',
      id: 1,
      editable: true,
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
    ctx = mountGroup();
  });

  it('加载时把旧数据补齐为两级结构', () => {
    const { cache } = ctx;
    expect(cache.group).toHaveLength(2);
    // 旧分组没有 children 字段
    expect(cache.group[0].children).toEqual([]);
    expect(cache.group[0].id_str).toBe('0');
    expect(cache.group[0].editable).toBe(false);
    expect(cache.group[1].editable).toBe(true);
    expect(cache.group[1].children[0]).toMatchObject({
      name: '白酒',
      id_str: '2',
      editable: true,
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
      editable: true,
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
    expect(wrapper.find('.tips-text').text()).toContain('可拖动分组或股票进行排序');
    expect(wrapper.find('#titlebar-close').exists()).toBe(true);
  });
});
