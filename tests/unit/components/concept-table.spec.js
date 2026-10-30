import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import ConceptTable from '@/components/monitor/ConceptTable.vue';
import { useMonitorStore } from '@/stores/monitor';
import { useSettingStore } from '@/stores/setting';
import { useMacdStore } from '@/stores/macd';
import { freshPinia, stock } from '../../helpers';

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

vi.mock('@/utils/kline', () => ({
  fetchKline: async () => null,
}));

function mountTable() {
  freshPinia();
  const monitor = useMonitorStore();
  const setting = useSettingStore();
  setting.$persist = () => {};
  monitor.watchGroup = [
    { id: 0, id_str: '0', name: '自选', symbols: [stock('600519', '贵州茅台')] },
    {
      id: 1,
      id_str: '1',
      name: '行业',
      symbols: [],
      children: [
        { id: 2, id_str: '2', name: '白酒', symbols: [stock('000858', '五粮液', '0.000858'), stock('600036', '招商银行')] },
        { id: 3, id_str: '3', name: '啤酒', symbols: [stock('600600', '青岛啤酒')] },
      ],
    },
    {
      id: 4,
      id_str: '4',
      name: '板块',
      symbols: [],
      children: [{ id: 5, id_str: '5', name: '水泥', symbols: [stock('600585', '海螺水泥')] }],
    },
  ];
  const wrapper = mount(ConceptTable, { global: { plugins: [ElementPlus] } });
  return { wrapper, monitor, setting };
}

function names(wrapper) {
  const table = wrapper.findComponent({ name: 'ElTable' });
  return table.props('data').map((row) => row.name);
}

function clickConcept(wrapper, name) {
  const table = wrapper.findComponent({ name: 'ElTable' });
  const row = table.props('data').find((r) => r.name === name);
  wrapper.vm.onRowClick(row);
}

describe('ConceptTable · 概念列表', () => {
  it('默认只展示一级概念，二级概念全部收缩', () => {
    const { wrapper } = mountTable();
    expect(names(wrapper)).toEqual(['自选', '行业', '板块']);
  });

  it('点击一级概念展开其二级概念，再点一次收起', async () => {
    const { wrapper } = mountTable();
    clickConcept(wrapper, '行业');
    await nextTick();
    expect(names(wrapper)).toEqual(['自选', '行业', '白酒', '啤酒', '板块']);

    clickConcept(wrapper, '行业');
    await nextTick();
    expect(names(wrapper)).toEqual(['自选', '行业', '板块']);
  });

  it('有且只能同时展开一个一级概念', async () => {
    const { wrapper } = mountTable();
    clickConcept(wrapper, '行业');
    await nextTick();
    clickConcept(wrapper, '板块');
    await nextTick();
    expect(names(wrapper)).toEqual(['自选', '行业', '板块', '水泥']);
  });

  it('一级概念展示其下所有二级概念股票的平均涨跌幅与平均换手率', async () => {
    const { wrapper } = mountTable();
    await flushPromises();
    wrapper.vm.quotes = [
      { secid: '0.000858', range: 1.23, turn: 3.45 },
      { secid: '1.600036', range: 2.34, turn: 4.55 },
      { secid: '1.600600', range: 0.5, turn: 2.0 },
    ];
    await nextTick();
    const table = wrapper.findComponent({ name: 'ElTable' });
    const industry = table.props('data').find((row) => row.name === '行业');
    expect(industry.rangeText).toBe('1.36%');
    expect(industry.turnText).toBe('3.33%');

    clickConcept(wrapper, '行业');
    await nextTick();
    const baijiu = table.props('data').find((row) => row.name === '白酒');
    expect(baijiu.isChild).toBe(true);
    expect(baijiu.rangeText).toBe('1.78%');
    expect(baijiu.turnText).toBe('4.00%');
  });

  it('排序时自选固定第一位，其余一级概念按数值排序，二级随所属一级概念', async () => {
    const { wrapper } = mountTable();
    await flushPromises();
    wrapper.vm.quotes = [
      { secid: '1.600519', range: 0.1, turn: 1 },
      { secid: '0.000858', range: 1.23, turn: 2 },
      { secid: '1.600036', range: 2.34, turn: 3 },
      { secid: '1.600600', range: 0.5, turn: 4 },
      { secid: '1.600585', range: 3.0, turn: 5 },
    ];
    await nextTick();

    wrapper.vm.onSortChange({ prop: 'range', order: 'descending' });
    await nextTick();
    expect(names(wrapper)).toEqual(['自选', '板块', '行业']);

    clickConcept(wrapper, '行业');
    await nextTick();
    expect(names(wrapper)).toEqual(['自选', '板块', '行业', '白酒', '啤酒']);

    wrapper.vm.onSortChange({ prop: 'range', order: 'ascending' });
    await nextTick();
    expect(names(wrapper)).toEqual(['自选', '行业', '白酒', '啤酒', '板块']);

    wrapper.vm.onSortChange({ prop: 'range', order: null });
    await nextTick();
    expect(names(wrapper)).toEqual(['自选', '行业', '白酒', '啤酒', '板块']);
  });

  it('MACD 列按成分股每日平均柱的连续天数展示，并可排序', async () => {
    const { wrapper } = mountTable();
    await flushPromises();
    const macd = useMacdStore();
    const days = (values) =>
      values.map((value, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, value }));
    macd.series = {
      // 自选 +1
      '1.600519': days([1]),
      // 白酒两只都是 -1 → -2；啤酒两只 -1 → 行业 -2
      '0.000858': days([-1, -1]),
      '1.600036': days([-1, -1]),
      '1.600600': days([-1, -1]),
      // 水泥 +2 → 板块 +2
      '1.600585': days([1, 1]),
    };
    await nextTick();

    const table = wrapper.findComponent({ name: 'ElTable' });
    const row = (name) => table.props('data').find((r) => r.name === name);
    expect(row('自选').macdText).toBe('1');
    expect(row('行业').macdText).toBe('-2');
    expect(row('板块').macdText).toBe('2');

    clickConcept(wrapper, '行业');
    await nextTick();
    expect(row('白酒').macdText).toBe('-2');

    wrapper.vm.onSortChange({ prop: 'macd', order: 'descending' });
    await nextTick();
    expect(names(wrapper)).toEqual(['自选', '板块', '行业', '白酒', '啤酒']);
  });

  it('没有行情时平均值显示 -', () => {
    const { wrapper } = mountTable();
    const table = wrapper.findComponent({ name: 'ElTable' });
    expect(table.props('data')[0].rangeText).toBe('-');
    expect(table.props('data')[0].turnText).toBe('-');
    expect(table.props('data')[0].macdText).toBe('-');
  });
});
