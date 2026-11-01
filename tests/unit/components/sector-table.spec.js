import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import SectorTable from '@/components/monitor/SectorTable.vue';
import { useMonitorStore } from '@/stores/monitor';
import { useSettingStore } from '@/stores/setting';
import { freshPinia } from '../../helpers';

const { loadBoardListMock } = vi.hoisted(() => ({ loadBoardListMock: vi.fn() }));

vi.mock('@/api/eastmoney', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    EastmoneyApi: class {
      async realtime() {
        return [];
      }
    },
  };
});

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
    members: ['1.600000', '1.600036'],
    macd: 4,
  },
  {
    board_key: 'sw2:半导体',
    name: '半导体',
    level: 2,
    parent_key: 'sw1:电子',
    members: ['1.600000'],
    macd: -2,
  },
  {
    board_key: 'sw2:消费电子',
    name: '消费电子',
    level: 2,
    parent_key: 'sw1:电子',
    members: ['1.600036'],
    macd: 1,
  },
  {
    board_key: 'sw1:医药',
    name: '医药',
    level: 1,
    parent_key: null,
    members: ['0.000858'],
    macd: null,
  },
];

const THS_BOARDS = [
  {
    board_key: 'ths_hy:881101',
    name: '种植业',
    level: 1,
    parent_key: null,
    members: ['0.000858'],
    macd: 3,
  },
  {
    board_key: 'ths_hy:881102',
    name: '养殖业',
    level: 1,
    parent_key: null,
    members: ['1.600036'],
    macd: -1,
  },
];

const wrappers = [];

async function mountTable() {
  freshPinia();
  const monitor = useMonitorStore();
  const setting = useSettingStore();
  setting.$persist = () => {};
  monitor.watchGroup = [
    { id: 0, id_str: '0', name: '自选', symbols: [] },
    { id: 1, id_str: '1', name: '行业', symbols: [], children: [] },
  ];
  loadBoardListMock.mockImplementation(async (scope) =>
    scope === 'sw' ? SW_BOARDS : THS_BOARDS,
  );
  const wrapper = mount(SectorTable, { global: { plugins: [ElementPlus] } });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper };
}

afterEach(async () => {
  // ElTable 的数据变更会排一个防抖布局任务，等它跑完再卸载，避免测试环境销毁后触发 rAF 报错
  await new Promise((resolve) => setTimeout(resolve, 80));
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

function tableData(wrapper) {
  return wrapper.findComponent({ name: 'ElTable' }).props('data');
}

function names(wrapper) {
  return tableData(wrapper).map((row) => row.name);
}

function clickBoard(wrapper, name) {
  const row = tableData(wrapper).find((r) => r.name === name);
  wrapper.vm.onRowClick(row);
}

describe('SectorTable · 板块列表', () => {
  it('默认申万板块只展示一级板块，二级收缩', async () => {
    const { wrapper } = await mountTable();
    expect(wrapper.findAll('.sector-tab')[0].classes()).toContain('active');
    expect(names(wrapper)).toEqual(['电子', '医药']);
  });

  it('点击一级板块展开二级，再点一次收起', async () => {
    const { wrapper } = await mountTable();
    clickBoard(wrapper, '电子');
    await nextTick();
    expect(names(wrapper)).toEqual(['电子', '半导体', '消费电子', '医药']);

    clickBoard(wrapper, '电子');
    await nextTick();
    expect(names(wrapper)).toEqual(['电子', '医药']);
  });

  it('有且只能同时展开一个一级板块', async () => {
    const { wrapper } = await mountTable();
    clickBoard(wrapper, '医药');
    await nextTick();
    clickBoard(wrapper, '电子');
    await nextTick();
    expect(names(wrapper)).toEqual(['电子', '半导体', '消费电子', '医药']);
  });

  it('切换到同花顺板块展示平铺列表', async () => {
    const { wrapper } = await mountTable();
    await wrapper.findAll('.sector-tab')[1].trigger('click');
    await flushPromises();
    expect(names(wrapper)).toEqual(['种植业', '养殖业']);
    expect(tableData(wrapper).every((row) => !row.hasChildren)).toBe(true);
    expect(loadBoardListMock).toHaveBeenLastCalledWith('ths');
  });

  it('涨跌幅与换手率取成分股实时行情的等权平均', async () => {
    const { wrapper } = await mountTable();
    wrapper.vm.quotes = [
      { secid: '1.600000', range: 1.5, turn: 2.0 },
      { secid: '1.600036', range: 2.5, turn: 4.0 },
    ];
    await nextTick();
    const row = (name) => tableData(wrapper).find((r) => r.name === name);
    expect(row('电子').rangeText).toBe('2.00%');
    expect(row('电子').turnText).toBe('3.00%');

    await wrapper.findAll('.sector-tab')[1].trigger('click');
    await flushPromises();
    expect(row('种植业').rangeText).toBe('-');
  });

  it('MACD 列展示板块指数自身的连击天数，缺数据为 -，并可按数值排序', async () => {
    const { wrapper } = await mountTable();
    const row = (name) => tableData(wrapper).find((r) => r.name === name);
    expect(row('电子').macdText).toBe('4');
    expect(row('医药').macdText).toBe('-');

    wrapper.vm.onSortChange({ prop: 'macd', order: 'descending' });
    await nextTick();
    expect(names(wrapper)).toEqual(['电子', '医药']);

    wrapper.vm.onSortChange({ prop: 'macd', order: 'ascending' });
    await nextTick();
    expect(names(wrapper)).toEqual(['电子', '医药']);

    clickBoard(wrapper, '电子');
    await nextTick();
    expect(row('半导体').macdText).toBe('-2');
  });

  it('切换 tab 后保留的展开项不在新列表里时自动收起', async () => {
    const { wrapper } = await mountTable();
    clickBoard(wrapper, '电子');
    await nextTick();
    expect(wrapper.vm.expandedKey).toBe('sw1:电子');

    await wrapper.findAll('.sector-tab')[1].trigger('click');
    await flushPromises();
    expect(wrapper.vm.expandedKey).toBe(null);
  });
});
