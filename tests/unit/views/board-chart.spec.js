import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import BoardChart from '@/views/BoardChart.vue';
import { useMonitorStore } from '@/stores/monitor';
import { freshPinia, stock } from '../../helpers';

const { query } = vi.hoisted(() => ({ query: { value: {} } }));
const { loadBoardListMock } = vi.hoisted(() => ({ loadBoardListMock: vi.fn() }));

vi.mock('vue-router', () => ({ useRoute: () => ({ query: query.value }) }));
vi.mock('@/utils/layout', () => ({ applyDragRegion: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: vi.fn(), minimize: vi.fn(), isMaximized: async () => false }),
}));
vi.mock('@/components/detail/HQKLineChart.vue', () => ({
  default: {
    name: 'HQKLineChart',
    props: ['boardKey', 'name'],
    template: '<div class="chart-stub">{{ boardKey }}|{{ name }}</div>',
  },
}));
vi.mock('@/utils/db', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadBoardList: loadBoardListMock };
});

const SW_BOARDS = [
  {
    board_key: 'sw1:电子',
    name: '电子',
    level: 1,
    parent_key: null,
    members: [],
    macd: null,
  },
  {
    board_key: 'sw2:半导体',
    name: '半导体',
    level: 2,
    parent_key: 'sw1:电子',
    members: [],
    macd: null,
  },
  {
    board_key: 'sw1:医药',
    name: '医药',
    level: 1,
    parent_key: null,
    members: [],
    macd: null,
  },
];

const THS_BOARDS = [
  { board_key: 'ths_hy:881101', name: '种植业', level: 1, parent_key: null, members: [], macd: null },
  { board_key: 'ths_hy:881102', name: '养殖业', level: 1, parent_key: null, members: [], macd: null },
];

const wrappers = [];

async function mountChart(kind, watchGroup = null) {
  query.value = kind ? { kind } : {};
  freshPinia();
  const monitor = useMonitorStore();
  monitor.watchGroup = watchGroup || [
    { id: 0, id_str: '0', name: '自选', symbols: [stock('600519', '贵州茅台')] },
    {
      id: 1,
      id_str: '1',
      name: '行业',
      symbols: [],
      children: [{ id: 2, id_str: '2', name: '白酒', symbols: [stock('000858', '五粮液', '0.000858')] }],
    },
  ];
  loadBoardListMock.mockImplementation(async (scope) =>
    scope === 'sw' ? SW_BOARDS : THS_BOARDS,
  );
  const wrapper = mount(BoardChart, { global: { plugins: [ElementPlus] } });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, monitor };
}

beforeEach(() => {
  loadBoardListMock.mockClear();
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

function menuNames(wrapper) {
  return wrapper.findAll('.menu-item').map((item) => item.find('.menu-name').text());
}

describe('BoardChart · 板块/概念图表页', () => {
  it('板块默认同花顺板块，平铺展示并默认选中第一项', async () => {
    const { wrapper } = await mountChart('sector');
    expect(loadBoardListMock).toHaveBeenCalledWith('ths');
    expect(menuNames(wrapper)).toEqual(['种植业', '养殖业']);
    expect(wrapper.find('.chart-stub').text()).toBe('ths_hy:881101|种植业');
  });

  it('板块下拉切到申万后只显示一级，二级手动展开', async () => {
    const { wrapper } = await mountChart('sector');
    wrapper.vm.scope = 'sw';
    await wrapper.vm.onScopeChange();
    await flushPromises();
    expect(menuNames(wrapper)).toEqual(['电子', '医药']);
    expect(wrapper.find('.chart-stub').text()).toBe('sw1:电子|电子');

    await wrapper.find('.menu-item .menu-arrow').trigger('click');
    await nextTick();
    expect(menuNames(wrapper)).toEqual(['电子', '半导体', '医药']);
  });

  it('点击一级板块切换右侧图表，展开状态保持不变', async () => {
    const { wrapper } = await mountChart('sector');
    wrapper.vm.scope = 'sw';
    await wrapper.vm.onScopeChange();
    await flushPromises();
    const items = wrapper.findAll('.menu-item');
    await items[1].trigger('click');
    expect(wrapper.find('.chart-stub').text()).toBe('sw1:医药|医药');
  });

  it('概念类型只展示自建概念一级，展开后显示二级', async () => {
    const { wrapper } = await mountChart('concept');
    expect(wrapper.find('.aside-scope').exists()).toBe(false);
    expect(menuNames(wrapper)).toEqual(['行业']);
    expect(wrapper.find('.chart-stub').text()).toBe('self:1|行业');

    await wrapper.find('.menu-item .menu-arrow').trigger('click');
    await nextTick();
    expect(menuNames(wrapper)).toEqual(['行业', '白酒']);
  });

  it('点击二级概念切换右侧图表', async () => {
    const { wrapper } = await mountChart('concept');
    await wrapper.find('.menu-item .menu-arrow').trigger('click');
    await nextTick();
    await wrapper.findAll('.menu-item')[1].trigger('click');
    expect(wrapper.find('.chart-stub').text()).toBe('self:2|白酒');
  });

  it('没有可选板块时展示空状态且图表为空', async () => {
    const { wrapper } = await mountChart('sector', []);
    loadBoardListMock.mockImplementation(async () => []);
    await wrapper.vm.onScopeChange();
    await flushPromises();
    expect(wrapper.find('.menu-empty').exists()).toBe(true);
    expect(wrapper.find('.chart-stub').text()).toBe('|');
  });
});
